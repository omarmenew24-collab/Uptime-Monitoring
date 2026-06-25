# 12 — Event-Driven Alerting Fan-Out (Phase 3)

> System-design phase 3 of `system-design-roadmap.md`. This spec makes the app
> actually **tell the user** when their site goes down. The worker publishes a
> state-change event; independent consumers subscribe and send email/Slack.
> Read `architecture.md` invariant 9 before starting: workers never call
> notification channels directly.

## What this covers

Right now `processCheck` detects a status transition (up→down or down→up) and
sets the `is_alerted` flag in the database. But **nothing happens after that** —
no email, no Slack, no notification of any kind. The user has no idea their site
is down unless they're staring at the dashboard.

This spec adds:

1. An **event bus** (Redis pub/sub) — when the worker detects a state transition,
   it publishes a `monitor.down` or `monitor.recovered` event instead of directly
   sending notifications.
2. An **email consumer** — subscribes to the event bus, looks up the user's email,
   and sends a downtime/recovery email.
3. A **Slack consumer** — subscribes to the same event bus and sends a
   downtime/recovery message to a Slack webhook URL.

The worker doesn't know or care how many consumers exist. Adding a third channel
(Discord, SMS, whatever) means adding a consumer — the worker is never touched.
That's the fan-out pattern.

### Why this is Phase 3 (requirement 4)

A single down→up transition must reach email AND Slack without the checker
knowing about either channel. Without events, the worker would need to import
the email sender, the Slack sender, and any future sender — coupled to every
channel, edited every time one is added. The event bus decouples them.

### What this teaches

- Pub/sub pattern (publish once, many subscribers)
- Decoupling producers from consumers via events
- Fan-out (one event → many reactions)
- Idempotent consumers (same event delivered twice → one notification)
- The difference between "fire and forget" pub/sub and durable event delivery

---

## Existing state this spec builds on

**Backend has:**
- `services/checks.service.js` — `processCheck(monitor, jobId)` detects
  transitions via the state machine:
  - `is_alerted` goes from `false` to `true` → threshold crossed (down event)
  - `is_alerted` goes from `true` to `false` → recovered (recovery event)
  - Currently: sets the flag in Postgres, does nothing else
- `queue/connection.js` — ioredis connection for BullMQ (`maxRetriesPerRequest:
  null`). Redis pub/sub needs **separate connections** — a subscribed connection
  can't run other commands.
- `worker.js` — the worker process entrypoint; consumers will be started here
- `db/schema.js` — `users` table has `email`; no Slack webhook URL column yet
- Job payload includes: `monitorId`, `userId`, `url`, `failureThreshold`,
  `consecutiveFailures`, `isAlerted`
- Job payload does NOT include: `name` (the monitor's display name — needed for
  notification messages)

**Architecture invariant 9:** Workers never call notification channels directly —
they publish events; consumers react. Adding a channel must not touch the checker.

---

## The event

Two event types, published to a Redis pub/sub channel named `monitor:events`:

**`monitor.down`** — published when `is_alerted` transitions from `false` to `true`

```json
{
  "type": "monitor.down",
  "monitorId": "32996f2a-...",
  "userId": "abc-...",
  "monitorName": "My API",
  "url": "https://api.example.com",
  "consecutiveFailures": 3,
  "failureThreshold": 3,
  "timestamp": "2026-06-25T10:30:00.000Z"
}
```

**`monitor.recovered`** — published when `is_alerted` transitions from `true` to `false`

```json
{
  "type": "monitor.recovered",
  "monitorId": "32996f2a-...",
  "userId": "abc-...",
  "monitorName": "My API",
  "url": "https://api.example.com",
  "timestamp": "2026-06-25T10:45:00.000Z"
}
```

The event carries everything a consumer needs to send a notification — no
consumer queries the database. This keeps consumers stateless and fast.

---

## Pub/Sub vs durable queue — a deliberate choice

Redis pub/sub is **fire-and-forget**: if no one is listening when an event is
published, it's lost. A durable alternative (BullMQ queue per consumer) would
guarantee delivery even if a consumer is temporarily down.

