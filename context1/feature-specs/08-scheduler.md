## What this covers

The background scheduler that runs every minute, checks all due monitors, logs results, and updates monitor state. This is the core engine of the app — without it, monitors are just rows that do nothing.

After this spec is implemented, every monitor with `next_check_at <= NOW()` gets an HTTP GET request. The result is logged to `check_logs`, and the monitor's `last_status`, `last_checked_at`, `next_check_at`, `consecutive_failures`, and `is_alerted` are updated atomically.

This spec does NOT cover sending email alerts. It detects the alert condition and sets the `is_alerted` flag, but the actual email is a separate spec. The architecture names `alerts.service.js` as its own domain — we respect that boundary.

---

## Existing state this spec builds on

**Backend has:**
- Express app at `src/app.js`, server at `src/server.js` (listens on PORT)
- `pg` pool at `src/config/db.js` with `query(text, params)` helper
- `monitors` table with: `next_check_at`, `is_active`, `is_deleted`, `last_status`, `last_checked_at`, `consecutive_failures`, `is_alerted`, `failure_threshold`, `interval_minutes`, `updated_at`
- `check_logs` table with: `monitor_id`, `status`, `response_code`, `response_time_ms`, `message`, `checked_at`
- Partial index on `monitors(next_check_at) WHERE is_active = true AND is_deleted = false`

**Database constraints:**
- `monitors.last_status` CHECK IN ('up', 'down', 'timeout')
- `check_logs.status` CHECK IN ('up', 'down', 'timeout')

**Code standards that apply:**
- Business logic in services, not in the scheduler file
- All queries through `db/` module
- Transactions required when touching more than one table
- `async/await` only
- No `console.log` — but we have no logger yet. For this spec, use `console.error` for errors only. Replace with a proper logger in a future spec.

---

## Dependencies to install

```
cd backend && npm install node-cron
```

`node-cron` over `setInterval` because:
- Runs on a cron expression, won't drift
- Standard for scheduled tasks in Node.js
- Easy to read: `'* * * * *'` = every minute

The backend is Node 24, which has native `fetch` — no HTTP client needed.

---

## Transaction support

The current `db.js` only exports a `query` helper. Inserting a check log AND updating a monitor is a two-table operation — the code standards require a transaction.

Add a `withTransaction` function to `backend/src/config/db.js`:

```js
export const withTransaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};
```

The `callback` receives a `client` object. Use `client.query()` inside the callback instead of the pool-level `query()`. This ensures all queries in the callback run on the same connection within the same transaction.

---

## Files to create

### 1. `backend/src/db/checks.queries.js`

**`insertCheckLog(client, monitorId, checkResult)`**

```sql
INSERT INTO check_logs (monitor_id, status, response_code, response_time_ms, message)
VALUES ($1, $2, $3, $4, $5)
RETURNING *
```

- `client` is the transaction client, not the pool
- `status` is one of: 'up', 'down', 'timeout'
- `response_code` is the HTTP status code (null on timeout/network error)
- `response_time_ms` is the elapsed time (null on timeout)
- `message` is the error message (null on success)

**`findDueMonitors()`**

```sql
SELECT id, url, failure_threshold, consecutive_failures, is_alerted, interval_minutes
FROM monitors
WHERE next_check_at <= NOW()
  AND is_active = true
  AND is_deleted = false
```

Only select the columns the scheduler needs. No `user_id` — the scheduler doesn't care who owns the monitor.

**`updateMonitorAfterCheck(client, monitorId, updates)`**

```sql
UPDATE monitors
SET last_status = $2,
    last_checked_at = NOW(),
    next_check_at = NOW() + ($3 || ' minutes')::interval,
    consecutive_failures = $4,
    is_alerted = $5,
    updated_at = NOW()
WHERE id = $1
```

- `client` is the transaction client
- `$3` is `interval_minutes` cast to a PostgreSQL interval

### 2. `backend/src/services/checks.service.js`

**`runCheck(monitor)`**

This is the core function. It:

1. Sends an HTTP GET to `monitor.url` with a 5-second timeout
2. Measures response time
3. Determines status:
   - 2xx response → `'up'`
   - Non-2xx response (3xx, 4xx, 5xx) → `'down'`
   - Timeout (AbortSignal after 5s) → `'timeout'`
   - Network error (DNS failure, connection refused) → `'down'`
4. Returns a check result object:
   ```js
   {
     status: 'up' | 'down' | 'timeout',
     responseCode: number | null,
     responseTimeMs: number | null,
     message: string | null,
   }
   ```

**`processCheck(monitor)`**

This wraps `runCheck` with the database writes, inside a transaction:

