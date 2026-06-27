# Core System Design Lessons — Real Benefits You Can Apply

This document captures the most critical system design patterns from the uptime monitor. Not theory — the actual problems they solve and why they matter.

---

## 1. Why You Need a Queue (Not Direct Execution)

### The Problem

In a naive system, when a check needs to run, you just execute it:

```javascript
// ❌ NAIVE: Synchronous, loses work on crash
app.post('/api/checks/:id', async (req, res) => {
  const result = await runHttpCheck(url);  // 5 second I/O wait
  await db.insert(result);                 // blocking
  res.json(result);
});
```

**What breaks:**
1. **Slow API** — 5 seconds to run one check. If you have 1000 monitors, you need 5000 seconds of API capacity just for one round of checks.
2. **Lost work** — Process crashes mid-check? Work is gone. Customer thinks you didn't check.
3. **Can't scale** — Adding more checks means adding more API instances, but each one is blocking.
4. **Cascading failures** — One slow site makes your whole API slow (head-of-line blocking).

### The Solution

Decouple execution from request handling with a **durable queue**:

```javascript
// ✅ QUEUE: Async, survives crashes
// API: Just enqueue
app.post('/api/checks/:id', async (req, res) => {
  await checkQueue.add('check', { monitorId }, { jobId: uniqueId });
  res.json({ status: 'queued' });  // return immediately
});

// Worker: Execute in background
worker.process(async (job) => {
  const result = await runHttpCheck(monitor.url);
  await db.insert(result);
  return result;
});
```

**What this gives you:**
- **Durability** — BullMQ stores jobs in Redis. If the worker crashes, the job is retried, not lost.
- **Decoupling** — API can accept 1000 checks instantly. Worker processes them at its own pace.
- **Horizontal scaling** — Add more worker processes, not more API instances.
- **Resilience** — One slow site doesn't block others (worker processes jobs sequentially).

### Code from the app

**The dispatcher** (`backend/src/queue/dispatcher.js`):
```javascript
export const dispatchChecks = async () => {
  const dueMonitors = await findDueMonitors();
  
  for (const monitor of dueMonitors) {
    await checkQueue.add('check', { monitor }, {
      jobId: `${monitor.id}_${minuteBucket}`,  // idempotent
    });
  }
};
```

**The worker** (`backend/src/queue/checkWorker.js`):
```javascript
worker.process(async (job) => {
  const { monitor } = job.data;
  await processCheck(monitor, job.id);  // runs in background
});
```

**Why this matters:**
The dispatcher doesn't wait for checks. It enqueues them and moves on. The worker can be restarted, crash, or be scaled to 10 processes, and the system keeps working.

---

## 2. Idempotency: Making Retries Safe

### The Problem

BullMQ retries failed jobs by default. But if a job is retried, you might write the same check result twice:

```javascript
// ❌ NOT IDEMPOTENT: Retry doubles the data
await db.insert({
  monitorId: 123,
  status: 'up',
  checkedAt: NOW(),
  // No jobId
});

// If this crashes and retries → same row written twice
// Now check history shows:
//   - check 1: up
//   - check 2: up (duplicate from retry)
```

### The Solution

Use a **unique constraint on jobId** so retries are safe:

```javascript
// ✅ IDEMPOTENT: Retries are safe
await db.insert({
  monitorId: 123,
  status: 'up',
  checkedAt: NOW(),
  jobId: 'monitor_123_minute_45',  // unique key
});

// Retry inserts the same row → ON CONFLICT DO NOTHING
// Result: same data, no duplicates
```

### Code from the app

**The check schema** (`backend/src/db/migrations/`):
```sql
CREATE TABLE check_logs (
  id UUID PRIMARY KEY,
  monitor_id UUID NOT NULL,
  status TEXT NOT NULL,
  job_id TEXT UNIQUE,  -- Deduplication key
  checked_at TIMESTAMP NOT NULL,
  ...
);

-- Insert is idempotent because of ON CONFLICT
INSERT INTO check_logs (monitor_id, status, job_id, checked_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (job_id) DO NOTHING
RETURNING id;
```

