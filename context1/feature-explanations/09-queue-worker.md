# Phase 1: The Worker + Queue (Making Checks Scalable and Reliable)

## What it does

Phase 0 (the scheduler in spec 08) did everything in one place: it found due monitors and immediately ran the checks, all inside the API process. That worked fine for one server, but broke when you tried to scale.

Phase 1 fixes that by **splitting the work into two separate jobs** that talk to each other through a queue:

1. A **dispatcher** (runs every minute) — finds which monitors are due and puts them on a queue (like a to-do list)
2. A **worker** (separate process) — reads the to-do list and actually runs the checks

The benefit: you can have many workers reading from the same queue, so you can check more websites just by starting another worker process. No code changes needed.

---

## The core idea

Think of it like a restaurant kitchen:

- **Old way (Phase 0):** One person takes orders *and* cooks. When they're busy, no one can take new orders. If they call in sick, all work stops.
- **New way (Phase 1):** A receptionist takes orders and puts them in a ticket rack. Five chefs pull from the rack and cook. One chef gets sick? Still four working. More orders coming in? Start another chef.

The **ticket rack is the queue** (BullMQ on Redis). The **receptionist is the dispatcher** (runs every minute). The **chefs are workers** (one or many).

---

## How it flows — minute by minute

```
MINUTE 1:
┌─────────────────────────┐
│ DISPATCHER (1x per min) │
│ "Hey, which monitors    │
│  are due right now?"    │
└────────────┬────────────┘
             │
             ↓
        [DATABASE]
        Finds: api.example.com
                backup.example.com
        Claims them (locks them so
        no other dispatcher grabs them)
             │
             ↓
┌────────────────────────────┐
│ Dispatcher: "I'm putting   │
│ these on the queue for    │
│ someone to check"         │
└────────────┬───────────────┘
             │
             ↓
      ┌──────────────┐
      │   QUEUE      │ (Redis + BullMQ)
      │              │
      │ Job 1: Check │ api.example.com
      │ Job 2: Check │ backup.example.com
      │              │
      └──────┬───────┘
             │
             ↓
   ┌─────────────────────────┐
   │  WORKER (always running)│
   │  "I'll take Job 1"      │
   └─────────┬───────────────┘
             │
             ↓
      Runs HTTP GET to api.example.com
      → Gets 200 OK, 234ms response time
             │
             ↓
      [DATABASE] check_logs
      Writes: status='up', code=200, time=234ms
             │
             ↓
   ┌─────────────────────────┐
   │  WORKER (same process)  │
   │  "Job 1 done, taking    │
   │   Job 2"                │
   └─────────┬───────────────┘
             │
             ↓
      Runs HTTP GET to backup.example.com
      → Timeout (5 seconds, no response)
             │
             ↓
      [DATABASE] check_logs
      Writes: status='timeout', code=null, time=null
             │
             ↓
        ✅ Both jobs done

MINUTE 2:
Dispatcher runs again, finds the next batch of due monitors
Queue is empty (or has new jobs), worker picks them up
(repeat)
```

---

## The files

| File | What it owns |
|------|--------------|
| `queue/connection.js` | Connects to Redis (the server where the queue lives) |
| `queue/checkQueue.js` | Defines the queue (where jobs wait) |
| `queue/dispatcher.js` | "Find due monitors and put them on the queue" |
| `queue/checkWorker.js` | "Take jobs from the queue and run them" |
| `worker.js` | The new worker process (dispatcher + worker + cleanup, all running together) |
| `db/checks.queries.js` | Updated: how to claim monitors, how to write results, deduping on job_id |
| `services/checks.service.js` | Updated: runCheck stays the same, processCheck now handles retries |
| `server.js` | Updated: removed the scheduler (checks now run only in worker.js) |

---

## The code, explained

### 1. Connecting to Redis — `queue/connection.js`

```js
import IORedis from 'ioredis';

export const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});
```

**What it does:**
- Opens a connection to Redis (a super-fast database that lives in memory)
- This connection is shared by the dispatcher and the worker
- `maxRetriesPerRequest: null` is a BullMQ requirement (it needs to be able to wait for jobs without retrying)

**In plain terms:** This is like dialing the phone number to reach the ticket rack (Redis).

---

### 2. Defining the queue — `queue/checkQueue.js`

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
    removeOnFail: { count: 5000 },
  },
});
```

**What it does:**
- Creates a queue named `'checks'` on Redis
- `attempts: 3` — if a job fails, try it up to 3 times
- `backoff: { type: 'exponential', delay: 1000 }` — wait 1 second, then 2, then 4 seconds between retries (backoff = start slow, speed up)
- `removeOnComplete` — delete finished jobs after keeping the last 1000 (save space)
- `removeOnFail: { count: 5000 }` — keep the last 5000 failed jobs so we can see what broke

**In plain terms:** This is like setting up the ticket rack and deciding: "if a ticket fails (chef can't cook it), try again up to 3 times. Keep recent failed tickets so we know what went wrong."

---

### 3. The dispatcher — `queue/dispatcher.js`

```js
import { claimDueMonitors } from '../db/checks.queries.js';
import { checkQueue } from './checkQueue.js';

