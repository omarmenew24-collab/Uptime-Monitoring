# 09 — Extract the Worker + Durable Queue (Phase 1)

> System-design phase 1 of `system-design-roadmap.md`. Read `08-scheduler.md`
> first — this spec turns that in-process cron monolith into a dispatcher + a
> durable BullMQ queue + a separate worker process. The scheduler doc is the
> documented "before"; this is the "after."

## What this covers

Today a single `node-cron` tick inside the API process both **decides** what to
check and **executes** the checks (`checkAllDueMonitors` → `pLimit` fan-out).
That collapses two jobs into one process and breaks the moment you run a second
copy or deploy mid-check.

This spec splits them:

- A **dispatcher** runs every minute, *claims* due monitors, and enqueues one
  check job per monitor onto a durable BullMQ queue. It never runs an HTTP check.
- A **worker process** (separate entrypoint) consumes the queue and executes
  each check, writing the result. Concurrency is owned by the BullMQ worker, not
  `pLimit`. Capacity scales by running more worker processes — no code change.
- Check processing is made **idempotent**, because BullMQ delivers at-least-once.

This spec does NOT add events, caching, rollups, metrics, or send any alert. The
worker still only sets the `is_alerted` flag exactly as `08-scheduler.md` does.

### Why now (the trigger)

Run two copies of the current server, or deploy while a check is in flight:

- Both `node-cron` ticks fire → **every monitor is checked twice**. The
  `isRunning` flag is in-process; it does nothing across processes.
- A monitor checked but not yet written when the process dies is **lost** — there
  is no retry, no record that the work was claimed.

That is the pain Phase 1 removes. (Architecture invariants 6, 7, 8 — see
`architecture.md`.)

---

## Existing state this spec builds on

**Code as built (`08-scheduler.md`):**
- `src/scheduler/index.js` — two `node-cron` jobs: checks every minute, retention at 3 AM
- `src/services/checks.service.js` — `runCheck(url)`, `processCheck(monitor)`, `checkAllDueMonitors()`
- `src/db/checks.queries.js` — `findDueMonitors()`, `insertCheckLog(client, monitorId, checkResult)`, `updateMonitorAfterCheck(client, monitorId, updates)`
- `src/db/retention.queries.js` — `deleteExpiredCheckLogs()`
- `src/config/db.js` — `pool`, `query`, `withTransaction`
- `src/server.js` — `import './scheduler/index.js'` starts the cron in-process
- `monitors` columns: `interval_minutes`, `failure_threshold`, `consecutive_failures`, `is_alerted`, `last_status`, `last_checked_at`, `next_check_at`, `is_active`, `is_deleted`, `updated_at`
- `check_logs` columns: `monitor_id`, `status`, `response_code`, `response_time_ms`, `message`, `checked_at`
- Partial index `monitors_next_check_at_idx ON monitors(next_check_at) WHERE is_active = true AND is_deleted = false`

**Ownership change introduced here:** `next_check_at` is now advanced by the
**dispatcher at claim time**, not by the worker after the check. The worker no
longer touches `next_check_at`. This is what stops a monitor being enqueued
twice in back-to-back ticks, and it is safe precisely because BullMQ — not the
schedule column — now owns retry of unfinished work.

**Code standards that apply:** business logic stays in services; all SQL through
`db/`; transactions for multi-table writes; `async/await` only; ES modules; no
`console.log` (use `console.error` for errors until the logger spec lands).

---

## Dependencies

```
cd backend && npm install bullmq ioredis
```

- **BullMQ** — durable job queue on Redis: retries, exponential backoff,
  dead-letter (the `failed` set), concurrency, graceful drain — out of the box.
- **ioredis** — the Redis client BullMQ requires.

`p-limit` is no longer used (worker concurrency replaces it) — remove the import
from `checks.service.js`; it can be dropped from `package.json`. `node-cron`
stays (it drives the dispatcher tick and retention).

Add to `.env` and `.env.example`:

```
REDIS_URL=redis://localhost:6379
WORKER_CONCURRENCY=50
```

---

## Redis is not a source of truth