For this spec, pub/sub is the honest choice:
- The consumers run in the same process as the worker (they start and stop
  together) — there is no "consumer is down but publisher is up" scenario
- A missed alert on a restart is acceptable — the next check cycle will
  re-detect the condition if it persists
- Learning pub/sub as a pattern is the goal; durable event streaming (Kafka,
  Redis Streams) is a different concept for a different project

This is documented as a deliberate tradeoff, not an oversight.

---

## Migration — add Slack webhook URL to users

`src/db/migrations/1750000000003_users-slack-webhook.js`

```js
export const up = (pgm) => {
  pgm.addColumn('users', {
    slack_webhook_url: { type: 'varchar', notNull: false },
  });
};

export const down = (pgm) => {
  pgm.dropColumn('users', 'slack_webhook_url');
};
```

Nullable — Slack is optional. If a user hasn't set a webhook URL, the Slack
consumer skips them silently.

---

## Files to create

### 1. `events/eventBus.js` — publish and subscribe helpers

```js
import IORedis from 'ioredis';

const CHANNEL = 'monitor:events';
```

**`createPublisher()`** — returns an ioredis client dedicated to publishing.
One function: `publish(event)` — JSON-stringifies the event and publishes to
the channel.

**`createSubscriber(handler)`** — creates a **new** ioredis connection (pub/sub
requires a dedicated connection), subscribes to the channel, and calls
`handler(event)` for every message received. Returns the subscriber connection
(for cleanup on shutdown).

Both use `process.env.REDIS_URL`.

### 2. `events/consumers/emailConsumer.js` — send downtime/recovery emails

**`handleEmailEvent(event)`**

1. Look up the user's email by `event.userId` (one query: `SELECT email FROM
   users WHERE id = $1`)
2. If `event.type === 'monitor.down'`:
   - Send email: subject = `🔴 ${event.monitorName} is DOWN`
   - Body includes: URL, consecutive failures, threshold, timestamp
3. If `event.type === 'monitor.recovered'`:
   - Send email: subject = `✅ ${event.monitorName} is back UP`
   - Body includes: URL, timestamp

**Email transport:** Use `nodemailer` with a configurable SMTP transport (env
vars: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`). For
development/testing, use Ethereal (free fake SMTP that captures emails without
sending them — `nodemailer.createTestAccount()`).

**Idempotency:** The consumer is naturally idempotent because `is_alerted` is
only set once per incident — the worker won't publish a second `monitor.down`
for the same incident. If a duplicate event somehow arrives (pub/sub doesn't
deduplicate), sending a second identical email is acceptable — it's not
dangerous, just redundant.

### 3. `events/consumers/slackConsumer.js` — send Slack notifications

**`handleSlackEvent(event)`**

1. Look up the user's `slack_webhook_url` by `event.userId` (one query:
   `SELECT slack_webhook_url FROM users WHERE id = $1`)
2. If `slack_webhook_url` is null, skip silently (Slack not configured)
3. If `event.type === 'monitor.down'`:
   - POST to the webhook URL with a Slack message payload:
     `🔴 *${event.monitorName}* is DOWN — ${event.consecutiveFailures}
     consecutive failures`
4. If `event.type === 'monitor.recovered'`:
   - POST to the webhook URL:
     `✅ *${event.monitorName}* is back UP`

**No library needed** — Slack incoming webhooks are a simple HTTP POST with a
JSON body. Use native `fetch`.

### 4. `db/users.queries.js` — user lookup for consumers

```js
export const findUserById = async (userId) => {
  const result = await query(
    'SELECT id, email, slack_webhook_url FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0] ?? null;
};
```

Consumers share this query. Keeps DB access in the `db/` layer per code
standards.

---

## Files to change

### `services/checks.service.js` — publish events on state transitions

The state machine in `processCheck` already detects two transitions:
- `isAlerted` was `false`, now `true` → **down event**
- `isAlerted` was `true`, now `false` → **recovery event**

