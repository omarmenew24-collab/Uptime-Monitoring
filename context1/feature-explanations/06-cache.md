# Phase 2: Caching (Making Reads Fast Without Lying)

## What it does

Every time a user opens the dashboard, the API queries Postgres for their monitors. Every 10 seconds (auto-refresh). Multiply by 100 users and that's 600 database queries per minute — all returning the same data that only changes when a check runs (every 5 minutes at minimum).

Phase 2 puts Redis in front of Postgres. The API checks Redis first. If the data is there, it returns it immediately (a **cache hit**). If not (a **cache miss**), it queries Postgres, stores the result in Redis, and returns it. Next request gets the cached copy.

---

## The core idea

Think of caching like a sticky note on your desk.

You need your colleague's phone number. You could walk to HR and ask every time (slow, wastes HR's time). Or you write it on a sticky note the first time. Next time you need it, you check the sticky note first. Way faster.

But what if your colleague changes their number? Your sticky note is now wrong. That's the **invalidation problem** — the hardest part of caching.

Three strategies protect you:
1. **Delete the sticky note when something changes** (explicit invalidation)
2. **Throw out all sticky notes every 60 seconds** (TTL — time to live)
3. **If the sticky note is gone, walk to HR** (cache miss → database fallback)

This app uses all three.

---

## How it flows

```
User opens dashboard
        │
        ▼
  ┌────────────┐
  │ Check Redis │──── cache hit ──── return immediately (2ms)
  │ for user's  │
  │ monitors    │
  └──────┬─────┘
         │
    cache miss
         │
         ▼
  ┌────────────┐
  │ Query      │
  │ Postgres   │──── got data (50ms)
  └──────┬─────┘
         │
         ▼
  ┌────────────┐
  │ Store in   │
  │ Redis with │
  │ 60s TTL    │
  └──────┬─────┘
         │
         ▼
    return data
```

When a write happens (pause, edit, delete, new check result):

```
User pauses a monitor
        │
        ▼
  ┌────────────┐
  │ Update     │
  │ Postgres   │
  └──────┬─────┘
         │
         ▼
  ┌────────────┐
  │ Delete all │  ← monitors:user:xyz
  │ related    │  ← monitor:abc123
  │ cache keys │  ← status:user:xyz
  └────────────┘
         │
    Next read → cache miss → fresh data from Postgres
```

---

## The files

| File | Role |
|------|------|
| `backend/src/cache/redis.js` | Redis connection (separate from the queue connection) |
| `backend/src/cache/monitorCache.js` | All cache read/write/invalidate functions |
| `backend/src/services/monitors.service.js` | Uses cache-aside in every read, invalidates on every write |

---

## The code, explained

### The cache module

```javascript
// backend/src/cache/monitorCache.js

const TTL_SECONDS = 60;           // Dashboard data: 60 seconds
const STATUS_TTL_SECONDS = 120;   // Public status page: 120 seconds (less urgent)

const KEYS = {
  userMonitors: (userId) => `monitors:user:${userId}`,
  monitorDetail: (monitorId) => `monitor:${monitorId}`,
  statusPage: (userId) => `status:user:${userId}`,
};
```

Three different cache keys because three different views read the same data differently. When a monitor changes, all three need fresh data.

### Reading with cache-aside

```javascript
// backend/src/services/monitors.service.js

export const getMonitorsByUser = async (userId) => {
  // Step 1: Check the cache
  const cached = await getCachedMonitorsByUser(userId);
  if (cached) return cached;   // ← Hit! Skip database entirely

  // Step 2: Cache miss — go to the real source
  const monitors = await findMonitorsByUserId(userId);

  // Step 3: Cache it for next time
  await setCachedMonitorsByUser(userId, monitors);

  return monitors;
};
```

This is called **cache-aside** because the application manages the cache itself. The database doesn't know the cache exists. The cache doesn't know the database exists. Your code sits in the middle and coordinates.

### Writing to cache (with non-fatal error handling)

```javascript
export const setCachedMonitorsByUser = async (userId, monitors) => {
  try {
    await redis.set(
      KEYS.userMonitors(userId),
      JSON.stringify(monitors),
      'EX', TTL_SECONDS        // ← Expire after 60 seconds
    );
  } catch {
    // Cache write failure is NOT fatal
    // The app works without cache — just slower
  }
};
```

