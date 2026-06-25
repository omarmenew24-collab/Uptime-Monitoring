# 11 — Cache the Read Path (Phase 2)

> System-design phase 2 of `system-design-roadmap.md`. This spec adds a Redis
> cache layer between the API and Postgres for the two hot read paths: the
> dashboard monitor list and the monitor detail page. Read `architecture.md`
> invariant 8 before starting: Redis holds no source of truth.

## What this covers

Every time the dashboard loads, it runs `SELECT ... FROM monitors WHERE user_id = $1`.
Every time the detail page loads, it runs that plus `SELECT ... FROM check_logs`
for stats. The frontend polls both every 10 seconds (`refetchInterval: 10_000`).

In a real app with 100 users, that's **600 identical Postgres queries per minute**
for data that only changes when a check completes (every 1–5 minutes). The
database does the same work over and over, returning the same rows.

This spec adds a **cache-aside** pattern:

1. **Read:** service checks Redis first. If the data is there (cache hit), return
   it — Postgres is never touched. If not (cache miss), query Postgres, store
   the result in Redis, return it.
2. **Write:** when the worker finishes a check and updates a monitor, it
   **invalidates** (deletes) the cached data for that monitor and that user's
   monitor list. The next read will see a cache miss and repopulate from Postgres.
3. **TTL:** every cache entry expires after 60 seconds as a safety net. If
   invalidation fails for any reason, stale data self-heals within a minute.

This is called **cache-aside** (or "lazy loading") — the application manages the
cache explicitly. The alternative (write-through, where the cache is updated on
every write) is more complex and not needed here.

### Why now (the trigger)

The dashboard polls Postgres every 10 seconds per user. With N users, that's
6N queries per minute, all returning identical data between check intervals.
Caching eliminates these redundant reads — Redis serves them in microseconds
instead of Postgres doing a table scan each time.

### What this teaches

- Cache-aside pattern (read-through with explicit invalidation)
- Cache invalidation ("the two hard problems in computer science")
- TTL as a safety net for missed invalidations
- Cache stampede and how to prevent it
- Separating the cache layer from the business logic

---

## Existing state this spec builds on

**Backend has:**
- `queue/connection.js` — an ioredis connection (`maxRetriesPerRequest: null`)
  used by BullMQ. This connection is configured for the **worker process** only.
  The API process has no Redis connection yet.
- `services/monitors.service.js` — `getMonitorsByUser(userId)`,
  `getMonitorDetail(monitorId, userId)`, `getMonitorChecks(...)` — all hit
  Postgres directly, no caching.
- `services/checks.service.js` — `processCheck(monitor, jobId)` writes the
  check result and updates the monitor in Postgres. No cache awareness.
- `db/monitors.queries.js` — `findMonitorsByUserId`, `findMonitorByIdAndUser`
- `db/checks.queries.js` — `getCheckStats`, `findChecksByMonitor`

**Frontend has:**
- `useGetMonitors` — polls `GET /api/monitors` every 10s
- `useMonitorDetail` — polls `GET /api/monitors/:id` every 10s
- `useCheckLogs` — polls `GET /api/monitors/:id/checks` every 10s

**Architecture invariant 8:** Redis holds no source of truth. Postgres is
authoritative; caches are derived and rebuildable. If Redis is down, reads fall
back to Postgres — slower, but correct.

---

## What gets cached (and what doesn't)

| Read path | Cache? | Key pattern | Why / why not |
|---|---|---|---|
| `GET /api/monitors` (dashboard list) | ✅ Yes | `monitors:user:{userId}` | Polled every 10s by every logged-in user; data changes only when a check completes |
| `GET /api/monitors/:id` (detail + stats) | ✅ Yes | `monitor:{monitorId}` | Same polling pattern; stats aggregate is expensive on large tables |
| `GET /api/monitors/:id/checks` (history) | ❌ No | — | Paginated, low reuse (each page/offset combo is different), and the existing index makes it fast |

Not caching the check history is deliberate — the effort-to-benefit ratio is
poor for paginated data with low hit rates. The index
`check_logs_monitor_id_checked_at_idx` keeps these queries fast.

---

## Files to create

### 1. `cache/redis.js` — Redis client for the API process

```js
import IORedis from 'ioredis';

const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

export default redis;
```

This is a **separate connection** from `queue/connection.js`. The queue
connection sets `maxRetriesPerRequest: null` (BullMQ requirement); the cache
connection uses `3` (normal behavior — fail fast on cache miss so we fall back
to Postgres). `lazyConnect: true` means the connection opens on first use, not
on import — so if Redis is down at API boot, the API still starts.

### 2. `cache/monitorCache.js` — cache read/write/invalidation helpers

Three functions per cached read path, plus invalidation:

**`getCachedMonitorsByUser(userId)`**
- Key: `monitors:user:{userId}`
- Returns: the cached JSON array, or `null` on miss
- Reads from Redis, `JSON.parse`, returns

**`setCachedMonitorsByUser(userId, monitors)`**
- Stores the monitors array as JSON with a 60-second TTL
- `redis.set(key, JSON.stringify(monitors), 'EX', 60)`

**`getCachedMonitorDetail(monitorId)`**
- Key: `monitor:{monitorId}`
- Returns: the cached monitor+stats object, or `null` on miss

**`setCachedMonitorDetail(monitorId, monitor)`**
- Stores the monitor+stats object as JSON with a 60-second TTL

**`invalidateMonitorCache(monitorId, userId)`**
- Deletes both keys: `monitor:{monitorId}` and `monitors:user:{userId}`
- Called by the worker after a check updates a monitor
- Uses `redis.del(key1, key2)` — a single round-trip