Per invariant 8: Redis here is the queue transport only. Postgres remains
authoritative — `monitors.next_check_at` is the schedule, `check_logs` is the
record. If Redis is down, the API still serves CRUD; only dispatch/execution
pauses until Redis returns. Nothing durable lives solely in Redis.

---

## Migration — idempotency key on check_logs

New migration file (never edit an existing one — `ai-workflow-rules.md`):

`src/db/migrations/1750000000002_check-logs-job-id.js`

```js
export const up = (pgm) => {
  pgm.addColumn('check_logs', {
    job_id: { type: 'varchar', notNull: false },
  });
  pgm.addConstraint('check_logs', 'check_logs_job_id_unique', 'UNIQUE(job_id)');
};

export const down = (pgm) => {
  pgm.dropConstraint('check_logs', 'check_logs_job_id_unique');
  pgm.dropColumn('check_logs', 'job_id');
};
```

`job_id` is nullable on purpose: existing rows keep `NULL`, and Postgres treats
`NULL`s as distinct, so the unique constraint only deduplicates real job IDs.
This column is how a retried job avoids writing a second log row.

Run it: `npm run migrate`.

---

## Files to create

### 1. `src/queue/connection.js` — shared Redis connection

```js
import IORedis from 'ioredis';

export const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null, // required by BullMQ workers
});
```

### 2. `src/queue/checkQueue.js` — the queue (producer side)

```js
import { Queue } from 'bullmq';
import { connection } from './connection.js';

export const CHECK_QUEUE_NAME = 'checks';

export const checkQueue = new Queue(CHECK_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 }, // failed jobs stay = the dead-letter set
  },
});
```

`attempts` + `backoff` give automatic retry of a crashed check. Failed jobs are
retained (not removed) so you can inspect the dead-letter set.

### 3. `src/queue/dispatcher.js` — claim due monitors, enqueue jobs

```js
import { claimDueMonitors } from '../db/checks.queries.js';
import { checkQueue } from './checkQueue.js';

const DISPATCH_BATCH = 500;

export const dispatchDueChecks = async () => {
  const monitors = await claimDueMonitors(DISPATCH_BATCH);
  if (monitors.length === 0) return 0;

  const minuteBucket = Math.floor(Date.now() / 60_000);

  await checkQueue.addBulk(
    monitors.map((monitor) => ({
      name: 'check',
      data: {
        monitorId: monitor.id,
        url: monitor.url,
        failureThreshold: monitor.failure_threshold,
        consecutiveFailures: monitor.consecutive_failures,
        isAlerted: monitor.is_alerted,
      },
      opts: { jobId: `${monitor.id}:${minuteBucket}` },
    }))
  );

  return monitors.length;
};
```

The `jobId` (`monitorId:minuteBucket`) makes **enqueue idempotent**: if two
dispatcher ticks race in the same minute, BullMQ ignores the duplicate add. The
monitor state snapshot rides in `data` — the worker uses it directly, so the
worker never re-queries the monitor.

### 4. `src/queue/checkWorker.js` — the consumer

```js
import { Worker } from 'bullmq';
import { connection } from './connection.js';
import { CHECK_QUEUE_NAME } from './checkQueue.js';
import { processCheck } from '../services/checks.service.js';

const concurrency = Number(process.env.WORKER_CONCURRENCY) || 50;

export const createCheckWorker = () =>
  new Worker(
    CHECK_QUEUE_NAME,
    async (job) => {
      await processCheck(job.data, job.id);
    },
    { connection, concurrency }
  );
```

`concurrency` replaces `pLimit(50)`. To process more in parallel, raise it or
run another worker process — same code.

### 5. `src/worker.js` — the worker entrypoint (new deployable)

