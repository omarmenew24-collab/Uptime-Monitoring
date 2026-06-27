# Phase 5: Observability (Knowing When Your System is Broken)

## What it does

You built a distributed system: an API, a dispatcher, workers, Redis queues, a Postgres database. Everything runs in background processes. If something breaks — the dispatcher stops, a worker dies, the queue backs up — nobody sees an error on screen. The dashboard looks fine until users start complaining their monitors haven't been checked in 2 hours.

Observability is how you know your system is healthy **before** users tell you it's not. It answers three questions:
1. **Is everything connected?** (health check)
2. **Is work actually happening?** (lag detection)
3. **How much work is pending?** (queue depth)

---

## The core idea

Think of a car dashboard.

You don't look under the hood every time you drive. You glance at the gauges: fuel, temperature, RPM, oil pressure. If a gauge is red, you pull over and investigate. If everything is green, you keep driving.

The metrics endpoint is your car dashboard. It shows the vital signs of the system at a glance.

---

## Two endpoints, two purposes

### Health check — "is the system alive?"

```javascript
// backend/src/app.js

app.get('/api/health', async (req, res) => {
  let redisOk = false;
  let pgOk = false;

  try { await redis.ping(); redisOk = true; } catch {}
  try { await query('SELECT 1'); pgOk = true; } catch {}

  const status = redisOk && pgOk ? 'healthy' : 'unhealthy';
  const code = status === 'healthy' ? 200 : 503;

  res.status(code).json({ status, redis: redisOk, postgres: pgOk });
});
```

Simple: ping Redis, ping Postgres. If both respond, return 200. If either is down, return 503.

**Who calls this?**
- Load balancers (to decide if this server should receive traffic)
- Monitoring services (to alert you if the API itself goes down)
- Your own checks (before a deploy, verify the system is healthy)

**Response:**
```json
{ "status": "healthy", "redis": true, "postgres": true }
// or
{ "status": "unhealthy", "redis": false, "postgres": true }
```

### Metrics — "is the system actually doing its job?"

The health check tells you the system is alive. But alive ≠ working. The dispatcher could be alive but stuck. Workers could be connected but not processing. The queue could be growing with no one reading it.

```javascript
// backend/src/services/metrics.service.js

export const getMetrics = async () => {
  const [
    checksWaiting,
    checksActive,
    checksFailed,
    notifWaiting,
    notifFailed,
    monitorCount,
    latestCheck,
    redisOk,
    pgOk,
  ] = await Promise.allSettled([
    checkQueue.getWaitingCount(),
    checkQueue.getActiveCount(),
    checkQueue.getFailedCount(),
    notificationQueue.getWaitingCount(),
    notificationQueue.getFailedCount(),
    query('SELECT COUNT(*)::int AS n FROM monitors WHERE is_active = true AND is_deleted = false'),
    query('SELECT MAX(checked_at) AS latest FROM check_logs'),
    redis.ping(),
    query('SELECT 1'),
  ]);
```

**`Promise.allSettled`** — not `Promise.all`. Why? Because `Promise.all` fails if ANY promise fails. If Redis is down, you'd get no metrics at all. `allSettled` runs all promises and reports which succeeded and which failed. You get partial data instead of nothing.

### Lag detection — the most important metric

```javascript
  const latestCheckedAt = val(latestCheck)?.rows?.[0]?.latest ?? null;
  const lagSeconds = latestCheckedAt
    ? Math.round((Date.now() - new Date(latestCheckedAt).getTime()) / 1000)
    : null;
```

**Lag** = how many seconds since the last check ran. If monitors check every 5 minutes (300 seconds), lag should be under 300. If lag is 600, checks are running 5 minutes late. If lag is 3600, checks haven't run in an hour — something is seriously wrong.

### System status determination

```javascript
  let status = 'healthy';
  if (!redisConnected || !pgConnected) {
    status = 'unhealthy';      // Infrastructure down
  } else if (lagSeconds !== null && lagSeconds > 300) {
    status = 'degraded';       // Connected but falling behind
  }
```

Three states:
- **healthy** — everything connected, checks running on time
- **degraded** — connected but checks are late (> 5 minutes behind)
- **unhealthy** — a critical dependency is down

### The full response

```json
{
  "status": "healthy",
  "timestamp": "2026-06-28T10:30:00Z",
  "checks": {
    "queue": {
      "waiting": 3,
      "active": 12,
      "failed": 0
    },
    "lag_seconds": 45,
    "latest": "2026-06-28T10:29:15Z"
  },
  "notifications": {
    "queue": {
      "waiting": 0,
      "failed": 0
    }
  },
  "monitors": {
    "total": 47
  },
  "connections": {
    "redis": true,
    "postgres": true
  }
}
```

---

## What each metric tells you

| Metric | Healthy | Warning | Action |
|--------|---------|---------|--------|
| `checks.queue.waiting` | 0–10 | > 50 | Workers can't keep up — add more workers |
| `checks.queue.active` | > 0 | 0 for > 2 min | Workers are dead — restart worker process |
| `checks.queue.failed` | 0 | Growing | Systematic failure — check logs, could be network issue |
| `checks.lag_seconds` | < 60 | > 300 | Dispatcher or workers stuck — investigate |
| `notifications.waiting` | 0 | > 20 | Notification delivery is slow — check email/Slack |
| `notifications.failed` | 0 | > 0 | Email/Slack is broken — check credentials |
| `connections.redis` | true | false | Queue and cache are down — check Redis |
| `connections.postgres` | true | false | Everything is down — check database |

### Reading the metrics like a story

**Scenario 1:** `waiting=200, active=0, lag=1800`
→ "Jobs are piling up, nobody is processing them, we're 30 minutes behind."
→ **Diagnosis:** Worker process is dead. Restart it.

**Scenario 2:** `waiting=0, active=50, lag=45, failed=0`
→ "Queue is empty, workers are busy, lag is small, nothing failing."
→ **Diagnosis:** System is healthy and keeping up.

**Scenario 3:** `waiting=5, active=10, failed=150, lag=120`
→ "Work is flowing but lots of failures, we're 2 minutes behind."
→ **Diagnosis:** Something is causing checks to fail. Network issue? Target sites down? Check the failed jobs for error messages.

**Scenario 4:** `redis=false, waiting=null, active=null`
→ "Can't even reach the queue to count."
→ **Diagnosis:** Redis is down. All queuing and caching is broken.

---

## How it connects to graceful degradation

The metrics endpoint itself practices graceful degradation:

```javascript
const val = (result, fallback = null) =>
  result.status === 'fulfilled' ? result.value : fallback;
```

If one metric query fails (e.g., Redis is down so queue counts aren't available), the endpoint still returns everything else. You get partial visibility instead of a 500 error.

---

## Lessons worth keeping

1. **Health ≠ working.** A process can be alive (health check passes) but not doing its job (queue backing up, checks not running). You need both types of checks.

2. **Lag is your most important metric.** In any system that processes work in the background, "how far behind is the processing?" tells you more than any other single number.

3. **Use `Promise.allSettled`, not `Promise.all`.** When collecting metrics from multiple sources, partial data is better than no data. One failed source shouldn't hide the rest.

4. **Three states, not two.** "Healthy" and "unhealthy" aren't enough. "Degraded" captures the middle ground: connected but struggling. This maps directly to incident severity levels.

5. **Metrics are for machines, not humans.** The metrics endpoint returns JSON, not a pretty dashboard. Humans read dashboards built on top of metrics (Grafana, Datadog). The endpoint is the data source, not the visualization.
