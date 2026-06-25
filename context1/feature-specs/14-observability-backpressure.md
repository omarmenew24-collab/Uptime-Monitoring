# 14 — Observability + Backpressure (Phase 5)

> System-design phase 5 of `system-design-roadmap.md`. The final phase. This
> spec makes the distributed system **visible** (metrics) and **polite**
> (rate limiting). Without it, the system is running blind — checks run late,
> queues back up, targets get hammered, and nobody knows until a customer
> complains.

## What this covers

We now have a distributed checker: a dispatcher, a durable queue, N workers,
a notification queue, a rollup job, and a retention job. At scale (thousands
of monitors, multiple workers), three questions become critical:

1. **Is the system healthy?** Are checks running on time? Is the queue backing
   up? Are workers keeping pace?
2. **Are we being a good citizen?** If 500 monitors point to the same domain,
   are we hammering it with 500 concurrent requests?
3. **Are users within limits?** Can one user create 10,000 monitors and
   overwhelm the system?

Without answers to these questions, the system is unrunnable in production.
This spec adds:

1. **Metrics endpoint** (`GET /api/metrics`) — exposes queue depth, worker lag,
   check latency percentiles, job success/failure rates, and system health
   indicators. This is what an ops team would wire to Grafana/Datadog.
2. **Per-domain rate limiting** — caps the number of concurrent checks to any
   single domain, so we don't accidentally DDoS a target.
3. **Per-user monitor quotas** — limits how many monitors a user can create.
4. **API rate limiting** — caps requests per user per minute to the API.

### What this teaches

- Observability: what to measure in a distributed system, and why
- Rate limiting algorithms (token bucket / sliding window)
- Backpressure: protecting both downstream targets and the system itself
- Quotas as a product feature, not just an ops tool
- The difference between metrics you expose and metrics you alert on

---

## Existing state this spec builds on

**Backend has:**
- `worker.js` — runs dispatcher (every minute), check worker (BullMQ),
  notification worker (BullMQ), rollup job (hourly), retention job (daily)
- `queue/checkQueue.js` — BullMQ queue named `'checks'`
- `queue/notificationQueue.js` — BullMQ queue named `'notifications'`
- `queue/checkWorker.js` — concurrency from `WORKER_CONCURRENCY` env var
- `app.js` — Express API with `GET /api/health` (returns `{ status: 'ok' }`)
- `monitors.routes.js` — `POST /`, `GET /`, `GET /:id`, `GET /:id/checks`
- `monitors.queries.js` — `insertMonitor`, `findMonitorsByUserId`
- `cache/redis.js` — ioredis client for the API process

**What's missing:**
- No visibility into queue depth, worker lag, or check latency
- No rate limiting on the API or on check execution
- No per-user monitor quota
- `GET /api/health` returns a static `{ status: 'ok' }` — doesn't actually
  check if Redis/Postgres are reachable
- Failed jobs are logged to console.error — no aggregate counts

---

## 1. Metrics endpoint — `GET /api/metrics`

A new endpoint that returns a snapshot of system health. Not behind auth —
this is an internal/ops endpoint. In production it would be on a separate
port or behind a VPN; for this project, it's on the same API.

### What to measure and why

| Metric | What it tells you | Source |
|---|---|---|
| `checks.queue.waiting` | How many check jobs are waiting to be picked up | `checkQueue.getWaitingCount()` |
| `checks.queue.active` | How many checks are running right now | `checkQueue.getActiveCount()` |
| `checks.queue.failed` | How many checks have permanently failed (dead-letter) | `checkQueue.getFailedCount()` |
| `notifications.queue.waiting` | Notification backlog | `notificationQueue.getWaitingCount()` |
| `notifications.queue.failed` | Permanently failed notifications | `notificationQueue.getFailedCount()` |
| `monitors.total` | Total active monitors in the system | `SELECT COUNT(*) FROM monitors WHERE is_active AND NOT is_deleted` |
| `checks.latest` | Timestamp of the most recent check_log | `SELECT MAX(checked_at) FROM check_logs` |
| `checks.lag_seconds` | Seconds since the last check completed — if this grows, workers aren't keeping up | `EXTRACT(EPOCH FROM NOW() - MAX(checked_at))` |
| `redis.connected` | Is Redis reachable | `redis.ping()` |
| `postgres.connected` | Is Postgres reachable | `pool.query('SELECT 1')` |

### Response shape

```json
{
  "status": "healthy",
  "timestamp": "2026-06-25T12:00:00.000Z",
  "checks": {
    "queue": { "waiting": 12, "active": 5, "failed": 0 },
    "lag_seconds": 45,
    "latest": "2026-06-25T11:59:15.000Z"
  },
  "notifications": {
    "queue": { "waiting": 0, "failed": 2 }
  },
  "monitors": { "total": 1500 },
  "connections": {
    "redis": true,
    "postgres": true
  }
}
```

`status` is `"healthy"` when all connections are up and `checks.lag_seconds`
is under 300 (5 minutes — one full check cycle). `"degraded"` when lag is
high. `"unhealthy"` when a connection is down.

### Files

**`services/metrics.service.js`** — gathers all metrics from BullMQ queues,
Postgres, and Redis. Returns the structured object above.

**`routes/metrics.routes.js`** — `GET /api/metrics`, calls the service,
returns JSON. No auth — ops endpoint.

**`app.js`** — mount the metrics router alongside health. Replace the static
`GET /api/health` with a real health check that pings Redis and Postgres.

---

## 2. Per-domain rate limiting

When 500 monitors point to `api.example.com`, the dispatcher enqueues 500
check jobs. Without limiting, 50 of them run concurrently (worker concurrency)
and hit the same server with 50 simultaneous requests. That's indistinguishable
from a DDoS.