```js
import 'dotenv/config';
import cron from 'node-cron';
import pool from './config/db.js';
import { connection } from './queue/connection.js';
import { checkQueue } from './queue/checkQueue.js';
import { createCheckWorker } from './queue/checkWorker.js';
import { dispatchDueChecks } from './queue/dispatcher.js';
import { deleteExpiredCheckLogs } from './db/retention.queries.js';

const worker = createCheckWorker();

const dispatchTask = cron.schedule('* * * * *', async () => {
  try {
    await dispatchDueChecks();
  } catch (err) {
    console.error('Dispatcher error:', err);
  }
});

const retentionTask = cron.schedule('0 3 * * *', async () => {
  try {
    await deleteExpiredCheckLogs();
  } catch (err) {
    console.error('Retention error:', err);
  }
});

const shutdown = async () => {
  dispatchTask.stop();
  retentionTask.stop();
  await worker.close();     // stop taking jobs, let in-flight checks finish
  await checkQueue.close();
  await connection.quit();
  await pool.end();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.error('Worker started');
```

`worker.close()` is the graceful drain: it stops pulling new jobs but waits for
active checks to finish before the process exits — so a deploy no longer kills
work mid-flight. (No `isRunning` flag needed anymore — claiming + the queue
replace it.)

---

## Files to change

### `src/db/checks.queries.js`

**Replace `findDueMonitors` with `claimDueMonitors`** — claim and advance in one
atomic statement so concurrent dispatchers never grab the same monitor:

```js
export const claimDueMonitors = async (limit) => {
  const result = await query(
    `UPDATE monitors AS m
     SET next_check_at = NOW() + (m.interval_minutes || ' minutes')::interval,
         updated_at = NOW()
     FROM (
       SELECT id FROM monitors
       WHERE next_check_at <= NOW()
         AND is_active = true
         AND is_deleted = false
       ORDER BY next_check_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     ) AS due
     WHERE m.id = due.id
     RETURNING m.id, m.url, m.failure_threshold, m.consecutive_failures, m.is_alerted`,
    [limit]
  );
  return result.rows;
};
```

`FOR UPDATE SKIP LOCKED` is the work-claiming primitive: each row is locked and
skipped by any other transaction, so N dispatchers split the work instead of
duplicating it. Advancing `next_check_at` in the same statement means the
monitor won't be re-selected next tick.

**Modify `insertCheckLog`** — carry `jobId`, dedupe on it:

```js
export const insertCheckLog = async (client, monitorId, checkResult, jobId) => {
  const result = await client.query(
    `INSERT INTO check_logs (monitor_id, status, response_code, response_time_ms, message, job_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (job_id) DO NOTHING
     RETURNING id`,
    [monitorId, checkResult.status, checkResult.responseCode, checkResult.responseTimeMs, checkResult.message, jobId]
  );
  return result.rows[0] ?? null; // null = this job already wrote its result
};
```

**Modify `updateMonitorAfterCheck`** — drop `next_check_at` (the dispatcher owns
it now); the worker only writes result state:

```js
export const updateMonitorAfterCheck = async (client, monitorId, updates) => {
  const result = await client.query(
    `UPDATE monitors
     SET last_status = $2,
         last_checked_at = NOW(),
         consecutive_failures = $3,
         is_alerted = $4,
         updated_at = NOW()
     WHERE id = $1
     RETURNING id`,
    [monitorId, updates.lastStatus, updates.consecutiveFailures, updates.isAlerted]
  );
  return result.rows[0];
};
```

### `src/services/checks.service.js`

- Remove the `p-limit` import and **delete `checkAllDueMonitors`** (the dispatcher
  + worker replace it).
- Keep `runCheck(url)` exactly as is — the HTTP/SSRF logic is unchanged.
- **Rewrite `processCheck`** to take the job payload + the stable `jobId`, and to
  no-op if the job already wrote its result:

```js
export const processCheck = async (monitor, jobId) => {
  const checkResult = await runCheck(monitor.url);

  await withTransaction(async (client) => {
    const inserted = await insertCheckLog(client, monitor.monitorId, checkResult, jobId);
    if (!inserted) return; // at-least-once re-delivery — already processed, idempotent

    let consecutiveFailures = monitor.consecutiveFailures;
    let isAlerted = monitor.isAlerted;

    if (checkResult.status === 'up') {
      consecutiveFailures = 0;
      if (isAlerted) isAlerted = false;
    } else {
      consecutiveFailures += 1;
      if (consecutiveFailures >= monitor.failureThreshold && !isAlerted) {
        isAlerted = true;
      }
    }

    await updateMonitorAfterCheck(client, monitor.monitorId, {
      lastStatus: checkResult.status,
      consecutiveFailures,
      isAlerted,
    });
  });
};
```

Note the field names are now camelCase (`monitor.monitorId`, `monitor.failureThreshold`,
…) because they come from the job payload built in the dispatcher, not from a
raw DB row. The state-machine logic itself is identical to `08-scheduler.md`.

### `src/server.js`

Remove the scheduler import — the API process must not schedule or check anymore:

```js
import 'dotenv/config';
import app from './app.js';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```

### `src/scheduler/index.js`

**Delete this file.** Its check tick moved to the dispatcher; its retention tick
moved to `worker.js`. (No commented-out code, no dead files — `code-standards.md`.)

### `backend/package.json`

Add worker scripts alongside the existing ones:

```json
"worker": "node src/worker.js",
"worker:dev": "nodemon src/worker.js"
```

Run the system with two processes: `npm run dev` (API) and `npm run worker:dev`.

---

## Idempotency — what is and isn't guaranteed

- **Same job re-delivered** (BullMQ retry, or a crash after the HTTP call but
  before ack): `runCheck` may run again, but the write is deduped by `job_id` —
  one job produces exactly one `check_logs` row and one state transition. ✓
- **Different jobs for the same monitor in the same interval:** prevented by the
  dispatcher `jobId` (`monitorId:minuteBucket`) and by advancing `next_check_at`
  at claim time. ✓
- **Accepted limitation:** the monitor state in the job payload is a *snapshot*
  from claim time. Under normal spacing (interval ≥ 1 min, 5 s check timeout) a
  monitor has at most one in-flight job, so the snapshot is correct. A future
  hardening (a `SELECT … FOR UPDATE` re-read of the monitor inside the worker
  transaction) would close the window if intervals ever drop below check
  duration — out of scope here, documented so it isn't mistaken for an oversight.

---

## What this spec does NOT cover

- Events / pub-sub fan-out and Slack — Phase 3 (`alerts` still flag-only here)
- Caching the dashboard / status page — Phase 2
- Rollups + tiered retention — Phase 4 (daily `DELETE` retention stays for now)
- Metrics (queue depth, worker lag, p99) and rate limiting — Phase 5
- Leader election for the dispatcher — claiming via `SKIP LOCKED` makes N
  dispatchers safe, so this is deliberately refused until a requirement forces it
- BullMQ repeatable-job dispatcher — `node-cron` + claiming is enough now
- Sending alert emails — separate `alerts.service.js` spec

---

## Acceptance criteria

1. With **two** worker processes running, a due monitor is checked **once** per
   cycle, not twice (claim via `FOR UPDATE SKIP LOCKED`).
2. The API process (`npm run dev`) runs **no** scheduler — checks only happen
   when a worker is running.
3. A check job that throws is retried with exponential backoff; after `attempts`
   it remains in the BullMQ **failed** set (dead-letter), not silently dropped.
4. Re-delivering the same job inserts **no** duplicate `check_logs` row and does
   **not** double-increment `consecutive_failures` (dedupe on `job_id`).
5. `next_check_at` advances at **dispatch** time, so a monitor is not enqueued
   again on the next tick while its job is pending.
6. On `SIGTERM`/`SIGINT`, the worker finishes in-flight checks before exiting
   (`worker.close()` drains) — no partial/lost work across a deploy.
7. With Redis stopped, the API still serves `/api/monitors` CRUD; dispatch and
   execution resume when Redis returns (Redis is not a source of truth).
8. The daily retention job still runs, now from the worker process.
9. All check-result writes (log insert + monitor update) remain in one
   transaction (atomic, as before).

---

## After this spec

Add a `learning.md` entry documenting the before→after: the in-process cron and
its `isRunning` flag (the naive version) vs. the dispatcher + durable queue +
idempotent worker (why each piece was forced by the two-instance / mid-deploy
trigger). That entry is how this phase teaches *why*, per the roadmap.
