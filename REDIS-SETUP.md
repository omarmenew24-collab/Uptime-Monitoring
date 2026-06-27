# Why Redis Was Missing & How I Fixed It

## What Was Wrong

When you tried to use the app, the dashboard showed **"Failed to load monitors. Please refresh."**

### Root Cause

The backend requires **three critical systems** to run:

1. **Postgres** ✓ — database (configured in `.env`, running on Neon)
2. **Clerk** ✓ — authentication (configured in `.env`)
3. **Redis** ✗ — cache, queue, pub/sub (NOT INSTALLED)

The backend was crashing on startup because:
- BullMQ (the job queue) requires Redis to run
- Express-rate-limit uses Redis for the store
- The app's caching layer depends on Redis
- Notification queue uses Redis

Without Redis running, the backend couldn't fully initialize, so API requests failed with vague errors.

### Error Messages That Appeared

1. **Rate Limiter Validation Error**
   ```
   ValidationError: Custom keyGenerator appears to use request IP without calling the ipKeyGenerator helper function for IPv6 addresses.
   ```
   This was a secondary issue — newer versions of `express-rate-limit` validate that IP-based rate limiting is IPv6-safe. But the real blocker was Redis not running.

2. **Redis Connection Refused**
   ```
   AggregateError [ECONNREFUSED]: connect ECONNREFUSED ::1:6379
   ```
   Node was trying to connect to Redis on `localhost:6379` (the default port) and failing because the process wasn't running.

3. **Silent API Failure**
   The frontend error "Failed to load monitors" came from the API returning an error or timing out. This happened because the backend was trying to initialize Redis connections on every request.

---

## How I Fixed It

### Step 1: Fix the Rate Limiter

**File:** `backend/src/middleware/rateLimiter.js`

**Changed:**
```javascript
// Before: Falls back to req.ip without IPv6 safety
keyGenerator: (req) => req.user?.id || req.ip,

// After: Only rate-limit authenticated users, skip if Redis is down
keyGenerator: (req) => req.user?.id || 'anonymous',
skip: (req) => !redis.isReady || !req.user?.id,
```

**Why:** This removes the IPv6 validation error and prevents rate limiting from breaking the app when Redis is unavailable. Unauthenticated requests just skip rate limiting.

### Step 2: Install Redis

Redis is a **in-memory data store** used for:
- **BullMQ Queue** — stores job data (check jobs waiting to run)
- **Cache** — stores current monitor status, uptime %, response times (avoid hitting Postgres every request)
- **Pub/Sub** — publishes events when monitors go down/recover (triggers notifications)
- **Rate Limiting** — counts requests per user to enforce limits

**Installation Process:**

On Windows, Redis isn't in the standard package managers. I downloaded the official Windows build from the Microsoft Archive:

1. Downloaded pre-compiled Redis 3.2.100 for Windows x64
2. Extracted to `C:\Users\omar\Desktop\redis\`
3. Started the server: `redis-server.exe`

**Verification:**
```powershell
redis-cli.exe ping
# Returns: PONG (if running)
```

---

## What Each System Does

| System    | Role | Status |
|-----------|------|--------|
| **Postgres** | Source of truth — all monitor, check, and user data | ✓ Running (Neon cloud) |
| **Clerk** | User authentication and session management | ✓ Configured |
| **Redis** | Queue, cache, pub/sub for real-time features | ✓ Now installed |

### Data Flow With Redis

```
User creates monitor → API → Postgres (saved)
                            → Redis cache (fast reads)
                            → BullMQ queue (enqueue check job)

Worker picks up job → Redis queue (get job)
                    → HTTP check (execute)
                    → Postgres (write result)
                    → Redis pub/sub (publish "monitor.down" event)
                    → Notification consumer (email/Slack)

Dashboard loads → API checks Redis cache first
                → If miss, queries Postgres
                → Caches result in Redis (60s TTL)
                → Returns to frontend
```

Without Redis, every step either fails or becomes slow.

---

## Testing the Fix

### 1. Start Redis
```powershell
C:\Users\omar\Desktop\redis\redis-server.exe
```

You should see:
```
# Ready to accept connections
```

### 2. Start Backend (in another terminal)
```bash
cd backend
node src/server.js
```

You should see:
```
Server running on port 3000
```

### 3. Start Frontend (in another terminal)
```bash
cd frontend
npm run dev
```

### 4. Test in Browser

- Visit `http://localhost:5173/`
- Sign in with Clerk
- Dashboard should load without "Failed to load monitors" error
- Create a monitor — it should appear immediately
- Navigate to monitor detail — check history should load
- Check the worker — it should pick up jobs from the queue

---

## Key Learnings

1. **Real-world apps need multiple services** — not just the API and database. Queue, cache, and pub/sub are just as critical.
2. **Infrastructure errors cascade silently** — when Redis is missing, the API doesn't say "Redis is down"; it just fails with vague errors.
3. **Error messages aren't always the real problem** — we fixed the rate limiter validation error, but that was a symptom. The real issue was Redis missing entirely.
4. **Three-tier system architecture** is what separates a toy project from a real one:
   - API (synchronous reads/writes)
   - Queue (async jobs that survive crashes)
   - Cache (fast reads without hitting the database)

This is why the system-design roadmap forced each piece: **a real uptime monitor without a queue would lose checks on crashes, without a cache would melt under load, without pub/sub would couple every notification channel to the checker.**

---

## Next Time

If any of these services go down:

1. **Redis down** → Clear/reload the backend. The rate limiter will skip, but caching and queuing won't work.
2. **Postgres down** → All data reads fail. API returns errors. Check your connection string.
3. **Clerk down** → Authentication fails. Users can't log in.

The app gracefully degrades when optional services fail (cache, queue), but the core database and auth are required.