### How it works

**In `processCheck`**, before running the HTTP check, acquire a per-domain
concurrency slot. If the slot is full, wait (with a timeout). After the check,
release the slot.

Implementation: use a **Redis-based semaphore** keyed by domain. The semaphore
limits concurrent checks to a configurable cap (e.g., 5 per domain).

**`middleware/domainLimiter.js`**

```js
const MAX_CONCURRENT_PER_DOMAIN = 5;
const LOCK_TTL_MS = 10_000;
```

**`acquireDomainSlot(domain)`** — `INCR` a Redis key `domain:limit:{domain}`.
If the count exceeds the cap, `DECR` and return false. Set a TTL on the key
as a safety net (if a worker crashes holding a slot, it auto-releases).

**`releaseDomainSlot(domain)`** — `DECR` the same key.

This is a **counting semaphore** — the simplest rate-limiting primitive. Not
a token bucket or sliding window; those are for request-rate limiting (next
section). This limits *concurrency*, not *rate*.

### Where it's called

In `checks.service.js`, `processCheck` wraps the `runCheck` call:

```js
const domain = new URL(monitor.url).hostname;
const acquired = await acquireDomainSlot(domain);
if (!acquired) {
  throw new Error(`Domain ${domain} concurrency limit reached`);
  // BullMQ retries the job after backoff — the slot will likely be free
}
try {
  const checkResult = await runCheck(monitor.url);
  // ... rest of processCheck
} finally {
  await releaseDomainSlot(domain);
}
```

If the slot isn't available, the job throws → BullMQ retries with backoff →
by then other checks for this domain have finished and freed their slots.

---

## 3. Per-user monitor quotas

A user can currently create unlimited monitors. At scale, one user creating
10,000 monitors would consume disproportionate system resources.

### How it works

**`middleware/quota.js`**

```js
const MAX_MONITORS_PER_USER = 50;
```

**`enforceMonitorQuota(userId)`** — counts the user's active monitors
(`SELECT COUNT(*) FROM monitors WHERE user_id = $1 AND is_deleted = false`).
If the count >= the limit, throw.

### Where it's called

In `monitors.service.js`, `createMonitor` calls `enforceMonitorQuota` before
inserting. Returns `{ error: 'Monitor limit reached (50)' }` with 403.

The limit is an env var (`MAX_MONITORS_PER_USER`) so it can be changed per
environment without code changes.

---

## 4. API rate limiting

Protects the API itself from abuse. A user refreshing the dashboard in a loop
shouldn't overwhelm the server.

### How it works

Use `express-rate-limit` with a Redis store (`rate-limit-redis`). One rate
limiter applied to all `/api/` routes.

```
Window: 1 minute
Max requests: 100 per user per minute
Key: req.user.id (authenticated), req.ip (unauthenticated)
```

100 requests per minute is generous for a dashboard that polls every 10
seconds (6 requests/min). It only fires on abuse.

### Where it's applied

In `app.js`, as middleware before the routes:

```js
app.use('/api/', apiRateLimiter);
```

The `/api/metrics` endpoint is excluded (ops traffic shouldn't be throttled).

### Dependencies

```
npm install express-rate-limit rate-limit-redis
```

---

## Files to create

| File | What it owns |
|---|---|
| `services/metrics.service.js` | Gathers queue, lag, connection metrics |
| `routes/metrics.routes.js` | `GET /api/metrics` endpoint |
| `middleware/domainLimiter.js` | Per-domain concurrency semaphore (Redis) |
| `middleware/quota.js` | Per-user monitor quota check |
| `middleware/rateLimiter.js` | API request rate limiter |

## Files to change

| File | Change |
|---|---|
| `app.js` | Mount metrics route, add rate limiter middleware, replace static health with real health check |
| `services/checks.service.js` | Wrap `runCheck` with domain limiter acquire/release |
| `services/monitors.service.js` | Call `enforceMonitorQuota` before `insertMonitor` |
| `routes/monitors.routes.js` | Handle 403 quota error response |
| `.env` / `.env.example` | Add `MAX_MONITORS_PER_USER=50`, `MAX_CONCURRENT_PER_DOMAIN=5`, `API_RATE_LIMIT=100` |

---

## What this spec does NOT cover

- Grafana/Datadog integration (the metrics endpoint is the data source;
  visualization is a deployment concern)
- Alerting on metrics (e.g., "page the oncall when lag > 5 min") — that's
  an ops layer, not application code
- Per-user rate tiers (free/pro/enterprise) — the quota is flat for now
- Request-rate limiting on check execution (the domain limiter caps
  *concurrency*, not *requests per second* — the distinction matters but
  concurrency is the right primitive for HTTP checks)
- Prometheus / OpenTelemetry format (JSON is simpler; a `/metrics` endpoint
  in Prometheus format would be a thin adapter over the same data)

---

## Acceptance criteria

1. `GET /api/metrics` returns queue depths, lag, connection status, and
   monitor count — status is `"healthy"` / `"degraded"` / `"unhealthy"`
2. Health check at `GET /api/health` pings Redis and Postgres and returns
   `"unhealthy"` if either is down (not a static `{ status: 'ok' }`)
3. A user cannot create more than `MAX_MONITORS_PER_USER` monitors — returns
   403 with a clear error message
4. Checks for the same domain are limited to `MAX_CONCURRENT_PER_DOMAIN`
   concurrent executions — excess jobs are retried by BullMQ after backoff
5. API requests are rate-limited to `API_RATE_LIMIT` per user per minute —
   returns 429 when exceeded
6. The rate limiter uses Redis as its store (shared across API instances)
7. `/api/metrics` is not rate-limited
8. Domain limiter slots auto-release via TTL if a worker crashes holding one
