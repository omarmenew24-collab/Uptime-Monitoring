# Phase 5: Rate Limiting and Quotas (Protecting Your Infrastructure)

## What it does

Without limits, one bad actor (or one buggy client) can take down the entire system:
- Spam the API with 10,000 requests/second → overwhelm Express
- Create 50,000 monitors → overwhelm the dispatcher and workers
- Monitor the same domain from 100 accounts → get your server IP blocked by that domain

Phase 5 adds three layers of protection:
1. **API rate limiting** — max 100 requests per user per minute
2. **Domain concurrency limiting** — max 5 simultaneous checks per domain
3. **Monitor quotas** — max 50 monitors per user

---

## The core idea

Think of a highway.

Without speed limits and toll gates, one semi-truck could block all lanes. One reckless driver could cause a pileup that stops everyone. Traffic laws exist not to punish drivers, but to keep the road usable for everyone.

Rate limiting is the same idea applied to APIs. You're not punishing users — you're ensuring one user can't degrade the experience for all others.

---

## Layer 1: API Rate Limiting

### How it works

Every authenticated request increments a counter in Redis. If the counter exceeds 100 within 60 seconds, the request is rejected with `429 Too Many Requests`.

```
Request 1  → counter = 1  → allowed
Request 2  → counter = 2  → allowed
...
Request 100 → counter = 100 → allowed
Request 101 → counter = 101 → BLOCKED (429)
... 60 seconds pass, counter resets ...
Request 102 → counter = 1  → allowed
```

### The code

```javascript
// backend/src/middleware/rateLimiter.js

export const apiRateLimiter = rateLimit({
  windowMs: 60_000,           // 1 minute window
  max: 100,                   // 100 requests per window
  standardHeaders: true,      // Send X-RateLimit-* headers to the client
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || 'anonymous',
  store: new RedisStore({
    sendCommand: (...args) => redis.call(...args),
  }),
  skip: (req) => !redis.isReady || !req.user?.id,
  message: { error: `Rate limit exceeded. Max 100 requests per minute.` },
});
```

### Key decisions

**`keyGenerator: (req) => req.user?.id`** — Rate limit by user ID, not by IP address. Why?
- 50 employees behind the same office IP would share one limit (unfair)
- A user with a VPN rotates IPs freely (bypasses IP limits)
- User ID is tied to authentication — can't be faked

**`store: new RedisStore()`** — Counts are stored in Redis, not in memory. Why?
- If you run 3 API servers, in-memory counters are per-server. A user could make 100 requests to each server = 300 total.
- Redis is shared, so the limit is truly global: 100 requests no matter which server handles them.

**`skip: (req) => !redis.isReady`** — If Redis is down, skip rate limiting entirely. Why?
- Rate limiting is a protection feature, not a core feature
- Better to serve requests without rate limits than to reject all requests because you can't count

---

## Layer 2: Domain Concurrency Limiting (Counting Semaphore)

### The problem it solves

You have 50 users monitoring `google.com`. The dispatcher runs. 50 check jobs land in the queue at the same time. 50 workers all send HTTP GET to `google.com` simultaneously.

Google sees 50 requests from your IP in 1 second. Google blocks your IP. Now ALL your google.com monitors report "down" — a false alarm for every user.

### How it works

Before checking a URL, the worker "acquires a slot" for that domain. If 5 slots are already taken, it backs off and retries later.

```
Worker 1: acquireDomainSlot("google.com") → count=1 → allowed
Worker 2: acquireDomainSlot("google.com") → count=2 → allowed
Worker 3: acquireDomainSlot("google.com") → count=3 → allowed
Worker 4: acquireDomainSlot("google.com") → count=4 → allowed
Worker 5: acquireDomainSlot("google.com") → count=5 → allowed
Worker 6: acquireDomainSlot("google.com") → count=6 → BLOCKED (> 5)
         → throws error → BullMQ retries in a few seconds
```

### The code

```javascript
// backend/src/middleware/domainLimiter.js

const MAX_CONCURRENT = 5;
const SLOT_TTL_SECONDS = 30;

export const acquireDomainSlot = async (domain) => {
  try {
    const key = `domain:limit:${domain}`;
    const count = await redis.incr(key);        // Atomic increment
    await redis.expire(key, SLOT_TTL_SECONDS);  // Auto-expire in 30s

    if (count > MAX_CONCURRENT) {
      await redis.decr(key);   // Give back the slot we just took
      return false;
    }
    return true;
  } catch {
    return true;  // Redis down? Allow it (degrade gracefully)
  }
};

export const releaseDomainSlot = async (domain) => {
  try {
    const key = `domain:limit:${domain}`;
    const count = await redis.decr(key);
    if (count <= 0) await redis.del(key);  // Clean up when no slots are held
  } catch {
    // TTL will clean up if release fails
  }
};
```