1. Call `runCheck(monitor)` to get the check result
2. Open a transaction via `withTransaction`
3. Insert the check log via `insertCheckLog`
4. Calculate new state:
   - If status is `'up'`:
     - `consecutive_failures = 0`
     - If the monitor was previously alerted (`monitor.is_alerted === true`), set `is_alerted = false` (recovery — future spec will send recovery email here)
   - If status is `'down'` or `'timeout'`:
     - `consecutive_failures = monitor.consecutive_failures + 1`
     - If `consecutive_failures >= monitor.failure_threshold` and `!monitor.is_alerted`, set `is_alerted = true` (alert condition — future spec will send alert email here)
5. Update the monitor via `updateMonitorAfterCheck`

**`checkAllDueMonitors()`**

This is what the scheduler calls:

1. Call `findDueMonitors()` to get all monitors due for a check
2. If none are due, return silently
3. Run `processCheck` for each monitor **concurrently** using `Promise.allSettled`
   - `allSettled` not `all` — one failed check must not block the others
4. Log a summary: how many checked, how many failed (using `console.error` for failures only)

Edge case: if `processCheck` throws (DB error, unexpected crash), `allSettled` catches it. The monitor's `next_check_at` is NOT updated, so it will be retried on the next cycle. This is the correct behavior — a failed processing attempt should not advance the schedule.

### 3. `backend/src/scheduler/index.js`

```js
import cron from 'node-cron';
import { checkAllDueMonitors } from '../services/checks.service.js';

let isRunning = false;

const job = cron.schedule('* * * * *', async () => {
  if (isRunning) return;
  isRunning = true;
  try {
    await checkAllDueMonitors();
  } catch (err) {
    console.error('Scheduler error:', err);
  } finally {
    isRunning = false;
  }
});

export default job;
```

- `isRunning` flag prevents overlapping runs. If a cycle takes longer than 60 seconds, the next trigger is skipped rather than stacking.
- The scheduler is a fire-and-forget background task — it does not expose an API endpoint.

### 4. Start the scheduler — `backend/src/server.js`

Import the scheduler so it starts when the server starts:

```js
import 'dotenv/config';
import app from './app.js';
import './scheduler/index.js';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```

The scheduler does NOT live inside `app.js`. It's not Express middleware or a route — it's a background process that happens to share the same Node.js process. Importing it in `server.js` keeps this boundary clean.

---

## HTTP check details

Use native `fetch` with `AbortSignal.timeout(5000)`:

```js
const startTime = Date.now();
const response = await fetch(monitor.url, {
  method: 'GET',
  signal: AbortSignal.timeout(5000),
  redirect: 'follow',
});
const responseTimeMs = Date.now() - startTime;
```

**Status mapping:**
- `response.ok` (status 200-299) → `'up'`
- `response.status` exists but not ok → `'down'`, `responseCode = response.status`, `message = response.statusText`
- `AbortError` or `TimeoutError` → `'timeout'`, `responseCode = null`, `responseTimeMs = null`, `message = 'Request timed out after 5000ms'`
- Any other error (DNS, connection refused, SSL) → `'down'`, `responseCode = null`, `responseTimeMs = null`, `message = err.message`

**Do NOT:**
- Follow more than 5 redirects (native fetch has a reasonable default)
- Read the response body — we only need the status code and timing
- Set custom headers or User-Agent (keep it simple for MVP)

---

## What this spec does NOT cover

- Sending email alerts (separate alerts spec — `alerts.service.js`)
- Sending recovery emails
- Rate limiting checks per user
- Retry logic for failed DB writes
- Graceful shutdown of the cron job
- Monitoring the scheduler itself (meta-monitoring)

---

## Acceptance criteria

1. A monitor with `next_check_at` in the past gets checked within 60 seconds of server start
2. After a check, `check_logs` has a new row with correct `status`, `response_code`, `response_time_ms`
3. After a check, the monitor's `last_status` matches the check result
4. After a check, `last_checked_at` is updated to now
5. After a check, `next_check_at` is advanced by `interval_minutes`
6. A successful check after failures resets `consecutive_failures` to 0
7. When `consecutive_failures` reaches `failure_threshold`, `is_alerted` is set to `true`
8. `is_alerted` is not set to `true` again on subsequent failures (no duplicate flag)
9. When a down monitor recovers, `is_alerted` is reset to `false`
10. A paused monitor (`is_active = false`) is not checked
11. A deleted monitor (`is_deleted = true`) is not checked
12. If one monitor's check fails to process, other monitors are still checked
13. Overlapping scheduler runs are prevented by the `isRunning` guard
14. The insert + update happen in a transaction — if the update fails, the check log is not left orphaned
