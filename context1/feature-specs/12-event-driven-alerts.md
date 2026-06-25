# 12 — Event-Driven Alerting Fan-Out (Phase 3)

> System-design phase 3 of `system-design-roadmap.md`. This spec makes the app
> actually **tell the user** when their site goes down. The worker enqueues a
> notification job on a durable BullMQ queue; independent consumer processors
> send email and Slack. Read `architecture.md` invariant 9 before starting:
> workers never call notification channels directly.

## What this covers

Right now `processCheck` detects a status transition (up→down or down→up) and
sets the `is_alerted` flag in the database. But **nothing happens after that** —
no email, no Slack, no notification of any kind. The user has no idea their site
is down unless they're staring at the dashboard.

This spec adds:

1. A **durable notification queue** (BullMQ) — when the worker detects a state
   transition, it enqueues a notification job. The job is durable: if the worker
   crashes between the DB commit and the enqueue, BullMQ retries it; if sending
   fails, the job retries with backoff; if it keeps failing, it lands in the
   dead-letter set instead of disappearing.
2. A **notification worker** — consumes the notification queue and fans out to
   all channels: email and Slack. Adding a third channel means adding a function
   call inside this one processor — the check worker is never touched.
3. An **email sender** — looks up the user's email and sends via nodemailer.
4. A **Slack sender** — looks up the user's Slack webhook URL and POSTs.

The check worker doesn't know or care what notification channels exist. It
enqueues a notification job. That's invariant 9.

### Why durable queue, not pub/sub

The first version of this spec used Redis pub/sub (fire-and-forget). That was
wrong for three reasons:

1. **Lost notifications.** If the worker crashes between committing
   `is_alerted = true` and publishing the event, the notification vanishes. For
   an uptime monitor — whose entire purpose is telling you when things break —
   losing a down notification is a critical failure.
2. **No retry on send failure.** If the SMTP server is down or Slack returns 500,
   pub/sub swallows the error. The notification is gone. A durable queue retries
   with backoff automatically.
3. **We already have BullMQ.** Adding a second queue is zero new infrastructure.
   We get retries, backoff, dead-letter, and concurrency control for free.

The fan-out concept (one event → many consumers) is still learned. We just
learn it correctly — with durability.

### What this teaches

- Decoupling producers from consumers (the check worker enqueues, the
  notification worker processes — invariant 9)
- Fan-out (one notification job → email + Slack + future channels)
- Durable event delivery vs fire-and-forget pub/sub (and why it matters)
- Retry with backoff on transient failures (SMTP down, Slack 500)
- Dead-letter for persistent failures (wrong email, revoked webhook)

---

## Existing state this spec builds on

**Backend has:**
- `services/checks.service.js` — `processCheck(monitor, jobId)` detects
  transitions via the state machine:
  - `is_alerted` goes from `false` to `true` → threshold crossed (down)
  - `is_alerted` goes from `true` to `false` → recovered
- `queue/connection.js` — shared ioredis connection for BullMQ
- `queue/checkQueue.js` — existing BullMQ queue pattern to follow
- `worker.js` — the worker process entrypoint
- `db/schema.js` — `users` table has `email`; `slack_webhook_url` column
  already added (migration `1750000000003`)
- `db/users.queries.js` — `findUserById(userId)` returns `email` and
  `slack_webhook_url`
- Job payload includes: `monitorId`, `userId`, `monitorName`, `url`,
  `failureThreshold`, `consecutiveFailures`, `isAlerted`

**Already done (kept from v1 of this spec):**
- Migration `1750000000003` (slack_webhook_url) — already applied
- `db/users.queries.js` — already created
- `checks.queries.js` — already returns `m.name` from claimDueMonitors
- `dispatcher.js` — already includes `monitorName` in job payload
- `nodemailer` — already installed
- `.env` — already has SMTP vars

---

## Files to rewrite

### 1. `events/eventBus.js` → **delete entirely**

Redis pub/sub is replaced by a BullMQ queue. This file is no longer needed.

### 2. `queue/notificationQueue.js` — the durable notification queue (new)

```js
import { Queue } from 'bullmq';
import { connection } from './connection.js';

export const NOTIFICATION_QUEUE_NAME = 'notifications';

export const notificationQueue = new Queue(NOTIFICATION_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 5000 },
  },
});
```

Same pattern as `checkQueue.js`. 5 attempts with exponential backoff (2s, 4s,
8s, 16s, 32s) — email/Slack transient failures get multiple chances. Failed
jobs stay in the dead-letter set for inspection.

### 3. `queue/notificationWorker.js` — the consumer (new)