The `try/catch` with an empty catch block looks wrong, but it's intentional. If Redis is down:
- Without the try/catch → the API crashes → user sees an error
- With the try/catch → the API skips caching → user gets data from Postgres (slower but works)

### Invalidation — the hard part

```javascript
export const invalidateMonitorCache = async (monitorId, userId) => {
  try {
    const keys = [];
    if (monitorId) keys.push(KEYS.monitorDetail(monitorId));
    if (userId) {
      keys.push(KEYS.userMonitors(userId));
      keys.push(KEYS.statusPage(userId));
    }
    if (keys.length > 0) await redis.del(...keys);
  } catch {
    // Invalidation failure is not fatal — TTL will clean up
  }
};
```

When we invalidate, we delete **three keys** because one monitor change affects three views:
1. The specific monitor's detail page
2. The user's dashboard list (which includes this monitor)
3. The user's public status page (which shows this monitor)

Missing any of these means stale data in one of those views.

### Every write path invalidates

```javascript
// backend/src/services/monitors.service.js

export const pause = async (monitorId, userId) => {
  const result = await pauseMonitor(monitorId, userId);
  if (result) await invalidateMonitorCache(monitorId, userId);  // ← Always
  return result;
};

export const resume = async (monitorId, userId) => {
  const result = await resumeMonitor(monitorId, userId);
  if (result) await invalidateMonitorCache(monitorId, userId);  // ← Always
  return result;
};

export const editMonitor = async (monitorId, userId, data) => {
  const result = await updateMonitor(monitorId, userId, data);
  if (result) await invalidateMonitorCache(monitorId, userId);  // ← Always
  return result;
};

export const remove = async (monitorId, userId) => {
  const result = await softDeleteMonitor(monitorId, userId);
  if (result) await invalidateMonitorCache(monitorId, userId);  // ← Always
  return result;
};
```

Every single write — pause, resume, edit, delete, new check result — invalidates the cache. This is the discipline that makes caching safe.

### Two separate Redis connections

```javascript
// Cache Redis (backend/src/cache/redis.js)
const redis = new IORedis({
  maxRetriesPerRequest: 3,   // Give up fast — cache is optional
  lazyConnect: true,         // Don't connect until first use
});

// Queue Redis (backend/src/queue/connection.js)
const connection = new IORedis({
  maxRetriesPerRequest: null, // Never give up — queue is critical
});
```

The cache connection fails fast (3 retries then gives up). The queue connection never gives up. Why? Because a cache miss just hits Postgres — annoying but safe. A queue disconnection means checks stop running — unacceptable.

---

## The tradeoffs you're making

### TTL = how much staleness you tolerate

- **60 seconds for the dashboard.** Checks run every 5 minutes at minimum. A 60-second-old dashboard is fine — the data won't change faster than the check interval.
- **120 seconds for the public status page.** Higher traffic, many unauthenticated readers. Longer cache = fewer database hits. Status pages don't need second-level precision.

### TTL as a safety net, not a strategy

TTL is the BACKUP. If your invalidation code has a bug (forgot to invalidate on some write path), the TTL ensures stale data is gone within 60 seconds. Without TTL, a missed invalidation means stale data **forever**.

### Cache stampede risk

What happens when the cache expires and 100 users hit the dashboard at the same second? All 100 get a cache miss. All 100 query Postgres. All 100 try to write to the cache. This is called a **cache stampede**.

This app doesn't have stampede protection yet (the scale doesn't demand it), but the solutions are:
1. **Lock on miss** — first request acquires a lock, others wait for it to fill the cache
2. **Stale-while-revalidate** — serve the stale value while refreshing in the background
3. **Jitter** — add random seconds to the TTL so entries don't expire simultaneously

---

## Lessons worth keeping

1. **Cache reads, invalidate on writes.** This is the cache-aside pattern. It works for 90% of use cases. Learn this one before learning any others.

2. **Cache failures must be non-fatal.** Never let a cache outage become an application outage. Redis is a performance optimization, not a source of truth.

3. **Invalidate too much, not too little.** Deleting three keys when one might suffice is wasteful but safe. Missing one invalidation path means users see lies.

4. **TTL is your safety net, not your strategy.** Rely on explicit invalidation. Use TTL to catch the cases you missed.

5. **Different data gets different TTLs.** Dashboard data (60s) changes more often than status page data (120s). Match the TTL to how stale the data can tolerate being.