const DISPATCH_BATCH = 500;

export const dispatchDueChecks = async () => {
  // Step 1: Find monitors that are due and claim them
  const monitors = await claimDueMonitors(DISPATCH_BATCH);
  if (monitors.length === 0) return 0;

  // Step 2: Create a minute bucket (so same job isn't created twice in same minute)
  const minuteBucket = Math.floor(Date.now() / 60_000);

  // Step 3: Put each monitor on the queue as a job
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
      opts: { jobId: `${monitor.id}_${minuteBucket}` },
    }))
  );

  return monitors.length;
};
```

**What it does:**

**Step 1 — Claim due monitors:**
```js
const monitors = await claimDueMonitors(DISPATCH_BATCH);
```
Asks the database: "Give me up to 500 monitors that are due to check, but lock them so no other dispatcher takes them." This prevents two dispatchers from both claiming the same monitor and creating duplicate work.

**Step 2 — Create a job ID:**
```js
const minuteBucket = Math.floor(Date.now() / 60_000);
```
Gets the current minute (e.g., 1718000000). This is used to create a unique job ID so if the dispatcher runs twice in the same minute, it won't create the job twice.

**Step 3 — Put them on the queue:**
```js
await checkQueue.addBulk(monitors.map(...))
```
For each monitor, creates a job that looks like:
```js
{
  name: 'check',                                    // type of job
  data: {                                           // the info the worker needs
    monitorId: '32996f2a-...',
    url: 'https://example.com',
    failureThreshold: 2,
    consecutiveFailures: 0,
    isAlerted: false,
  },
  opts: { jobId: '32996f2a-..._29705205' }        // unique ID for this job
}
```

**In plain terms:** The dispatcher finds monitors, locks them (so no duplicate work), and puts tickets on the rack with everything a chef (worker) needs to cook.

---

### 4. The worker — `queue/checkWorker.js`

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

**What it does:**
- Creates a worker that listens to the queue
- `async (job) => { ... }` — when a job arrives, call `processCheck` with the job data and job id
- `concurrency` — how many jobs can run *at the same time* (default 50, like `pLimit(50)` from Phase 0)

**In plain terms:** "I'm standing at the ticket rack. When a ticket arrives, I pick it up, do the work, and mark it done. I can do 50 tickets at the same time."

---

### 5. The worker process entrypoint — `worker.js`

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

// Run dispatcher every minute
const dispatchTask = cron.schedule('* * * * *', async () => {
  try {
    await dispatchDueChecks();
  } catch (err) {
    console.error('Dispatcher error:', err);
  }
});

// Run cleanup at 3 AM daily
const retentionTask = cron.schedule('0 3 * * *', async () => {
  try {
    await deleteExpiredCheckLogs();
  } catch (err) {
    console.error('Retention error:', err);
  }
});

// Graceful shutdown: finish in-flight checks before stopping
const shutdown = async () => {
  dispatchTask.stop();
  retentionTask.stop();
  await worker.close();    // Wait for jobs to finish
  await checkQueue.close();
  await connection.quit();
  await pool.end();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.error('Worker started');
```

**What it does:**

**The worker process is three things in one:**

1. **Dispatcher (every minute):**
   ```js
   cron.schedule('* * * * *', async () => {
     await dispatchDueChecks();
   });
   ```
   Runs the `dispatchDueChecks()` function every minute to find due monitors and put them on the queue.

2. **Worker (always running):**
   ```js
   const worker = createCheckWorker();
   ```
   Waits for jobs to arrive and processes them.

3. **Graceful shutdown:**
   ```js
   const shutdown = async () => {
     await worker.close();  // Finish jobs before exiting
   };
   process.on('SIGTERM', shutdown);
   ```
   When the process is told to stop (deploy, crash), it finishes any jobs that are running before exiting. This way no work is lost.

**In plain terms:** The worker process is the kitchen that both receives tickets (dispatcher) and cooks them (worker). When the restaurant is told to close, it finishes the orders on the stove first.

---

### 6. Claiming monitors (preventing double-checks) — `db/checks.queries.js`

This is the crucial piece that prevents Phase 0's problem (running two instances = double-check).

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

**What it does:**

**The magic line:**
```sql
FOR UPDATE SKIP LOCKED
```