```js
import { Worker } from 'bullmq';
import { connection } from './connection.js';
import { NOTIFICATION_QUEUE_NAME } from './notificationQueue.js';
import { sendEmailNotification } from '../events/consumers/emailConsumer.js';
import { sendSlackNotification } from '../events/consumers/slackConsumer.js';

export const createNotificationWorker = () =>
  new Worker(
    NOTIFICATION_QUEUE_NAME,
    async (job) => {
      await sendEmailNotification(job.data);
      await sendSlackNotification(job.data);
    },
    { connection, concurrency: 10 }
  );
```

Concurrency 10 — notifications are I/O-bound (SMTP, HTTP) but not as heavy as
check execution. Fan-out happens inside the processor: email first, then Slack.
Adding a third channel means adding one function call here.

If either sender throws, BullMQ retries the entire job. This means the email
might be sent twice on a Slack-only failure. That's acceptable — a duplicate
"your site is down" email is harmless; a lost one is not. If we needed per-
channel retry isolation, each channel would get its own queue — unjustified
here.

### 4. `events/consumers/emailConsumer.js` — rewrite

Rename the export from `handleEmailEvent` to `sendEmailNotification`. Remove
the try/catch wrapper — let errors propagate to BullMQ so it can retry:

```js
export const sendEmailNotification = async (event) => {
  const user = await findUserById(event.userId);
  if (!user) return;

  if (event.type === 'monitor.down') {
    await sendEmail(user.email, subject, body);
  }
  if (event.type === 'monitor.recovered') {
    await sendEmail(user.email, subject, body);
  }
};
```

No try/catch — if `sendEmail` throws (SMTP down), the error bubbles up to
BullMQ, which marks the job as failed and schedules a retry. The old version
caught the error and silently swallowed it.

### 5. `events/consumers/slackConsumer.js` — rewrite

Rename to `sendSlackNotification`. Remove try/catch. Check response status:

```js
export const sendSlackNotification = async (event) => {
  const user = await findUserById(event.userId);
  if (!user?.slack_webhook_url) return;

  const response = await fetch(user.slack_webhook_url, { ... });
  if (!response.ok) {
    throw new Error(`Slack webhook failed: ${response.status}`);
  }
};
```

Throwing on non-2xx makes BullMQ retry — the old version swallowed Slack errors.

---

## Files to change

### `services/checks.service.js` — enqueue instead of publish

Replace the `setEventPublisher` / `publishEvent` pattern with a direct
import of the notification queue:

```js
import { notificationQueue } from '../queue/notificationQueue.js';
```

After the transaction commits and cache is invalidated:

```js
if (!previouslyAlerted && isAlerted) {
  await notificationQueue.add('monitor.down', {
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
  await notificationQueue.add('monitor.recovered', {
    type: 'monitor.recovered',
    monitorId: monitor.monitorId,
    userId: monitor.userId,
    monitorName: monitor.monitorName,
    url: monitor.url,
    timestamp: new Date().toISOString(),
  });
}
```

No `setEventPublisher` pattern needed — `notificationQueue` is a regular
import. The `add()` call is durable: the job persists in Redis and survives
a crash.

### `worker.js` — replace pub/sub with notification worker

Remove: `createPublisher`, `createSubscriber`, `setEventPublisher`, and the
pub/sub handler.

Add: `createNotificationWorker()` and close it on shutdown.

---

## What this spec does NOT cover

- UI for configuring Slack webhook URL (settings page is a separate spec)
- UI for notification preferences (email on/off, Slack on/off)
- Rate limiting notifications — Phase 5 (backpressure)
- Per-channel retry isolation (separate queues per channel)
- Notification history / audit log
- SMS or other channels beyond email and Slack

---

## Acceptance criteria

1. When a monitor crosses `failure_threshold`, a `monitor.down` notification
   job is enqueued — an email is sent and a Slack message is posted (if webhook
   configured)
2. When a down monitor recovers, a `monitor.recovered` notification job is
   enqueued — recovery email and Slack message are sent
3. No duplicate alerts per incident — only published on the `false→true` /
   `true→false` transition of `is_alerted`
4. The check worker does NOT import email or Slack consumers — it enqueues a
   notification job; the notification worker processes it (invariant 9)
5. If a user has no `slack_webhook_url`, the Slack sender skips silently
6. If SMTP is not configured, the email sender uses Ethereal and logs the
   preview URL
7. If email or Slack sending fails, BullMQ retries with exponential backoff
   (5 attempts). Persistent failures land in the dead-letter set.
8. If the worker crashes between the DB commit and the enqueue, the
   notification job is not lost — it was never enqueued, but `is_alerted` is
   set in Postgres, so the state is correct. (The notification is missed for
   this incident; a future hardening with a transactional outbox would close
   this gap — deliberately refused, not in the forcing-requirement table.)
9. Adding a third notification channel requires adding a sender function and
   one call in `notificationWorker.js` — no changes to `checks.service.js`
