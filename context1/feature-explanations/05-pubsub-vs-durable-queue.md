# Why We Replaced Pub/Sub with a Durable Queue for Notifications

## The first version (what was wrong)

The first implementation used **Redis pub/sub** for notifications. When a monitor
went down, the worker published an event to a Redis channel, and consumers
(email, Slack) subscribed to that channel and reacted.

```
Worker → publish("monitor.down") → Redis pub/sub channel
                                        ↓
                              Email consumer (listening)
                              Slack consumer (listening)
```

This is called **fire-and-forget**: the publisher sends the message and moves on.
If no one is listening, the message is gone. There is no queue, no retry, no
record that the message ever existed.

## Three problems we discovered

### 1. Lost notifications

The most serious one. Here's the timeline that breaks:

```
1. Worker runs a check → site is down
2. Worker starts a transaction:
   - Writes check_log to Postgres     ✓
   - Sets is_alerted = true           ✓
   - Transaction commits              ✓
3. Worker calls publish("monitor.down") → CRASH (or Redis blip)
```

The database says "this monitor is alerted." But the email was never sent. The
user's site is down and they have no idea. The `is_alerted` flag is already
`true`, so the next check won't trigger a new alert — the system thinks it
already notified the user.

For a monitoring tool, this is the worst possible failure: **silently not
alerting when alerting is your one job.**

### 2. No retry on send failure

```
Worker → publish("monitor.down") → Redis channel → Email consumer
                                                       ↓
                                              sendEmail() → SMTP is down
                                                       ↓
                                              catch(err) → console.error("Email consumer error")
                                                       ↓
                                              (notification gone forever)
```

The old code caught SMTP errors and logged them. That's it. The email was never
retried. If the SMTP server was down for 30 seconds, every notification during
that window was lost.

Same for Slack — if the webhook returned 500, the consumer logged it and moved
on.

### 3. The spec contradicted itself

The spec said: *"The event carries everything a consumer needs — no consumer
queries the database."*

But both consumers immediately did:
```js
const user = await findUserById(event.userId);  // ← database query
```

This wasn't just inconsistent documentation — it revealed a design tension.
The event should ideally be self-contained, but the user's email and Slack URL
can change between when the event is created and when it's processed. Querying
at processing time gets the current value, which is correct.

## The fix: a durable BullMQ notification queue

```
Worker → notificationQueue.add("monitor.down", data) → BullMQ (Redis)
                                                            ↓
                                                  Notification worker picks up job
                                                            ↓
                                                  sendEmail() → fails? → BullMQ retries
                                                  sendSlack() → fails? → BullMQ retries
                                                            ↓
                                                  After 5 attempts → dead-letter set
```

### What changed and why

| Problem | Pub/sub (old) | Durable queue (new) |
|---|---|---|
| Worker crashes after DB commit | Notification lost forever | Job was enqueued before crash (durable in Redis) — or if enqueue also failed, `is_alerted` is set so state is correct |
| SMTP is down | Error caught and swallowed | BullMQ retries with exponential backoff (2s, 4s, 8s, 16s, 32s) |
| Slack returns 500 | Error caught and swallowed | Same retry logic |
| Persistent failure | Silent data loss | Job lands in dead-letter set — visible, inspectable, can be retried manually |
| Zero new infrastructure | ✓ (Redis pub/sub is free) | ✓ (BullMQ is already installed and running for check jobs) |

### The code change was small

Old (pub/sub):
```js
// checks.service.js — fire and forget
await publishEvent({ type: 'monitor.down', ... });
```

New (durable queue):
```js
// checks.service.js — durable enqueue
await notificationQueue.add('monitor.down', { type: 'monitor.down', ... });
```

Old consumers:
```js
// Swallowed errors — notification lost
try {
  await sendEmail(...);
} catch (err) {
  console.error('Email consumer error:', err.message);
}
```

New consumers:
```js
// Let errors propagate — BullMQ retries
await sendEmail(...);  // throws on failure → BullMQ schedules retry
```

### What stays the same

- **Decoupling**: the check worker still doesn't import email or Slack. It
  enqueues a generic notification job. Invariant 9 preserved.
- **Fan-out**: one notification job → email + Slack. Adding Discord means
  adding one function call in the notification worker.
- **The event shape**: same `{ type, monitorId, userId, monitorName, ... }`.

## The lesson

**Pub/sub is for notifications you can afford to lose.** Live dashboard updates,
activity feeds, presence indicators — if one is missed, the next one comes in
seconds and the user never notices.

**A durable queue is for notifications you cannot afford to lose.** Alerts,
billing events, order confirmations — if one is missed, the user is harmed.

The question isn't "are my consumers running?" It's **"what happens if sending
fails?"** If the answer is "the user never knows their site is down," you need
durability. We had BullMQ already — using pub/sub instead was choosing a weaker
tool when a stronger one was free.