After the transaction commits (and after cache invalidation), publish the
appropriate event:

```js
const previouslyAlerted = monitor.isAlerted;

// ... existing state machine + transaction ...

if (!previouslyAlerted && isAlerted) {
  await publish({
    type: 'monitor.down',
    monitorId: monitor.monitorId,
    userId: monitor.userId,
    monitorName: monitor.monitorName,
    url: monitor.url,
    consecutiveFailures,
    failureThreshold: monitor.failureThreshold,
    timestamp: new Date().toISOString(),
  });
}

if (previouslyAlerted && !isAlerted) {
  await publish({
    type: 'monitor.recovered',
    monitorId: monitor.monitorId,
    userId: monitor.userId,
    monitorName: monitor.monitorName,
    url: monitor.url,
    timestamp: new Date().toISOString(),
  });
}
```

Publishing happens **after** the transaction commits — if the transaction
rolls back, no event is published. If publishing fails (Redis blip), the
alert flag is still set correctly in Postgres; the user just misses the
notification this cycle.

### `checks.queries.js` — add `name` to claimDueMonitors RETURNING

Add `m.name` to the RETURNING clause so it flows through the dispatcher →
job payload → event. Currently returns `id, user_id, url, failure_threshold,
consecutive_failures, is_alerted`.

### `queue/dispatcher.js` — add `monitorName` to job data

Add `monitorName: monitor.name` to the data object.

### `worker.js` — start event consumers on boot, close on shutdown

```js
import { createPublisher, createSubscriber } from './events/eventBus.js';
import { handleEmailEvent } from './events/consumers/emailConsumer.js';
import { handleSlackEvent } from './events/consumers/slackConsumer.js';

const publisher = createPublisher();
const subscriber = createSubscriber(async (event) => {
  await handleEmailEvent(event);
  await handleSlackEvent(event);
});
```

On shutdown, close the subscriber and publisher connections alongside the
existing cleanup.

Export the publisher so `checks.service.js` can import and use it.

### `.env` / `.env.example` — add SMTP and alert config

```
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=alerts@uptime.example.com
```

For development, leave these empty — the email consumer will use Ethereal
(a free test SMTP service that captures emails without delivering them) and
log the preview URL to the console.

---

## What this spec does NOT cover

- UI for configuring Slack webhook URL per user (can be set directly in the
  database for now; a settings page is a separate spec)
- UI for notification preferences (email on/off, Slack on/off)
- Rate limiting notifications (e.g., max 10 emails per hour) — Phase 5
  (backpressure)
- Durable event delivery (Redis Streams / Kafka) — deliberately refused; pub/sub
  is the honest fit for same-process consumers
- Notification history / audit log
- SMS or other channels beyond email and Slack

---

## Acceptance criteria

1. When a monitor crosses `failure_threshold`, the worker publishes a
   `monitor.down` event — an email is sent to the user and a Slack message is
   posted (if webhook URL is configured)
2. When a down monitor recovers, the worker publishes a `monitor.recovered`
   event — a recovery email and Slack message are sent
3. No duplicate alerts per incident — `monitor.down` is published only on the
   `false→true` transition of `is_alerted`, not on every failed check
4. The worker does NOT import the email or Slack consumer — it publishes an
   event; consumers subscribe independently (invariant 9)
5. If a user has no `slack_webhook_url`, the Slack consumer skips silently
6. If SMTP is not configured, the email consumer uses Ethereal and logs the
   preview URL (development mode)
7. If Redis pub/sub fails, the alert flag is still set in Postgres — the
   notification is missed but the state is correct
8. Adding a third notification channel requires only adding a new consumer
   file and subscribing it in `worker.js` — no changes to `checks.service.js`

---

## After this spec

Add a `learning.md` entry documenting the before→after: direct flag-setting with
no notification (the naive version) vs. event-driven fan-out where the worker
publishes and consumers react independently. Include the pub/sub vs durable
delivery tradeoff and why pub/sub is the honest choice here.

Install dependency: `cd backend && npm install nodemailer`