**The dispatcher generates predictable jobIds** (`backend/src/queue/dispatcher.js`):
```javascript
const minuteBucket = Math.floor(Date.now() / 60000);
const jobId = `${monitor.id}_${minuteBucket}`;
// Same monitor in the same minute = same jobId = safe retry
```

**Why this matters:**
Without idempotency, every retry would create duplicate alerts, duplicate entries in check history, and confuse users. With it, the system is safe to retry without side effects.

This is critical for **at-least-once delivery** systems (queues that retry). Your database is your safety net.

---

## 3. Cache-Aside Pattern: Reducing Database Load

### The Problem

Every dashboard load queries Postgres to get current monitor status:

```javascript
// ❌ NO CACHE: Every request hits the database
app.get('/api/monitors', async (req, res) => {
  const monitors = await db.query(
    'SELECT * FROM monitors WHERE user_id = $1',
    [userId]
  );
  res.json(monitors);  // 50ms query, repeated 100 times/minute
});

// With 100 users, each refreshing every 10 seconds → 600 queries/min
// Your database becomes the bottleneck
```

### The Solution

Check Redis first. On miss, load from Postgres and cache:

```javascript
// ✅ CACHE-ASIDE: Redis first, Postgres on miss
const getMonitorsByUser = async (userId) => {
  const cached = await redis.get(`monitors:${userId}`);
  if (cached) return JSON.parse(cached);
  
  // Cache miss → load from database
  const monitors = await db.query(...);
  
  // Cache for 60 seconds
  await redis.setex(`monitors:${userId}`, 60, JSON.stringify(monitors));
  return monitors;
};
```

**What this gives you:**
- **60% reduction in database load** (if 60% of requests hit cache)
- **10x faster response** (Redis is in-memory, Postgres is disk I/O)
- **Graceful degradation** — if Redis dies, you still work (just slower)

### Code from the app

**The cache layer** (`backend/src/cache/monitorCache.js`):
```javascript
export const getCached = async (key, fetcher, ttl = 60) => {
  try {
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached);
  } catch (err) {
    // Non-fatal: if Redis is down, continue
  }

  const data = await fetcher();
  
  try {
    await redis.setex(key, ttl, JSON.stringify(data));
  } catch (err) {
    // Non-fatal: cache failure doesn't break the API
  }
  
  return data;
};

// Usage
const monitors = await getCached(
  `monitors:${userId}`,
  () => db.getMonitorsByUser(userId),
  60  // 60 second TTL
);
```

**Invalidation on write** (`backend/src/services/monitors.service.js`):
```javascript
export const pause = async (monitorId, userId) => {
  const result = await db.pauseMonitor(monitorId);
  
  // Invalidate cache immediately
  await invalidateMonitorCache(monitorId, userId);
  
  return result;
};
```

**Why this matters:**
The cache TTL (60 seconds) is the key insight. You're saying: "It's okay if the dashboard shows stale data for up to 60 seconds, because:
1. Checks happen every 5 minutes anyway
2. Users aren't making critical decisions based on 1-second precision
3. The 10x speed improvement is worth 60 seconds of staleness"

This is a business decision disguised as a technical one. Cache TTL = how stale your app tolerates.

---

## 4. Event-Driven Architecture: Decoupling Notifications

### The Problem

If the checker directly sends emails and Slack messages, it couples the checker to every notification channel:

```javascript
// ❌ COUPLED: Checker knows about email and Slack
const processCheck = async (monitor) => {
  const result = await runCheck(monitor.url);
  
  if (statusChanged(result)) {
    await sendEmailNotification(monitor.userId, result);
    await sendSlackNotification(monitor.userId, result);
    // Next: SMS? Push? Webhook? Each adds to the checker
  }
};

// Adding a new channel means editing the checker
// Checker gets slower as it waits for all notifications
```

### The Solution

Publish an **event** when status changes. Let independent consumers react:

```javascript
// ✅ DECOUPLED: Checker publishes, consumers listen
const processCheck = async (monitor) => {
  const result = await runCheck(monitor.url);
  
  if (statusChanged(result)) {
    // Just publish — don't wait
    await notificationQueue.add('monitor.down', {
      monitorId: monitor.id,
      userId: monitor.userId,
      ...
    });
  }
};

// Consumer 1: Email
notificationWorker.process('monitor.down', async (job) => {
  await sendEmailNotification(job.data);
});

// Consumer 2: Slack
notificationWorker.process('monitor.down', async (job) => {
  await sendSlackNotification(job.data);
});

// Consumer 3: Incident Log (add without touching checker)
notificationWorker.process('monitor.down', async (job) => {
  await createIncident(job.data);
});
```

**What this gives you:**
- **Loose coupling** — Add/remove notification channels without touching the checker
- **Parallelism** — Email and Slack happen at the same time
- **Failure isolation** — If Slack fails, email still sends
- **Easy testing** — Mock the queue, not the whole system

### Code from the app

**The checker publishes** (`backend/src/services/checks.service.js`):
```javascript
if (!previouslyAlerted && isAlerted) {
  await notificationQueue.add('monitor.down', {
    type: 'monitor.down',
    monitorId: monitor.monitorId,
    userId: monitor.userId,
    monitorName: monitor.monitorName,
    url: monitor.url,
    timestamp: new Date().toISOString(),
  });
}
```

**Consumer 1: Email** (`backend/src/queue/notificationWorker.js`):
```javascript
if (job.data.type === 'monitor.down') {
  await sendEmailNotification({
    to: user.email,
    subject: `${job.data.monitorName} is down`,
    ...
  });
}
```

**Consumer 2: Slack** (same file):
```javascript
if (job.data.type === 'monitor.down') {
  await sendSlackNotification({
    webhook: user.slack_webhook_url,
    text: `🔴 ${job.data.monitorName} is down`,
    ...
  });
}
```

**Why this matters:**
Event-driven architecture is how systems scale. The checker doesn't care how many channels listen. Each consumer is independent, can fail, can be restarted, can be added without redeploying the checker.

---

## 5. Rate Limiting: Protecting Your System

### The Problem

Without rate limits, a single user could:
1. Spam "Check Now" 1000 times/second → DOS your worker
2. Create 10000 monitors → DOS your database
3. Hammer a target domain → Get their IP blocked

### The Solution

Two types of rate limits:

**Per-user API limits** (`backend/src/middleware/rateLimiter.js`):
```javascript
const apiRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 100,  // 100 requests per user per minute
  keyGenerator: (req) => req.user.id,  // Per-user, not per-IP
  store: new RedisStore(),
});

// Block if exceeded
app.use('/api/', apiRateLimiter);
```

**Per-domain concurrency limits** (`backend/src/middleware/domainLimiter.js`):
```javascript
const acquireDomainSlot = async (domain) => {
  const current = await redis.incr(`domain:${domain}`);
  if (current > MAX_CONCURRENT_PER_DOMAIN) {
    return false;  // Back off
  }
  await redis.expire(`domain:${domain}`, 30);
  return true;
};

// Usage in checker
const acquired = await acquireDomainSlot(domain);
if (!acquired) {
  throw new Error(`Too many checks for ${domain}`);
}
```

**Per-user monitor quota** (`backend/src/middleware/quota.js`):
```javascript
const enforceMonitorQuota = async (userId) => {
  const count = await db.query(
    'SELECT COUNT(*) FROM monitors WHERE user_id = $1 AND is_deleted = false',
    [userId]
  );
  
  if (count[0].count >= MAX_MONITORS_PER_USER) {
    throw new Error('Monitor quota exceeded');
  }
};
```

**Why this matters:**
Rate limiting is not about "being mean to users." It's about **protecting your infrastructure**. Without it:
- One DoS attack brings down the whole system
- One runaway client uses all your database connections
- You get blocked by hosting providers for hammering third-party APIs