### Why this is called a "counting semaphore"

A **semaphore** is a concurrency primitive that limits how many processes can access a resource simultaneously. A **counting** semaphore allows N concurrent accesses (not just 1).

Redis `INCR`/`DECR` implements this: increment to "acquire," decrement to "release." The counter tracks how many slots are in use.

### The safety net: TTL on slots

What if a worker crashes between `acquireDomainSlot` and `releaseDomainSlot`? The slot is never released. Without TTL, that domain would eventually hit the limit permanently.

`SLOT_TTL_SECONDS = 30` means: if a slot isn't released within 30 seconds, Redis deletes the key automatically. The leaked slot is reclaimed.

### Usage in the checker

```javascript
// backend/src/services/checks.service.js

export const processCheck = async (monitor, jobId) => {
  const domain = new URL(monitor.url).hostname;
  const acquired = await acquireDomainSlot(domain);
  if (!acquired) {
    throw new Error(`Domain ${domain} concurrency limit reached`);
    // BullMQ catches this → retries with exponential backoff
  }

  let checkResult;
  try {
    checkResult = await runCheck(monitor.url);
  } finally {
    await releaseDomainSlot(domain);  // ALWAYS release, even on error
  }
};
```

**`try/finally`** is critical. If the HTTP check throws (network error, timeout), the slot MUST still be released. Without `finally`, the slot leaks.

---

## Layer 3: Monitor Quotas

### The problem it solves

A user creates 10,000 monitors. Each one generates a check job every 5 minutes. That's 10,000 jobs per 5 minutes = 2,000 jobs/minute. Your worker pool can't keep up.

### The code

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

**Called before creation, not after:**
```javascript
export const createMonitor = async (userId, data) => {
  await enforceMonitorQuota(userId);          // Check FIRST
  const monitor = await insertMonitor(userId, data);  // Create only if under limit
  return monitor;
};
```

**`is_deleted = false`** — soft-deleted monitors don't count. The user already "freed" that slot by deleting the monitor.

---

## How the three layers stack

```
Incoming request
       │
       ▼
┌──────────────────┐
│ API Rate Limiter │ → max 100 req/min/user
│ (Express middle) │   "slow down, you're sending too many requests"
└────────┬─────────┘
         │ (if allowed)
         ▼
┌──────────────────┐
│ Monitor Quota    │ → max 50 monitors/user
│ (service layer)  │   "you have too many monitors, delete some first"
└────────┬─────────┘
         │ (if under quota)
         ▼
┌──────────────────┐
│ Domain Limiter   │ → max 5 concurrent checks/domain
│ (worker layer)   │   "too many checks to this domain, try again in a sec"
└──────────────────┘
```

Each layer protects a different resource:
- **Rate limiter** protects the **API server** (CPU, memory, connections)
- **Quota** protects the **worker pool** (job throughput)
- **Domain limiter** protects **target websites** (don't get blocked)

---

## Lessons worth keeping

1. **Rate limit by identity, not by IP.** IP-based limiting punishes office workers and is bypassed by VPNs. Use the authenticated user ID when you have it.

2. **Counting semaphores for concurrency limits.** When you need to limit how many concurrent operations target the same resource, `INCR`/`DECR` in Redis with a TTL safety net is the standard pattern.

3. **Always release in `finally`.** Any resource you acquire (semaphore slot, database connection, file handle) must be released even if an error occurs. `try/finally` guarantees this.

4. **TTL as a safety net for leaked resources.** If a process crashes between acquire and release, the TTL ensures the resource is eventually freed. Without it, leaked slots accumulate until the system deadlocks.

5. **Layer your protections.** No single limit covers everything. Rate limiting stops request floods but doesn't prevent 50 monitors all hitting one domain. Domain limiting stops domain flooding but doesn't prevent 10,000 monitors overwhelming the queue. Quotas prevent that. Each layer covers what the others miss.

6. **Degrade, don't fail.** If Redis is down, skip rate limiting and domain limiting. The system is less protected but still functional. A crashed protection layer shouldn't become a crashed application.