This is a database feature that works like a lock:
- `FOR UPDATE` — "Lock these rows so no one else can change them"
- `SKIP LOCKED` — "If a row is already locked, skip it and move to the next one"

So if two dispatchers run at the same time:
1. Dispatcher A locks monitor `api.example.com`
2. Dispatcher B tries to lock `api.example.com` but it's already locked, so it skips it
3. Result: `api.example.com` is checked exactly once, not twice

**Then we advance the schedule:**
```sql
SET next_check_at = NOW() + (m.interval_minutes || ' minutes')::interval
```
This means "move this monitor's next check time forward by its interval (e.g., 5 minutes)." So it won't be selected again on the next dispatcher tick.

**In plain terms:** "Grab this monitor and lock it so no one else can grab it. Also, move its check time forward so it's not due again immediately. Then put it on the queue."

---

### 7. Idempotent writes (handling retries) — `db/checks.queries.js`

```js
export const insertCheckLog = async (client, monitorId, checkResult, jobId) => {
  const result = await client.query(
    `INSERT INTO check_logs (monitor_id, status, response_code, response_time_ms, message, job_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (job_id) DO NOTHING
     RETURNING id`,
    [monitorId, checkResult.status, checkResult.responseCode, checkResult.responseTimeMs, checkResult.message, jobId]
  );
  return result.rows[0] ?? null;
};
```

**What it does:**

**The key line:**
```sql
ON CONFLICT (job_id) DO NOTHING
```

This says: "If I try to insert a log with a `job_id` that already exists, don't crash — just do nothing."

Why? Because BullMQ delivers "at least once" — if a worker crashes mid-check, the job is re-delivered and the worker runs it again. Without this, you'd write the log twice:
- First delivery: insert log ✓
- Re-delivery: try to insert same log → crash ✗

With this:
- First delivery: insert log ✓
- Re-delivery: `job_id` already exists, do nothing ✓

**In plain terms:** "If this exact job was already checked and logged, don't log it twice. Just pretend I inserted it and move on."

---

### 8. Processing a check (the idempotent worker logic) — `services/checks.service.js`

```js
export const processCheck = async (monitor, jobId) => {
  const checkResult = await runCheck(monitor.url);

  await withTransaction(async (client) => {
    // Try to insert the log
    const inserted = await insertCheckLog(client, monitor.monitorId, checkResult, jobId);
    
    // If the log already exists (retry/re-delivery), skip the state update
    if (!inserted) return;

    // Normal flow: update the monitor's state
    let consecutiveFailures = monitor.consecutiveFailures;
    let isAlerted = monitor.isAlerted;

    if (checkResult.status === 'up') {
      consecutiveFailures = 0;
      if (isAlerted) isAlerted = false;  // Recovered!
    } else {
      consecutiveFailures += 1;
      if (consecutiveFailures >= monitor.failureThreshold && !isAlerted) {
        isAlerted = true;  // Threshold crossed!
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

**What it does:**

1. **Run the check:**
   ```js
   const checkResult = await runCheck(monitor.url);
   ```
   Same as Phase 0 — HTTP GET, timeout, etc.

2. **Try to insert the log:**
   ```js
   const inserted = await insertCheckLog(client, monitor.monitorId, checkResult, jobId);
   ```
   If it fails because `job_id` already exists, `inserted` will be `null`.

3. **Skip if re-delivery:**
   ```js
   if (!inserted) return;
   ```
   If we're re-processing this job (retry), the log is already there. Don't double-update the monitor.

4. **Update the monitor state:**
   The state machine from Phase 0 stays the same.

**In plain terms:** "Log this check. If I've already logged it (retry), skip updating the monitor — it's already updated. If it's new, update the monitor's status and alert flags."

---

## Lessons worth keeping

1. **Work-claiming with `FOR UPDATE SKIP LOCKED` is your friend.** It lets many processes work in parallel without stepping on each other. No in-memory flag needed.

2. **"At-least-once delivery" means idempotency is not optional.** The moment you have a queue, assume jobs can be delivered twice. Design the dedupe key (`job_id`) from day one.

3. **Decide what to run separately from how to run it.** The dispatcher is "what"; the worker is "how." This seam is what lets you scale — add more chefs without touching the kitchen.

4. **A transaction keeps related writes together.** Log + monitor update must both succeed or both fail. The transaction makes them atomic.

5. **Graceful shutdown matters.** `worker.close()` waits for jobs to finish. In production, this means zero lost checks during a deploy.

6. **You haven't tested a distributed system until it's running.** The `job_id` `:` character bug only appeared when we actually enqueued a job. Static checks won't find this.

7. **The queue is the source of truth for "is this work claimed?"** Not an in-memory boolean, not the schedule column alone — the queue + the lock tell you what's happening right now.