**Error handling:** every cache operation wraps in try/catch. On any Redis error,
log it and return `null` (for reads) or silently fail (for writes/invalidation).
The cache is an optimization, not a requirement — a Redis blip must never crash
the API or the worker.

### 3. No new migration — cache is derived, not stored in Postgres

---

## Files to change

### `services/monitors.service.js` — add cache-aside reads

**`getMonitorsByUser(userId)`** becomes:

```js
export const getMonitorsByUser = async (userId) => {
  const cached = await getCachedMonitorsByUser(userId);
  if (cached) return cached;

  const monitors = await findMonitorsByUserId(userId);
  await setCachedMonitorsByUser(userId, monitors);
  return monitors;
};
```

On hit: Redis responds in <1ms, Postgres is never touched.
On miss: query Postgres, populate cache, return.

**`getMonitorDetail(monitorId, userId)`** becomes:

```js
export const getMonitorDetail = async (monitorId, userId) => {
  const cached = await getCachedMonitorDetail(monitorId);
  if (cached) {
    if (cached.user_id && cached.user_id !== userId) return null;
    return cached;
  }

  const monitor = await findMonitorByIdAndUser(monitorId, userId);
  if (!monitor) return null;

  const stats = await getCheckStats(monitorId);
  const result = { ...monitor, stats };

  await setCachedMonitorDetail(monitorId, result);
  return result;
};
```

Note: the detail cache is keyed by `monitorId` only (not userId), so we store
`user_id` in the cached object and verify ownership on read. This way the cache
entry is shared if the same monitor is accessed (only its owner can, but the
key is simpler).

**`getMonitorChecks`** — unchanged. Not cached (see table above).

**`createMonitor`** — after insert, invalidate the user's monitor list cache so
the new monitor appears immediately:

```js
export const createMonitor = async (userId, data) => {
  const monitor = await insertMonitor(userId, data);
  await invalidateMonitorCache(null, userId);
  return monitor;
};
```

### `services/checks.service.js` — invalidate after check

At the end of `processCheck`, after the transaction commits, invalidate the
cache for this monitor and its owner:

```js
await invalidateMonitorCache(monitor.monitorId, monitor.userId);
```

This requires adding `userId` to the job payload. The dispatcher must include it.

### `queue/dispatcher.js` — add userId to job data

The `claimDueMonitors` query needs to also return `user_id`, and the dispatcher
includes it in the job payload so the worker can invalidate the right user's
cache after a check.

**`claimDueMonitors` in `checks.queries.js`** — add `m.user_id` to the
RETURNING clause.

**Dispatcher job data** — add `userId: monitor.user_id`.

### `server.js` — connect Redis on API boot

Import the cache Redis client so it connects when the API starts. If Redis is
unreachable, the API still serves — reads fall back to Postgres (cache miss
returns `null`, service queries Postgres as before).

---

## Cache stampede protection

A **cache stampede** happens when a popular cache key expires and many requests
simultaneously see a cache miss, all querying Postgres at once.

The simplest protection: **stale-while-revalidate.** Instead of deleting the key
on invalidation, set a short TTL (e.g. 5 seconds). The first request to see the
near-expiry key refreshes it; others get the stale-but-still-present data. For
this spec we use simple delete + TTL — stampede protection is a known concept
worth understanding, but not forced by the requirements table (adding it would
be cargo-culting).

---

## How it flows (after this spec)

```
Dashboard loads (GET /api/monitors)
  │
  ├─ cache HIT  → return from Redis (< 1ms)
  │
  └─ cache MISS → query Postgres → store in Redis (TTL 60s) → return

Worker finishes a check
  │
  ├─ write result to Postgres (as before)
  │
  └─ invalidate Redis keys:
       monitors:user:{userId}   (dashboard list is now stale)
       monitor:{monitorId}      (detail page is now stale)
       │
       └─ next dashboard/detail request sees a MISS → repopulates from Postgres
```

---

## What this spec does NOT cover

- Caching the public status page (the status page itself doesn't exist yet)
- Caching check history / paginated data (low benefit, see table above)
- Write-through cache (more complex, unnecessary for this read pattern)
- Cache warming on startup (TTL handles cold-start; first request populates)
- Distributed cache invalidation across multiple API instances (single API
  process for now; Redis itself is the shared state if we scale the API later)

---

## Acceptance criteria

1. `GET /api/monitors` returns cached data on the second call within 60 seconds
   (verify by checking Redis key exists after first call)
2. `GET /api/monitors/:id` returns cached data on repeated calls within 60s
3. After a check completes, both cache keys are invalidated — the next request
   hits Postgres and repopulates the cache
4. After creating a new monitor, `GET /api/monitors` reflects the new monitor
   immediately (user list cache was invalidated)
5. If Redis is down, all reads still work (fall back to Postgres) — the API
   does not crash or return errors
6. Cache entries expire after 60 seconds even without explicit invalidation
   (TTL safety net)
7. `GET /api/monitors/:id` for a different user returns 404 even when the
   monitor is cached (ownership checked on read)
8. `GET /api/monitors/:id/checks` is NOT cached — it always hits Postgres
   (intentional; paginated data with low reuse)

---

## After this spec

Add a `learning.md` entry documenting the before→after: direct Postgres reads
on every poll (the naive version) vs. cache-aside with invalidation and TTL
(why each piece was needed). Include the cache stampede concept even though
stampede protection is documented but deliberately refused (not in the
forcing-requirement table) — knowing what to refuse and why is part of the
learning.