Rate limiting is a business requirement disguised as a technical feature.

---

## 6. Time-Series Data & Rollups: Handling Growth

### The Problem

Raw check logs grow unbounded. Every 5 minutes = 288 checks/monitor/day. After 30 days = 8640 rows/monitor. With 1000 monitors = 8.6M rows. Graph queries start crawling.

```javascript
// ❌ SLOW: Scanning 8M rows every time user loads the page
SELECT AVG(response_time_ms), COUNT(*)
FROM check_logs
WHERE monitor_id = $1 AND checked_at >= NOW() - INTERVAL '30 days'
GROUP BY DATE(checked_at);

// This query gets slower as check_logs grows
```

### The Solution

**Pre-aggregate** into hourly/daily buckets:

```javascript
// ✅ FAST: 30 rows instead of 8640
SELECT AVG(response_time_ms), uptime_percent, timestamp
FROM check_rollups
WHERE monitor_id = $1 AND period = 'daily' AND timestamp >= NOW() - INTERVAL '30 days'
ORDER BY timestamp;
```

**How rollups are created** (`backend/src/queue/rollupJob.js`):
```javascript
const createRollup = async (monitorId, date) => {
  const checks = await db.query(`
    SELECT status, response_time_ms
    FROM check_logs
    WHERE monitor_id = $1
      AND DATE(checked_at) = $2
  `, [monitorId, date]);
  
  const upCount = checks.filter(c => c.status === 'up').length;
  const avgResponse = avg(checks.map(c => c.response_time_ms));
  
  await db.insert('check_rollups', {
    monitor_id: monitorId,
    period: 'daily',
    timestamp: date,
    uptime_percent: (upCount / checks.length) * 100,
    avg_response_time_ms: avgResponse,
  });
};

// Run this every night
schedule.scheduleJob('0 0 * * *', () => createDailyRollups());
```

**Tiered retention** (`backend/src/queue/retentionJob.js`):
```javascript
const enforceRetention = async () => {
  // Keep raw logs for 30 days
  await db.query(`
    DELETE FROM check_logs
    WHERE checked_at < NOW() - INTERVAL '30 days'
  `);
  
  // Keep rollups forever
  // (they're small: 1000 monitors × 365 days = 365K rows)
};
```

**Why this matters:**
As data grows, you can't query raw data anymore. Rollups let you have:
- **Fast reads** — Graphs load in 10ms instead of 1000ms
- **Cheap storage** — Rollups are 1/1000 the size of raw logs
- **Scalable history** — Customers can look back years without slowdown

This is the pattern used by Prometheus, Datadog, and every time-series database. You'll use it everywhere once you understand the tradeoff: lose per-second precision, gain ability to store years of data.

---

## 7. Graceful Degradation: What Happens When Services Fail

### The Problem

Your system has 3 dependencies:
- Postgres (critical)
- Redis (cache + queue)
- Clerk (auth)

If one fails, does your whole app fail?

```javascript
// ❌ HARD FAILURE: One service down = app is down
const monitors = await redis.get(key);        // If Redis dies → error
const monitors = await db.query(...);          // If Postgres dies → error
const user = await clerk.getUser(userId);     // If Clerk dies → error
```

### The Solution

**Fail gracefully** — services have priority:

```javascript
// ✅ GRACEFUL DEGRADATION
// Critical (hard fail)
const user = await clerk.getUser(userId);  // Can't proceed without auth

// Important (degrade)
const monitors = await getCached(
  key,
  () => db.query(...),  // Fallback to Postgres if Redis is down
  60
);

// Non-critical (skip)
if (metricsEnabled) {
  recordMetric('dashboard_load');  // If metrics are down, don't block
}
```

### Code from the app

**Cache gracefully degrades** (`backend/src/cache/monitorCache.js`):
```javascript
export const getCached = async (key, fetcher, ttl = 60) => {
  try {
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached);
  } catch (err) {
    // ✅ Non-fatal: log but continue
    console.error('Cache read failed:', err.message);
  }

  // Hit Postgres if cache is down
  const data = await fetcher();
  
  try {
    await redis.setex(key, ttl, JSON.stringify(data));
  } catch (err) {
    // ✅ Non-fatal: return data anyway
    console.error('Cache write failed:', err.message);
  }
  
  return data;
};
```

