# System Design Deep Dive — Every Concept in This Codebase

This is the complete reference. Every system design pattern in the uptime monitor, explained with the actual code, the problem it solves, and the edge cases it handles.

---

## Table of Contents

1. [Producer/Consumer Split](#1-producerconsumer-split)
2. [The Dispatcher Pattern (Single-Leader Work Assignment)](#2-the-dispatcher-pattern)
3. [Work Claiming with FOR UPDATE SKIP LOCKED](#3-work-claiming)
4. [Durable Job Queue (BullMQ)](#4-durable-job-queue)
5. [Retry Strategy (Exponential Backoff + Dead Letter)](#5-retry-strategy)
6. [Idempotency (Making Retries Safe)](#6-idempotency)
7. [Database Transactions](#7-database-transactions)
8. [Connection Pooling](#8-connection-pooling)
9. [Cache-Aside Pattern](#9-cache-aside-pattern)
10. [Cache Invalidation](#10-cache-invalidation)
11. [TTL as a Safety Net](#11-ttl-as-a-safety-net)
12. [Event-Driven Fan-Out](#12-event-driven-fan-out)
13. [Durable Queue vs Pub/Sub (Why We Changed)](#13-durable-queue-vs-pubsub)
14. [The State Machine (Monitor Lifecycle)](#14-the-state-machine)
15. [Duplicate Alert Prevention](#15-duplicate-alert-prevention)
16. [Time-Series Rollups](#16-time-series-rollups)
17. [Tiered Retention](#17-tiered-retention)
18. [Upsert Pattern (ON CONFLICT DO UPDATE)](#18-upsert-pattern)
19. [Rate Limiting (Per-User)](#19-rate-limiting-per-user)
20. [Domain Concurrency Limiting (Counting Semaphore)](#20-domain-concurrency-limiting)
21. [Per-User Resource Quotas](#21-per-user-resource-quotas)
22. [SSRF Protection (Server-Side Request Forgery)](#22-ssrf-protection)
23. [Input Validation at the Boundary (Zod)](#23-input-validation)
24. [Parameterized Queries (SQL Injection Prevention)](#24-parameterized-queries)
25. [Soft Deletes](#25-soft-deletes)
26. [Ownership Verification](#26-ownership-verification)
27. [Layered Architecture (Route → Service → DB)](#27-layered-architecture)
28. [Graceful Shutdown](#28-graceful-shutdown)
29. [Observability (Health Checks + Metrics)](#29-observability)
30. [Graceful Degradation](#30-graceful-degradation)
31. [User Sync with Race Condition Handling](#31-user-sync)
32. [Horizontal Scaling](#32-horizontal-scaling)

---

<a id="1-producerconsumer-split"></a>
## 1. Producer/Consumer Split

**Problem:** The API server handles user requests. Check execution is slow I/O (up to 5 seconds per site). If the API runs checks directly, it blocks request handling.

**Pattern:** Split into two processes:
- **Producer** (API + Dispatcher) — decides WHAT to check, enqueues jobs
- **Consumer** (Worker) — executes the actual HTTP checks

```
backend/src/server.js  → API process (Express, serves users)
backend/src/worker.js  → Worker process (no Express, runs checks)
```

**Why two processes, not two functions:**
- They scale independently — you might need 1 API and 10 workers
- A crash in the worker doesn't take down the API
- They can be deployed separately (different servers, different resources)

**The worker process** (`backend/src/worker.js`):
```javascript
import { createCheckWorker } from './queue/checkWorker.js';
import { createNotificationWorker } from './queue/notificationWorker.js';
import { dispatchDueChecks } from './queue/dispatcher.js';

const checkWorker = createCheckWorker();           // consumes check jobs
const notificationWorker = createNotificationWorker(); // consumes notification jobs

// Dispatcher runs every minute inside the worker process
cron.schedule('* * * * *', async () => {
  await dispatchDueChecks();
});
```

**Key insight:** The worker process runs THREE things:
1. The dispatcher (cron, decides what to check)
2. The check worker (BullMQ consumer, executes checks)
3. The notification worker (BullMQ consumer, sends alerts)

They're all in one process for simplicity, but could each be a separate process if needed.

---

<a id="2-the-dispatcher-pattern"></a>
## 2. The Dispatcher Pattern (Single-Leader Work Assignment)

**Problem:** You have 1000 monitors. Something needs to decide which ones are due for a check RIGHT NOW, and make sure each one is checked exactly once.

**Pattern:** A dispatcher runs every minute, queries for due monitors, and enqueues one job per monitor.

**The dispatcher** (`backend/src/queue/dispatcher.js`):
```javascript
export const dispatchDueChecks = async () => {
  // Step 1: Find monitors where next_check_at <= NOW()
  // Step 2: Advance next_check_at so they're not picked up again
  // Step 3: Enqueue one job per monitor
  const monitors = await claimDueMonitors(DISPATCH_BATCH);
  if (monitors.length === 0) return 0;

  const minuteBucket = Math.floor(Date.now() / 60_000);

  await checkQueue.addBulk(
    monitors.map((monitor) => ({
      name: 'check',
      data: {
        monitorId: monitor.id,
        userId: monitor.user_id,
        monitorName: monitor.name,
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

**Two critical details:**

1. **`next_check_at` advancement:** The dispatcher advances `next_check_at` BEFORE enqueuing. This means if the dispatcher runs twice in the same minute, the second run won't find the same monitors.

2. **State snapshot in job data:** The dispatcher puts the monitor's current state (`consecutiveFailures`, `isAlerted`) into the job data. The worker doesn't need to re-query the database to know the monitor's state. This eliminates a race condition where the state could change between "find due monitors" and "process the check."

---

<a id="3-work-claiming"></a>
## 3. Work Claiming with FOR UPDATE SKIP LOCKED

**Problem:** What if you run two dispatcher instances? They'd both SELECT the same due monitors and enqueue duplicate jobs.

**Pattern:** Use `FOR UPDATE SKIP LOCKED` — a Postgres row-level lock that skips rows already locked by another transaction.

**The query** (`backend/src/db/checks.queries.js`):
```javascript
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
       FOR UPDATE SKIP LOCKED    -- ← This is the key
       LIMIT $1
     ) AS due
     WHERE m.id = due.id
     RETURNING m.id, m.user_id, m.name, m.url, ...`,
    [limit]
  );
  return result.rows;
};
```

**How FOR UPDATE SKIP LOCKED works:**

```
Dispatcher A: SELECT ... FOR UPDATE SKIP LOCKED
  → locks monitors 1, 2, 3
  → advances their next_check_at
  → enqueues jobs for 1, 2, 3

Dispatcher B (runs at the same time): SELECT ... FOR UPDATE SKIP LOCKED
  → tries to lock monitors 1, 2, 3 — they're already locked
  → SKIP LOCKED means it skips them instead of waiting
  → finds monitors 4, 5, 6 instead
  → no duplicates!
```

**Without SKIP LOCKED:**
- `FOR UPDATE` would make Dispatcher B wait until A finishes — slow
- No lock at all would give both dispatchers the same monitors — duplicates

**This is how real systems distribute work across multiple instances.**

---

<a id="4-durable-job-queue"></a>
## 4. Durable Job Queue (BullMQ)

**Problem:** If you just call `processCheck()` directly, a crash loses the work. The check never happens, nobody knows.

**Pattern:** Store jobs in Redis (durable). Workers claim jobs atomically. If a worker crashes, the job is automatically retried.

**The queue definition** (`backend/src/queue/checkQueue.js`):
```javascript
export const checkQueue = new Queue(CHECK_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,                                    // retry up to 3 times
    backoff: { type: 'exponential', delay: 1000 },  // 1s, 2s, 4s between retries
    removeOnComplete: { count: 1000 },              // keep last 1000 completed jobs
    removeOnFail: { count: 5000 },                  // keep last 5000 failed jobs (DLQ)
  },
});
```

**The worker** (`backend/src/queue/checkWorker.js`):
```javascript
export const createCheckWorker = () =>
  new Worker(
    CHECK_QUEUE_NAME,
    async (job) => {
      await processCheck(job.data, job.id);
    },
    { connection, concurrency: 50 }  // process 50 jobs in parallel
  );
```

**What BullMQ guarantees:**
1. **At-least-once delivery** — a job is delivered at least once, possibly more (on retry)
2. **Atomic claim** — only one worker processes a given job
3. **Visibility timeout** — if a worker doesn't finish in time, the job goes back to the queue
4. **Persistence** — jobs survive Redis restarts (if Redis has persistence enabled)

**What BullMQ does NOT guarantee:**
- **Exactly-once delivery** — a job might be processed twice on retry. That's why we need idempotency (section 6).

---

<a id="5-retry-strategy"></a>
## 5. Retry Strategy (Exponential Backoff + Dead Letter)

**Problem:** A check fails. Should you retry immediately? What if the site is down for an hour? What if the error is permanent?

**Pattern:** Exponential backoff — wait longer between each retry. After all retries fail, move to a dead letter queue.

```javascript
defaultJobOptions: {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  // Retry 1: after 1 second
  // Retry 2: after 2 seconds
  // Retry 3: after 4 seconds
  // After 3 failures: job goes to "failed" set (dead letter)
  removeOnFail: { count: 5000 },  // keep 5000 failed jobs for inspection
}
```

**Why exponential backoff:**
- **Immediate retry** — wastes resources if the problem is temporary (network blip)
- **Fixed delay** — doesn't adapt to the severity of the problem
- **Exponential** — gives the system time to recover. 1s → 2s → 4s → 8s → 16s...

**Why keep failed jobs (`removeOnFail: { count: 5000 }`):**
The failed job set acts as a **dead letter queue (DLQ)**. You can:
- Inspect what failed and why
- Replay failed jobs after fixing the issue
- Set up alerts on DLQ size (if it grows, something is systematically wrong)

**Notification queue uses longer delays** (`backend/src/queue/notificationQueue.js`):
```javascript
defaultJobOptions: {
  attempts: 5,           // more retries (notifications are critical)
  backoff: { type: 'exponential', delay: 2000 },  // starts at 2s
  // 2s → 4s → 8s → 16s → 32s
}
```

Notifications get more retries because missing an alert is worse than missing a check (the next scheduled check will catch it, but a missed alert means the user doesn't know their site is down).

---

<a id="6-idempotency"></a>
## 6. Idempotency (Making Retries Safe)

**Problem:** BullMQ retries failed jobs. If a job partially completed before crashing (wrote to DB but didn't update the monitor), the retry would write a duplicate row.

**Pattern:** Give each job a unique ID. Use `ON CONFLICT DO NOTHING` on the database insert.

**Step 1 — Generate a predictable job ID** (`backend/src/queue/dispatcher.js`):
```javascript
const minuteBucket = Math.floor(Date.now() / 60_000);
const jobId = `${monitor.id}_${minuteBucket}`;
// monitor abc123 at minute 45000000 → "abc123_45000000"
// Same monitor, same minute = same jobId, no matter how many times dispatcher runs
```

**Step 2 — Insert with ON CONFLICT** (`backend/src/db/checks.queries.js`):
```javascript
export const insertCheckLog = async (client, monitorId, checkResult, jobId) => {
  const result = await client.query(
    `INSERT INTO check_logs (monitor_id, status, response_code, response_time_ms, message, job_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (job_id) DO NOTHING     -- ← If jobId already exists, skip
     RETURNING id`,
    [monitorId, checkResult.status, checkResult.responseCode, ...]
  );
  return result.rows[0] ?? null;  // null means "already processed"
};
```

**Step 3 — Skip state update if already processed** (`backend/src/services/checks.service.js`):
```javascript
await withTransaction(async (client) => {
  const inserted = await insertCheckLog(client, monitor.monitorId, checkResult, jobId);
  if (!inserted) return;  // ← Already processed, skip everything

  // Only update monitor state if this is a new check
  await updateMonitorAfterCheck(client, monitor.monitorId, { ... });
});
```

**The full chain:**
1. Dispatcher generates predictable jobId
2. Worker processes the job
3. Insert returns null if jobId already exists
4. If null → skip state update (no duplicate alerts, no duplicate logs)
5. Safe to retry as many times as needed

**This is why `job_id` has a UNIQUE constraint in the database.** The database is the idempotency gate, not the application code.

---

<a id="7-database-transactions"></a>
## 7. Database Transactions

**Problem:** Processing a check requires TWO database writes:
1. Insert the check log
2. Update the monitor state (consecutive failures, last_status)

If #1 succeeds but #2 fails (crash between them), the database is inconsistent — there's a check log but the monitor's failure counter is wrong.

**Pattern:** Wrap both writes in a transaction. Either both succeed or neither does.

```javascript
// backend/src/config/db.js
export const withTransaction = async (callback) => {
  const client = await pool.connect();   // Get a dedicated connection
  try {
    await client.query('BEGIN');          // Start transaction
    const result = await callback(client); // Run all queries
    await client.query('COMMIT');         // All succeeded → commit
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');    // Something failed → undo everything
    } catch (rollbackErr) {
      console.error('Rollback failed:', rollbackErr);
    }
    throw err;                           // Re-throw so the caller knows
  } finally {
    client.release();                    // Return connection to the pool
  }
};
```

**Usage in the checker** (`backend/src/services/checks.service.js`):
```javascript
await withTransaction(async (client) => {
  // Both use the same client (same transaction)
  const inserted = await insertCheckLog(client, monitor.monitorId, checkResult, jobId);
  if (!inserted) return;

  await updateMonitorAfterCheck(client, monitor.monitorId, {
    lastStatus: checkResult.status,
    consecutiveFailures,
    isAlerted,
  });
});
// If either fails → ROLLBACK → database is consistent
```

**Key detail:** Both queries use the same `client` (not `pool.query()`). This is because a transaction is tied to a single database connection. If you used `pool.query()`, each call might get a different connection, and the transaction wouldn't work.

---

<a id="8-connection-pooling"></a>
## 8. Connection Pooling

**Problem:** Opening a new database connection for every query is expensive (TCP handshake, SSL, authentication). With 50 concurrent checks, you'd open 50 connections simultaneously.

**Pattern:** Use a connection pool. The pool maintains a set of open connections and hands them out on demand.

```javascript
// backend/src/config/db.js
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  // Default pool size: 10 connections
  // Postgres max_connections is usually 100
});

// Every query borrows a connection, uses it, returns it
export const query = (text, params) => pool.query(text, params);
```

**Why this matters:**
- Without pooling: 50 checks = 50 connections opened and closed = slow
- With pooling: 50 checks share 10 connections = fast, no connection overhead
- The pool handles waiting — if all 10 connections are busy, the 11th query waits for one to free up

**Two different Redis connections in the codebase:**

```javascript
// Cache Redis (backend/src/cache/redis.js)
const redis = new IORedis({
  maxRetriesPerRequest: 3,   // Fail fast — cache is non-critical
  lazyConnect: true,         // Don't connect until first use
});

// Queue Redis (backend/src/queue/connection.js)
export const connection = new IORedis({
  maxRetriesPerRequest: null, // Never give up — queue is critical
  // BullMQ requires null because it uses blocking commands (BRPOPLPUSH)
  // that wait indefinitely for new jobs
});
```

**Why two connections?** The cache Redis can fail fast (cache miss just hits Postgres). The queue Redis must never give up (a disconnected queue means no checks run).

---

<a id="9-cache-aside-pattern"></a>
## 9. Cache-Aside Pattern

**Problem:** The dashboard polls every 10 seconds. 100 users = 600 database queries per minute, all returning the same data that changes only when a check runs (every 5 minutes).

**Pattern:** Check the cache first. If the data is there (cache hit), return it immediately. If not (cache miss), query the database, store the result in cache, then return it.

```javascript
// backend/src/services/monitors.service.js
export const getMonitorsByUser = async (userId) => {
  // Step 1: Check cache
  const cached = await getCachedMonitorsByUser(userId);
  if (cached) return cached;  // ← Cache hit: skip database

  // Step 2: Cache miss — query database
  const monitors = await findMonitorsByUserId(userId);

  // Step 3: Store in cache for next time
  await setCachedMonitorsByUser(userId, monitors);

  return monitors;
};
```

**The cache layer** (`backend/src/cache/monitorCache.js`):
```javascript
const TTL_SECONDS = 60;           // Dashboard cache: 60 seconds
const STATUS_TTL_SECONDS = 120;   // Public status page: 120 seconds

export const getCachedMonitorsByUser = async (userId) => {
  try {
    const data = await redis.get(KEYS.userMonitors(userId));
    return data ? JSON.parse(data) : null;
  } catch {
    return null;  // ← Redis down? Return null → will hit database
  }
};

export const setCachedMonitorsByUser = async (userId, monitors) => {
  try {
    await redis.set(KEYS.userMonitors(userId), JSON.stringify(monitors), 'EX', TTL_SECONDS);
  } catch {
    // Cache write failure is not fatal — next request will cache it
  }
};
```

**Why "cache-aside" and not "write-through":**
- **Cache-aside:** Application manages the cache. Read: check cache → miss → query DB → write cache. Write: update DB → invalidate cache.
- **Write-through:** Every DB write also writes to cache. Simpler but wastes cache space on data that might never be read.

We use cache-aside because not every monitor is viewed frequently. Why cache data nobody reads?

**The math:**
- Without cache: 100 users × 6 requests/min = 600 DB queries/min
- With cache (60s TTL): 100 users × 1 miss/min = 100 DB queries/min
- **6x reduction in database load**

---

<a id="10-cache-invalidation"></a>
## 10. Cache Invalidation

**Problem:** User pauses a monitor. The cache still shows it as active for up to 60 seconds. The dashboard lies.

**Pattern:** Invalidate (delete) the cache immediately when the underlying data changes.

```javascript
// backend/src/services/monitors.service.js

export const pause = async (monitorId, userId) => {
  const result = await pauseMonitor(monitorId, userId);   // Update DB
  if (result) await invalidateMonitorCache(monitorId, userId);  // Delete cache
  return result;
};

export const resume = async (monitorId, userId) => {
  const result = await resumeMonitor(monitorId, userId);
  if (result) await invalidateMonitorCache(monitorId, userId);  // Delete cache
  return result;
};

export const editMonitor = async (monitorId, userId, data) => {
  const result = await updateMonitor(monitorId, userId, data);
  if (result) await invalidateMonitorCache(monitorId, userId);  // Delete cache
  return result;
};
```

**The invalidation function** (`backend/src/cache/monitorCache.js`):
```javascript
export const invalidateMonitorCache = async (monitorId, userId) => {
  try {
    const keys = [];
    if (monitorId) keys.push(KEYS.monitorDetail(monitorId));  // monitor:abc123
    if (userId) {
      keys.push(KEYS.userMonitors(userId));    // monitors:user:xyz
      keys.push(KEYS.statusPage(userId));      // status:user:xyz
    }
    if (keys.length > 0) await redis.del(...keys);  // Delete all related caches
  } catch {
    // Invalidation failure is not fatal — TTL will clean up
  }
};
```

**Why delete THREE keys?**
When a monitor changes, it affects:
1. The monitor detail page (`monitor:abc123`)
2. The user's dashboard list (`monitors:user:xyz`)
3. The public status page (`status:user:xyz`)

All three need fresh data. Delete all three.

**What if invalidation fails?** The TTL acts as a safety net (section 11). The worst case is 60 seconds of stale data.

---

<a id="11-ttl-as-a-safety-net"></a>
## 11. TTL as a Safety Net

**Problem:** What if your invalidation code has a bug? What if a code path writes to the DB but forgets to invalidate? The cache would serve stale data forever.

**Pattern:** Every cache entry has a TTL (Time To Live). Even if invalidation fails, the entry expires automatically.

```javascript
// 60 seconds for authenticated dashboard reads
await redis.set(key, JSON.stringify(data), 'EX', 60);

// 120 seconds for public status page (higher traffic, less need for freshness)
await redis.set(key, JSON.stringify(data), 'EX', 120);
```

**The tradeoff:**
- **Short TTL (10s):** Very fresh data, but more database queries (cache misses more often)
- **Long TTL (300s):** Less database load, but data could be 5 minutes stale
- **Our choice (60s):** Checks run every 5 minutes at minimum. 60s of staleness is acceptable — the data won't change faster than the check interval anyway.

**TTL is not your primary invalidation strategy.** It's the BACKUP. Your primary strategy is explicit invalidation on writes. TTL catches the cases you missed.

---

<a id="12-event-driven-fan-out"></a>
## 12. Event-Driven Fan-Out

**Problem:** When a monitor goes down, you need to: send an email, send a Slack message, and (in the future) log an incident, update the status page, etc. If the checker calls each one directly, it's coupled to every channel.

**Pattern:** The checker publishes a single event. Independent consumers react to it.

**Publisher** (`backend/src/services/checks.service.js`):
```javascript
// The checker doesn't know about email or Slack
// It just says "this monitor went down"
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

**Consumer** (`backend/src/queue/notificationWorker.js`):
```javascript
export const createNotificationWorker = () =>
  new Worker(
    NOTIFICATION_QUEUE_NAME,
    async (job) => {
      await sendEmailNotification(job.data);   // Consumer 1
      await sendSlackNotification(job.data);   // Consumer 2
      // Adding a new channel = add one line here
      // The checker never changes
    },
    { connection, concurrency: 10 }
  );
```

**Why this matters:**
- Adding SMS notifications = add one consumer function. Zero changes to the checker.
- Email service is down? Slack still sends (if they were in separate consumers).
- The checker stays fast — it enqueues and moves on.

---

<a id="13-durable-queue-vs-pubsub"></a>
## 13. Durable Queue vs Pub/Sub (Why We Changed)

**Problem we discovered:** The original plan was to use Redis pub/sub for notifications. But pub/sub is **fire-and-forget** — if no consumer is listening when the event fires, the message is lost forever.

**What goes wrong with pub/sub:**

```javascript
// ❌ PUB/SUB: Fire-and-forget
// Worker publishes "monitor.down"
await redis.publish('monitor.down', JSON.stringify(event));

// Scenario: notification consumer crashed 2 seconds ago
// The publish succeeds, but nobody receives it
// The user never gets alerted that their site is down
// SILENT DATA LOSS
```

**What we use instead — durable queue:**

```javascript
// ✅ DURABLE QUEUE: Persisted until processed
await notificationQueue.add('monitor.down', event);

// Scenario: notification consumer crashed 2 seconds ago
// The job sits in Redis waiting
// Consumer restarts → picks up the job → sends the alert
// NO DATA LOSS
```

**When to use each:**

| Use case | Pattern | Why |
|----------|---------|-----|
| Chat messages | Pub/sub | Missing one message is OK |
| Live dashboards | Pub/sub | Next update replaces the old one |
| **Alerts** | **Durable queue** | **Missing an alert is unacceptable** |
| **Billing** | **Durable queue** | **Missing a charge loses money** |

**Rule of thumb:** If losing the message means a user doesn't get notified, use a durable queue.

---

<a id="14-the-state-machine"></a>
## 14. The State Machine (Monitor Lifecycle)

**Problem:** A monitor has complex state transitions. Up → down → alerted → recovered. Each transition triggers different behavior (alerts, counter resets).

**Pattern:** Model the monitor as a state machine with explicit transitions.

```javascript
// backend/src/services/checks.service.js
// The state machine lives in processCheck()

// State 1: Check result is UP
if (checkResult.status === 'up') {
  consecutiveFailures = 0;       // Reset the counter
  if (isAlerted) {
    isAlerted = false;           // Clear the alert flag
    // → This triggers a "recovered" event
  }
}

// State 2: Check result is DOWN or TIMEOUT
else {
  consecutiveFailures += 1;     // Increment the counter
  if (consecutiveFailures >= monitor.failureThreshold && !isAlerted) {
    isAlerted = true;           // Set the alert flag
    // → This triggers a "down" event
  }
}
```

**The state transitions:**

```
                    check passes
        ┌──────────────────────────────┐
        ▼                              │
    ┌───────┐    check fails      ┌────┴────┐    failures >= threshold    ┌──────────┐
    │  UP   │ ──────────────────► │ FAILING │ ──────────────────────────► │ ALERTED  │
    │       │                     │         │                             │          │
    └───────┘                     └─────────┘                             └──────────┘
        ▲                                                                      │
        │                          check passes                                │
        └──────────────────────────────────────────────────────────────────────┘
                                (recovery event fired)
```

**Key fields on the monitor:**
- `consecutive_failures` — how many checks have failed in a row (resets to 0 on success)
- `is_alerted` — whether we've already sent an alert (prevents duplicates)
- `last_status` — the result of the most recent check
- `failure_threshold` — how many failures before alerting (user-configurable)

---

<a id="15-duplicate-alert-prevention"></a>
## 15. Duplicate Alert Prevention

**Problem:** Monitor fails 5 times in a row. Threshold is 3. Without prevention, you'd send 3 alerts (on failure 3, 4, and 5).

**Pattern:** The `is_alerted` flag. Set it to `true` on the first alert. Don't alert again until recovery.

```javascript
// Only alert on the TRANSITION from "not alerted" to "alerted"
if (consecutiveFailures >= monitor.failureThreshold && !isAlerted) {
  isAlerted = true;  // Set flag → no more alerts until recovery

  await notificationQueue.add('monitor.down', { ... });
}

// Only send recovery when transitioning from "alerted" to "not alerted"
if (previouslyAlerted && !isAlerted) {
  await notificationQueue.add('monitor.recovered', { ... });
}
```

**Timeline:**
```
Check 1: UP    → failures=0, alerted=false
Check 2: DOWN  → failures=1, alerted=false (threshold=3, not yet)
Check 3: DOWN  → failures=2, alerted=false (still below threshold)
Check 4: DOWN  → failures=3, alerted=false → NOW alerted=true → SEND ALERT
Check 5: DOWN  → failures=4, alerted=true  → no alert (already sent)
Check 6: DOWN  → failures=5, alerted=true  → no alert (already sent)
Check 7: UP    → failures=0, alerted=true → NOW alerted=false → SEND RECOVERY
Check 8: UP    → failures=0, alerted=false → normal
```

One alert per incident. One recovery per incident.

---

<a id="16-time-series-rollups"></a>
## 16. Time-Series Rollups

**Problem:** To show a 30-day uptime chart, you'd scan every check log for the last 30 days. With 5-minute intervals, that's 8,640 rows per monitor. With 100 monitors, that's 864,000 rows.

**Pattern:** Pre-aggregate raw data into daily buckets. The chart reads 30 rows instead of 8,640.

**Raw data → Rollup** (`backend/src/db/rollups.queries.js`):
```javascript
// Step 1: Compute stats for one day
export const computeDailyStats = async (monitorId, date) => {
  const result = await query(
    `SELECT
       COUNT(*)::int AS total_checks,
       COUNT(*) FILTER (WHERE status = 'up')::int AS up_count,
       COUNT(*) FILTER (WHERE status = 'down')::int AS down_count,
       COUNT(*) FILTER (WHERE status = 'timeout')::int AS timeout_count,
       ROUND(AVG(response_time_ms))::int AS avg_response_ms,
       MIN(response_time_ms)::int AS min_response_ms,
       MAX(response_time_ms)::int AS max_response_ms
     FROM check_logs
     WHERE monitor_id = $1
       AND checked_at >= $2::date
       AND checked_at < ($2::date + interval '1 day')`,
    [monitorId, date]
  );
  return result.rows[0];
};

// Step 2: Store the aggregated result
export const upsertDailyRollup = async (monitorId, date, stats) => {
  await query(
    `INSERT INTO check_rollups (monitor_id, date, total_checks, up_count, ...)
     VALUES ($1, $2, $3, $4, ...)
     ON CONFLICT (monitor_id, date)
     DO UPDATE SET total_checks = EXCLUDED.total_checks, ...`,
    [monitorId, date, stats.total_checks, stats.up_count, ...]
  );
};
```

**The rollup job** (`backend/src/jobs/rollupJob.js`):
```javascript
export const runRollupJob = async () => {
  const monitors = await query(
    'SELECT id FROM monitors WHERE is_active = true AND is_deleted = false'
  );

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const dates = [yesterday, today];  // Always recompute today + yesterday

  for (const monitor of monitors.rows) {
    for (const date of dates) {
      const stats = await computeDailyStats(monitor.id, date);
      if (stats.total_checks === 0) continue;
      await upsertDailyRollup(monitor.id, date, stats);
    }
  }
};
```

**Why recompute yesterday AND today:**
- Today's rollup is partial (the day isn't over yet). Recomputing it adds the latest checks.
- Yesterday might have been missed if the job failed. Recomputing is safe (upsert).

**Schedule** (`backend/src/worker.js`):
```javascript
// Runs every hour at :05
cron.schedule('5 * * * *', async () => {
  await runRollupJob();
});
```

---

<a id="17-tiered-retention"></a>
## 17. Tiered Retention

**Problem:** Raw check logs grow 288 rows per monitor per day. After a year, that's 105,000 rows per monitor. Storage grows without bound.

**Pattern:** Keep raw data for a limited time (30 days). Keep rollups forever (they're tiny).

```javascript
// backend/src/db/retention.queries.js
const RETENTION_DAYS = 30;

export const deleteExpiredCheckLogs = async () => {
  const result = await query(
    `DELETE FROM check_logs
     WHERE checked_at < NOW() - ($1 || ' days')::interval`,
    [String(RETENTION_DAYS)]
  );
  return result.rowCount;
};
```

**Schedule** — runs at 3 AM daily:
```javascript
cron.schedule('0 3 * * *', async () => {
  await deleteExpiredCheckLogs();
});
```

**The math:**
- Raw logs: 288 rows/monitor/day × 30 days × 1000 monitors = 8.6M rows (bounded)
- Rollups: 1 row/monitor/day × 365 days × 1000 monitors = 365K rows (tiny)

Without retention, after a year you'd have 105M rows. With it, you never exceed ~9M.

---

<a id="18-upsert-pattern"></a>
## 18. Upsert Pattern (ON CONFLICT DO UPDATE)

**Problem:** The rollup job runs hourly. If it runs twice for the same day, it would either fail (duplicate key) or create two rows.

**Pattern:** `INSERT ... ON CONFLICT DO UPDATE` — insert if new, update if exists.

```javascript
export const upsertDailyRollup = async (monitorId, date, stats) => {
  await query(
    `INSERT INTO check_rollups
       (monitor_id, date, total_checks, up_count, down_count, ...)
     VALUES ($1, $2, $3, $4, $5, ...)
     ON CONFLICT (monitor_id, date)      -- ← Unique constraint
     DO UPDATE SET
       total_checks = EXCLUDED.total_checks,    -- ← Replace with new values
       up_count = EXCLUDED.up_count,
       ...`,
    [monitorId, date, stats.total_checks, ...]
  );
};
```

**Three SQL conflict strategies:**

| Strategy | SQL | Use when |
|----------|-----|----------|
| **Ignore** | `ON CONFLICT DO NOTHING` | Idempotent inserts (check logs) |
| **Update** | `ON CONFLICT DO UPDATE` | Recomputed data (rollups) |
| **Fail** | No ON CONFLICT | You want to know about duplicates |

---

<a id="19-rate-limiting-per-user"></a>
## 19. Rate Limiting (Per-User)

**Problem:** Without rate limits, a malicious or buggy client could send 10,000 requests/second, overwhelming the API.

**Pattern:** Count requests per user per time window. Block if exceeded.

```javascript
// backend/src/middleware/rateLimiter.js
export const apiRateLimiter = rateLimit({
  windowMs: 60_000,           // 1 minute window
  max: 100,                   // 100 requests per window
  standardHeaders: true,      // Send X-RateLimit-* headers
  keyGenerator: (req) => req.user?.id || 'anonymous',  // Per user, not per IP
  store: new RedisStore({
    sendCommand: (...args) => redis.call(...args),
  }),
  skip: (req) => !redis.isReady || !req.user?.id,  // Skip if Redis down
  message: { error: `Rate limit exceeded. Max 100 requests per minute.` },
});
```

**Why per-user, not per-IP:**
- Multiple users behind the same office IP would share a limit (unfair)
- A user with a VPN could bypass IP-based limits (insecure)
- Per-user is tied to authentication, which is already verified

**Why skip when Redis is down:**
Rate limiting is a protection mechanism, not a core feature. If Redis is down, it's better to serve requests without rate limiting than to reject all requests.

---

<a id="20-domain-concurrency-limiting"></a>
## 20. Domain Concurrency Limiting (Counting Semaphore)

**Problem:** 50 users all monitor `google.com`. All 50 checks run at the same time. Google sees 50 requests from your IP in 1 second and blocks you.

**Pattern:** A counting semaphore — limit concurrent checks per domain.

```javascript
// backend/src/middleware/domainLimiter.js
const MAX_CONCURRENT = 5;     // Max 5 simultaneous checks per domain
const SLOT_TTL_SECONDS = 30;  // Slot expires after 30s (safety)

export const acquireDomainSlot = async (domain) => {
  try {
    const key = `domain:limit:${domain}`;
    const count = await redis.incr(key);        // Atomically increment
    await redis.expire(key, SLOT_TTL_SECONDS);  // Set expiry

    if (count > MAX_CONCURRENT) {
      await redis.decr(key);  // Release the slot we just took
      return false;           // Can't acquire — too many concurrent
    }

    return true;  // Acquired
  } catch {
    return true;  // Redis down? Allow the check (degrade gracefully)
  }
};

export const releaseDomainSlot = async (domain) => {
  try {
    const key = `domain:limit:${domain}`;
    const count = await redis.decr(key);    // Atomically decrement
    if (count <= 0) await redis.del(key);   // Clean up
  } catch {
    // TTL will clean up if release fails
  }
};
```

**Usage in the checker** (`backend/src/services/checks.service.js`):
```javascript
export const processCheck = async (monitor, jobId) => {
  const domain = new URL(monitor.url).hostname;
  const acquired = await acquireDomainSlot(domain);
  if (!acquired) {
    throw new Error(`Domain ${domain} concurrency limit reached`);
    // BullMQ will retry this job later (exponential backoff)
  }

  let checkResult;
  try {
    checkResult = await runCheck(monitor.url);
  } finally {
    await releaseDomainSlot(domain);  // ← ALWAYS release, even on error
  }
  // ...
};
```

**Why `try/finally`:** If the HTTP check throws an error (network failure, timeout), the slot MUST still be released. Without `finally`, the slot would leak and eventually block all checks for that domain.

**Why `SLOT_TTL_SECONDS = 30`:** Safety net. If a worker crashes without releasing the slot, the TTL ensures the slot is freed after 30 seconds.

---

<a id="21-per-user-resource-quotas"></a>
## 21. Per-User Resource Quotas

**Problem:** A user creates 10,000 monitors. Each generates checks every 5 minutes. Your infrastructure can't handle it.

**Pattern:** Enforce a maximum number of monitors per user.

```javascript
// backend/src/middleware/quota.js
const MAX_MONITORS = Number(process.env.MAX_MONITORS_PER_USER) || 50;

export const enforceMonitorQuota = async (userId) => {
  const result = await query(
    'SELECT COUNT(*)::int AS n FROM monitors WHERE user_id = $1 AND is_deleted = false',
    [userId]
  );

  if (result.rows[0].n >= MAX_MONITORS) {
    const err = new Error(`Monitor limit reached (${MAX_MONITORS})`);
    err.statusCode = 403;
    throw err;
  }
};
```

**Called before creation** (`backend/src/services/monitors.service.js`):
```javascript
export const createMonitor = async (userId, data) => {
  await enforceMonitorQuota(userId);     // ← Check BEFORE inserting
  const monitor = await insertMonitor(userId, data);
  await invalidateMonitorCache(null, userId);
  return monitor;
};
```

**Why `is_deleted = false`:** Soft-deleted monitors don't count against the quota. The user deleted them — they shouldn't block new monitors.

---

<a id="22-ssrf-protection"></a>
## 22. SSRF Protection (Server-Side Request Forgery)

**Problem:** A user creates a monitor with URL `http://169.254.169.254/latest/meta-data/` (AWS metadata endpoint). Your server fetches it and leaks cloud credentials.

**Pattern:** Validate URLs before fetching. Block private IPs, internal hostnames, and non-HTTP protocols.

```javascript
// backend/src/utils/url-safety.js

// Block these hostnames
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',  // GCP metadata
]);

// Block these IP ranges
const PRIVATE_RANGES = [
  'loopback',      // 127.0.0.0/8
  'private',       // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
  'linkLocal',     // 169.254.0.0/16 (AWS metadata!)
  'uniqueLocal',   // IPv6 fc00::/7
  'unspecified',   // 0.0.0.0
];
```

**Two layers of protection:**

**Layer 1 — At creation time** (validates the URL string):
```javascript
export const validateUrlHostname = (urlString) => {
  const parsed = new URL(urlString);

  // Only HTTP/HTTPS
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: 'Only HTTP and HTTPS protocols are allowed' };
  }

  // Block known dangerous hostnames
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { safe: false, reason: 'This hostname is not allowed' };
  }

  // Block IP literals in private ranges
  // Catches: http://127.0.0.1, http://10.0.0.1, http://169.254.169.254
  // ...
};
```

**Layer 2 — At check time** (resolves DNS and validates the IP):
```javascript
export const resolveAndValidate = async (urlString) => {
  const hostname = new URL(urlString).hostname;

  // Resolve ALL DNS records
  const addresses = await dns.lookup(hostname, { all: true });

  // Check EVERY resolved IP — a hostname could have both public and private IPs
  for (const { address } of addresses) {
    if (isPrivateIP(address)) {
      return { safe: false, reason: `Hostname resolves to a private IP (${address})` };
    }
  }

  return { safe: true };
};
```

**Why two layers?**
- Layer 1 catches obvious attacks at creation time (fast feedback to user)
- Layer 2 catches DNS rebinding attacks (hostname resolves to a public IP at creation, then changes to a private IP later)

**This is a real attack vector.** Without SSRF protection, your uptime monitor becomes a tool for attackers to scan internal networks.

---

<a id="23-input-validation"></a>
## 23. Input Validation at the Boundary (Zod)

**Problem:** Users send malformed data. Without validation, bad data reaches the database and causes cryptic errors.

**Pattern:** Validate ALL input at the route level using Zod schemas. Reject invalid data with a clear error before any business logic runs.

```javascript
// backend/src/schemas/monitors.schema.js
export const createMonitorSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  url: z.string().trim()
    .regex(/^https?:\/\/.+\..+/, 'Must be a valid HTTP or HTTPS URL')
    .refine((val) => {
      const result = validateUrlHostname(val);   // SSRF check baked into validation
      return result.safe;
    }, 'Private, reserved, or internal URLs are not allowed'),
  interval_minutes: z.number().refine(
    (val) => [1, 5, 10, 30, 60].includes(val),   // Preset values only
    'Must be 1, 5, 10, 30, or 60'
  ).default(5),
  failure_threshold: z.number().refine(
    (val) => [1, 2, 3, 5].includes(val),
    'Must be 1, 2, 3, or 5'
  ).default(2),
});
```

**Usage in the route** (`backend/src/routes/monitors.routes.js`):
```javascript
router.post('/', async (req, res) => {
  const parsed = createMonitorSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid input',
      details: parsed.error.issues,  // Tells the user exactly what's wrong
    });
  }

  // parsed.data is now guaranteed to be valid
  const monitor = await monitorsService.createMonitor(req.user.id, parsed.data);
  return res.status(201).json({ data: monitor });
});
```

**Why `safeParse` not `parse`:**
- `parse()` throws on invalid input → you need a try/catch
- `safeParse()` returns `{ success, data, error }` → cleaner control flow

**Why preset values (`[1, 5, 10, 30, 60]`) instead of any number:**
- Prevents users from setting `interval_minutes: 0.001` (checking every millisecond)
- Prevents `interval_minutes: 999999` (never checking)
- Makes capacity planning predictable (you know the possible intervals)

---

<a id="24-parameterized-queries"></a>
## 24. Parameterized Queries (SQL Injection Prevention)

**Problem:** If you concatenate user input into SQL, an attacker can inject malicious SQL.

```javascript
// ❌ VULNERABLE: String concatenation
const result = await query(
  `SELECT * FROM monitors WHERE name = '${req.body.name}'`
);
// If name = "'; DROP TABLE monitors; --"
// → SELECT * FROM monitors WHERE name = ''; DROP TABLE monitors; --'
// → Your table is gone
```

**Pattern:** Use parameterized queries. The database treats parameters as data, never as SQL.

```javascript
// ✅ SAFE: Parameterized
const result = await query(
  'SELECT * FROM monitors WHERE name = $1',
  [req.body.name]
);
// If name = "'; DROP TABLE monitors; --"
// → Postgres treats it as a literal string, not SQL
// → Finds monitors named "'; DROP TABLE monitors; --" (probably none)
```

**Every query in the codebase uses parameters:**
```javascript
// monitors.queries.js
await query('INSERT INTO monitors (user_id, name, url) VALUES ($1, $2, $3)', [userId, data.name, data.url]);

// checks.queries.js
await query('SELECT * FROM check_logs WHERE monitor_id = $1 LIMIT $2 OFFSET $3', [monitorId, limit, offset]);

// users.queries.js
await query('UPDATE users SET slack_webhook_url = $2 WHERE id = $1', [userId, slackWebhookUrl]);
```

**Rule:** No user input is EVER interpolated into a SQL string. Always use `$1`, `$2`, etc.

---

<a id="25-soft-deletes"></a>
## 25. Soft Deletes

**Problem:** User deletes a monitor. Hard delete (`DELETE FROM monitors WHERE id = $1`) removes the row. Check history is now orphaned — foreign key references a deleted monitor.

**Pattern:** Set a flag instead of deleting. The monitor still exists but is excluded from all queries.

```javascript
// backend/src/db/monitors.queries.js
export const softDeleteMonitor = async (monitorId, userId) => {
  const result = await query(
    `UPDATE monitors SET is_deleted = true, is_active = false, updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND is_deleted = false
     RETURNING id`,
    [monitorId, userId]
  );
  return result.rows[0] ?? null;
};
```

**Every query that reads monitors filters out deleted ones:**
```javascript
// Dashboard list
WHERE user_id = $1 AND is_deleted = false

// Dispatcher (find due monitors)
WHERE next_check_at <= NOW() AND is_active = true AND is_deleted = false

// Monitor quota
WHERE user_id = $1 AND is_deleted = false
```

**What soft delete gives you:**
- Check history is preserved (the monitor row still exists)
- The monitor stops receiving checks (`is_active = false`)
- It doesn't count toward the user's quota
- You can "undelete" if needed (just set `is_deleted = false`)

---

<a id="26-ownership-verification"></a>
## 26. Ownership Verification

**Problem:** User A knows User B's monitor ID. Without ownership checks, User A could read, edit, or delete User B's monitors.

**Pattern:** Every query that accesses a monitor includes `AND user_id = $2`.

```javascript
// backend/src/db/monitors.queries.js

// Reading a monitor
export const findMonitorByIdAndUser = async (monitorId, userId) => {
  const result = await query(
    `SELECT ... FROM monitors
     WHERE id = $1 AND user_id = $2 AND is_deleted = false`,
    //                 ^^^^^^^^^^^^^^^^ ownership check
    [monitorId, userId]
  );
  return result.rows[0] ?? null;  // Returns null if not owned
};

// Editing a monitor
export const updateMonitor = async (monitorId, userId, data) => {
  const result = await query(
    `UPDATE monitors SET ... WHERE id = $1 AND user_id = $2 AND is_deleted = false`,
    [monitorId, userId, ...]
  );
  return result.rows[0] ?? null;  // Returns null if not owned
};

// Pausing, resuming, deleting — all include user_id check
```

**The route returns 404 (not 403) when ownership fails:**
```javascript
router.get('/:id', async (req, res) => {
  const monitor = await monitorsService.getMonitorDetail(req.params.id, req.user.id);
  if (!monitor) {
    return res.status(404).json({ error: 'Monitor not found' });
  }
  // ...
});
```

**Why 404 instead of 403?** Returning 403 ("Forbidden") confirms the resource exists. An attacker could enumerate IDs to find valid monitors. Returning 404 ("Not Found") doesn't leak information about what exists.

---

<a id="27-layered-architecture"></a>
## 27. Layered Architecture (Route → Service → DB)

**Pattern:** Three layers with strict responsibilities:

```
Route (monitors.routes.js)
  ↓ validates input, calls service, returns response
Service (monitors.service.js)
  ↓ business logic, caching, authorization
Database (monitors.queries.js)
  ↓ SQL queries only, no logic
```

**Route layer** — thin, no logic:
```javascript
router.post('/', async (req, res) => {
  const parsed = createMonitorSchema.safeParse(req.body);  // Validate
  if (!parsed.success) return res.status(400).json({ ... });

  const monitor = await monitorsService.createMonitor(req.user.id, parsed.data);  // Delegate
  return res.status(201).json({ data: monitor });  // Respond
});
```

**Service layer** — business logic:
```javascript
export const createMonitor = async (userId, data) => {
  await enforceMonitorQuota(userId);         // Business rule: quota
  const monitor = await insertMonitor(userId, data);  // Delegate to DB
  await invalidateMonitorCache(null, userId); // Side effect: cache
  return monitor;
};
```

**Database layer** — pure SQL:
```javascript
export const insertMonitor = async (userId, data) => {
  const result = await query(
    'INSERT INTO monitors (user_id, name, url, ...) VALUES ($1, $2, $3, ...) RETURNING ...',
    [userId, data.name, data.url, ...]
  );
  return result.rows[0];
};
```

**Why this matters:**
- Routes never contain business logic → easy to add new routes
- Services never construct SQL → easy to change the database
- DB queries never make decisions → easy to test
- Each layer can be tested independently

---

<a id="28-graceful-shutdown"></a>
## 28. Graceful Shutdown

**Problem:** You deploy a new version. The worker process gets SIGTERM. It's in the middle of processing 10 check jobs. Without graceful shutdown, those 10 jobs are lost.

**Pattern:** On SIGTERM, stop accepting new work, finish in-progress jobs, then exit.

```javascript
// backend/src/worker.js
let shuttingDown = false;

const shutdown = async () => {
  if (shuttingDown) return;    // Prevent double-shutdown
  shuttingDown = true;

  // Step 1: Stop scheduling new work
  dispatchTask.stop();
  rollupTask.stop();
  retentionTask.stop();

  // Step 2: Stop accepting new jobs, finish in-progress ones
  await checkWorker.close();          // Waits for active jobs to complete
  await notificationWorker.close();   // Same

  // Step 3: Close connections
  await checkQueue.close();
  await notificationQueue.close();
  await connection.quit();    // Redis
  await pool.end();           // Postgres

  process.exit(0);
};

process.on('SIGTERM', shutdown);  // Docker/Kubernetes sends this
process.on('SIGINT', shutdown);   // Ctrl+C sends this
```

**What `worker.close()` does:**
1. Stops pulling new jobs from the queue
2. Waits for currently processing jobs to finish (with a timeout)
3. Jobs that were in the queue but not started remain there for another worker to pick up
4. Returns when all in-progress jobs are done

**Without graceful shutdown:**
- `kill -9` (SIGKILL) → process dies immediately → in-progress jobs are abandoned → BullMQ retries them later (at-least-once delivery saves you, but there's a delay)

---

<a id="29-observability"></a>
## 29. Observability (Health Checks + Metrics)

**Problem:** The system is running. Is it actually working? Are checks running on time? Is the queue backing up? Are notifications being delivered?

**Pattern:** Expose a metrics endpoint that reports system health.

**Health check** (`backend/src/app.js`):
```javascript
app.get('/api/health', async (req, res) => {
  let redisOk = false;
  let pgOk = false;

  try { await redis.ping(); redisOk = true; } catch {}
  try { await query('SELECT 1'); pgOk = true; } catch {}

  const status = redisOk && pgOk ? 'healthy' : 'unhealthy';
  res.status(status === 'healthy' ? 200 : 503).json({ status, redis: redisOk, postgres: pgOk });
});
```

**Metrics endpoint** (`backend/src/services/metrics.service.js`):
```javascript
export const getMetrics = async () => {
  const [checksWaiting, checksActive, checksFailed, ...] = await Promise.allSettled([
    checkQueue.getWaitingCount(),        // How many jobs are waiting
    checkQueue.getActiveCount(),         // How many are being processed right now
    checkQueue.getFailedCount(),         // How many have failed (DLQ size)
    notificationQueue.getWaitingCount(), // Notification backlog
    notificationQueue.getFailedCount(),  // Failed notifications
    query('SELECT COUNT(*)::int AS n FROM monitors WHERE is_active = true'),
    query('SELECT MAX(checked_at) AS latest FROM check_logs'),
    redis.ping(),
    query('SELECT 1'),
  ]);

  // Calculate lag: time since last check ran
  const lagSeconds = latestCheckedAt
    ? Math.round((Date.now() - new Date(latestCheckedAt).getTime()) / 1000)
    : null;

  // Determine overall status
  let status = 'healthy';
  if (!redisConnected || !pgConnected) status = 'unhealthy';
  else if (lagSeconds > 300) status = 'degraded';  // 5 min lag = degraded

  return { status, checks: { queue: { waiting, active, failed }, lag_seconds }, ... };
};
```

**What each metric tells you:**

| Metric | Normal | Problem |
|--------|--------|---------|
| `checks.queue.waiting` | 0-10 | > 100 means workers can't keep up |
| `checks.queue.active` | > 0 | 0 means workers are dead |
| `checks.queue.failed` | 0 | Growing means systematic failures |
| `checks.lag_seconds` | < 60 | > 300 means checks are running late |
| `notifications.failed` | 0 | Growing means email/Slack is broken |
| `connections.redis` | true | false means cache/queue is down |
| `connections.postgres` | true | false means everything is down |

---

<a id="30-graceful-degradation"></a>
## 30. Graceful Degradation

**Pattern:** Every external dependency has a failure mode. Design for it.

**Cache failures are non-fatal:**
```javascript
export const getCachedMonitorsByUser = async (userId) => {
  try {
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;  // ← Cache down? Just return null, hit the database
  }
};
```

**Domain limiter failures are non-fatal:**
```javascript
export const acquireDomainSlot = async (domain) => {
  try {
    // ... acquire logic
  } catch {
    return true;  // ← Redis down? Allow the check anyway
  }
};
```

**Rate limiter skips when Redis is down:**
```javascript
skip: (req) => !redis.isReady || !req.user?.id,
// No Redis? No rate limiting (degrade, don't block)
```

**Priority of dependencies:**

| Dependency | If it fails | Impact |
|------------|-------------|--------|
| **Postgres** | API returns 503 | Critical — everything breaks |
| **Redis (queue)** | No new checks dispatched | Severe — checks stop, but API still serves cached data |
| **Redis (cache)** | Every request hits Postgres | Performance hit — works, just slower |
| **Clerk** | Users can't authenticate | Severe — no new logins, but existing sessions may work |
| **SMTP/Slack** | Notifications fail, retried later | Tolerable — BullMQ retries |

---

<a id="31-user-sync"></a>
## 31. User Sync with Race Condition Handling

**Problem:** Clerk manages users. Your database needs a `users` row to associate monitors with. But the Clerk webhook (which creates the row) might not have arrived when the user makes their first API request.

**Pattern:** On every authenticated request, check if the user exists. If not, create them. Handle the race condition where two requests try to create the same user simultaneously.

```javascript
// backend/src/middleware/auth.js
export const syncUser = async (req, res, next) => {
  const { userId: clerkUserId } = getAuth(req);

  // Step 1: Try to find existing user
  const result = await query('SELECT * FROM users WHERE clerk_user_id = $1', [clerkUserId]);
  if (result.rows.length > 0) {
    req.user = result.rows[0];
    return next();
  }

  // Step 2: User doesn't exist — create them
  const clerkUser = await clerkClient.users.getUser(clerkUserId);
  const email = clerkUser.emailAddresses[0]?.emailAddress;

  try {
    const insert = await query(
      'INSERT INTO users (clerk_user_id, email) VALUES ($1, $2) RETURNING *',
      [clerkUserId, email]
    );
    req.user = insert.rows[0];
  } catch (err) {
    // Step 3: Handle race condition
    // Error 23505 = unique_violation
    // Another request already created this user between our SELECT and INSERT
    if (err.code === '23505') {
      const retry = await query('SELECT * FROM users WHERE clerk_user_id = $1', [clerkUserId]);
      req.user = retry.rows[0];
    } else {
      throw err;
    }
  }

  next();
};
```

**The race condition:**
```
Request A: SELECT → no user found
Request B: SELECT → no user found
Request A: INSERT → succeeds
Request B: INSERT → fails with 23505 (unique violation)
Request B: catches 23505 → SELECT again → finds the row Request A created
```

**Without handling 23505:** Request B would get a 500 error. The user would see "something went wrong" on their first click.

---

<a id="32-horizontal-scaling"></a>
## 32. Horizontal Scaling

**Problem:** One worker can process ~50 checks concurrently. If you have 5000 monitors checking every minute, one worker isn't enough.

**Pattern:** Run multiple worker processes. BullMQ distributes jobs automatically.

```
Worker 1 (concurrency: 50) ─┐
Worker 2 (concurrency: 50) ─┼── all consume from the same Redis queue
Worker 3 (concurrency: 50) ─┘

Total capacity: 150 concurrent checks
```

**No code changes needed.** Just start another `node backend/src/worker.js` process. BullMQ handles:
- Job distribution (each job goes to exactly one worker)
- Load balancing (workers pull jobs when ready)
- Failover (if a worker dies, its jobs are retried by another)

**The concurrency setting** (`backend/src/queue/checkWorker.js`):
```javascript
const concurrency = Number(process.env.WORKER_CONCURRENCY) || 50;

export const createCheckWorker = () =>
  new Worker(CHECK_QUEUE_NAME, handler, { connection, concurrency });
```

**Scaling the API is the same:**
- Run multiple `node backend/src/server.js` behind a load balancer
- They all share the same Postgres and Redis
- Rate limiting is per-user in Redis (shared across all API instances)
- Cache is in Redis (shared across all API instances)

**What you DON'T need to do:**
- No sharding
- No service discovery
- No message routing
- No code changes

This is the benefit of designing with shared queues and caches from the start.

---

## Summary: The 32 Concepts in Order of Importance

**If you remember nothing else, remember these 5:**
1. **Queue for async work** — never block requests on slow I/O
2. **Idempotency** — make everything safe to retry
3. **Cache-aside** — reduce database load, degrade gracefully
4. **Ownership verification** — never trust client-provided IDs
5. **Parameterized queries** — never interpolate user input into SQL

**If you want to go deeper, these 10 are the next tier:**
6. Transactions (atomic multi-table writes)
7. Event-driven fan-out (decouple producers from consumers)
8. Graceful shutdown (finish in-progress work before dying)
9. Rate limiting (protect infrastructure from abuse)
10. SSRF protection (don't let users weaponize your server)
11. Soft deletes (preserve history, don't orphan data)
12. FOR UPDATE SKIP LOCKED (distributed work claiming)
13. Time-series rollups (handle growing data)
14. Exponential backoff (smart retries)
15. Health checks (know when something is wrong)

**Everything else is refinement of these core ideas.**