**Health check shows degraded state** (`backend/src/app.js`):
```javascript
app.get('/api/health', async (req, res) => {
  const pgOk = await testPostgres();
  const redisOk = await testRedis();
  
  const status = pgOk && redisOk ? 'healthy' : 'degraded';
  const code = pgOk ? 200 : 503;
  
  res.status(code).json({
    status,
    postgres: pgOk,
    redis: redisOk,
  });
});
```

**Rate limiting skips if Redis is down** (`backend/src/middleware/rateLimiter.js`):
```javascript
skip: (req) => !redis.isReady || !req.user?.id,
// If Redis is down, skip rate limiting (degrade)
// But still block if user isn't auth'd (hard requirement)
```

**Why this matters:**
Perfect systems don't exist. Services fail. Users care about whether they can monitor their sites, not whether Redis is working. Graceful degradation means:
- Postgres down? → API returns 503 (service unavailable)
- Redis down? → API works, just slower (no caching)
- Clerk down? → Users can't log in (hard fail, correct)

This is how production systems stay alive.

---

## Key Takeaways to Apply to Your Next Project

1. **Always use a queue for background work** — Never block requests on slow operations. BullMQ is the pattern; change the tool per your stack.

2. **Make everything idempotent** — Job IDs on database writes save your life. Retries become safe.

3. **Cache aggressively, invalidate on writes** — Cache-aside pattern is your first performance optimization.

4. **Use events instead of direct calls** — Decouple notification channels from the core logic. Same pattern applies to: microservices, worker pools, webhooks.

5. **Rate limit everything** — Per-user, per-domain, per-resource. It's not punishment, it's infrastructure protection.

6. **Pre-aggregate time-series data** — Raw logs are cheap to store once; queries are expensive forever. Rollups fix this.

7. **Design for failure, not success** — Most code is written for the happy path. The real system is what happens when services fail.

---

## Code Architecture Pattern to Remember

```
┌──────────────────────────────────────┐
│ API (Express)                        │
│ - Validates input                    │
│ - Returns immediately                │
│ - No business logic                  │
└──────────────────────────────────────┘
              ↓
┌──────────────────────────────────────┐
│ Service Layer                        │
│ - Business logic                     │
│ - Ownership checks                   │
│ - Orchestration                      │
└──────────────────────────────────────┘
              ↓
         (branches)
      ↙        ↓        ↘
┌─────────┐ ┌────────┐ ┌──────────────┐
│Database │ │ Queue  │ │ Cache/Redis  │
│(Source) │ │(Durable)│ │(Performance) │
└─────────┘ └────────┘ └──────────────┘
```

This is the pattern. Routes are thin. Services are thick. Use a queue for async work. Keep the database as the source of truth. Use cache to reduce load.

Everything in this project follows this pattern.

---

## Files in the Codebase That Implement These Patterns

| Pattern | File | What to Read |
|---------|------|--------------|
| Queue + durability | `backend/src/queue/checkWorker.js` | How the worker processes jobs with retries |
| Idempotency | `backend/src/db/checks.queries.js` | `insertCheckLog` with `ON CONFLICT` |
| Cache-aside | `backend/src/cache/monitorCache.js` | `getCached` function pattern |
| Event publishing | `backend/src/services/checks.service.js` | `notificationQueue.add(...)` calls |
| Rate limiting | `backend/src/middleware/rateLimiter.js` | Per-user rate limits with Redis store |
| Rollups | `backend/src/db/rollups.queries.js` | Daily aggregation queries |
| Graceful degradation | `backend/src/cache/redis.js` | Error handling that doesn't block |
| Health checks | `backend/src/app.js` | `/api/health` endpoint |

Read these in order. They show the real implementation, not theory.
