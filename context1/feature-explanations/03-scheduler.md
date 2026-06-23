# The Scheduler (Monitoring Engine)

## What it does

This is the heart of the app. Every minute, a background job wakes up, finds every monitor that's due for a check, sends an HTTP request to each URL, records the result, and updates the monitor's status. If a site has failed enough times in a row, it flags an alert. When it recovers, it clears the flag.

There's no frontend here — it runs entirely on the server, on its own, forever.

---

## The core idea

**How does it know which monitors are due?** Each monitor has a `next_check_at` timestamp. The scheduler just asks: "give me every monitor where `next_check_at` is in the past." After checking one, it sets `next_check_at = now + interval`. That's the whole scheduling mechanism — no per-monitor timers, no in-memory queue. The database *is* the schedule.

This is powerful because it survives restarts. If the server crashes and comes back, the due monitors are still due — nothing was lost, because the schedule lives in the database, not in memory.

---

## How it flows

Every minute:

1. **Find** all monitors where `next_check_at <= now` and they're active and not deleted
2. **Check** each one — an HTTP GET with a 5-second timeout — but only 50 at a time
3. For each result, in a single transaction:
   - **Log** the result into `check_logs`
   - **Update** the monitor: its status, failure count, alert flag, and next check time
4. If any individual check crashes, the others keep going

Separately, once a day at 3 AM, an old-log cleanup runs to stop the history table growing forever.

---

## Visual: the complete flow

### 1. The main loop — what happens every minute

```
  ╔══════════════════════════════════════════════════════════════════════════╗
  ║  node-cron fires every 60 seconds (* * * * *)                          ║
  ╚════════════════════════════╤═════════════════════════════════════════════╝
                               │
                               ▼
                     ┌───────────────────┐
                     │  isRunning check  │
                     └────────┬──────────┘
                              │
                    ┌─────────┴─────────┐
                    │                   │
                  true                false
                    │                   │
                    ▼                   ▼
              ┌──────────┐    ┌──────────────────┐
              │ SKIP tick │    │ isRunning = true  │
              │ (return)  │    └────────┬─────────┘
              └──────────┘             │
                                       ▼
                              ┌──────────────────┐
                              │ checkAllDue       │
                              │ Monitors()        │
                              └────────┬─────────┘
                                       │
                                       ▼
  ╔══════════════════════════════════════════════════════════════════════════╗
  ║  STEP 1 — Find due monitors                                           ║
  ║                                                                        ║
  ║  SELECT id, url, failure_threshold, consecutive_failures,              ║
  ║         is_alerted, interval_minutes                                   ║
  ║  FROM monitors                                                         ║
  ║  WHERE next_check_at <= NOW()                                          ║
  ║    AND is_active = true                                                ║
  ║    AND is_deleted = false                                              ║
  ║                                                      ┌──────────────┐  ║
  ║  Uses partial index for speed ─────────────────────▶ │  PostgreSQL  │  ║
  ║                                                      └──────────────┘  ║
  ╚════════════════════════════╤═════════════════════════════════════════════╝
                               │
                               ▼  returns e.g. 200 due monitors
  ╔══════════════════════════════════════════════════════════════════════════╗
  ║  STEP 2 — Fan out with concurrency control                             ║
  ║                                                                        ║
  ║   pLimit(50) ◄── at most 50 run at the same time                       ║
  ║       │                                                                ║
  ║       ▼                                                                ║
  ║   Promise.allSettled(                                                   ║
  ║     monitors.map(m => limit(() => processCheck(m)))                     ║
  ║   )                                                                    ║
  ║                                                                        ║
  ║   ┌─────────┐ ┌─────────┐ ┌─────────┐       ┌─────────┐              ║
  ║   │ check 1 │ │ check 2 │ │ check 3 │  ...  │check 50 │  ◄─ active   ║
  ║   └─────────┘ └─────────┘ └─────────┘       └─────────┘              ║
  ║   ┌─────────┐ ┌─────────┐                                             ║
  ║   │check 51 │ │check 52 │  ...  waiting in the pLimit queue           ║
  ║   └─────────┘ └─────────┘                                             ║
  ║                                                                        ║
  ║   As a slot frees up, the next queued check starts.                    ║
  ║   One failure does NOT cancel the rest (allSettled, not all).           ║
  ╚════════════════════════════╤═════════════════════════════════════════════╝
                               │
                               │  after all checks settle
                               ▼
                     ┌───────────────────┐
                     │ isRunning = false  │  ◄── finally {} guarantees this
                     └───────────────────┘
```

### 2. Inside each check — `processCheck(monitor)`

This is what runs for every single monitor, inside the concurrency gate:

```
  processCheck(monitor)
         │
         ▼
  ╔══════════════════════════════════════════════════════════════════════════╗
  ║  SSRF GUARD — resolveAndValidate(url)                                  ║
  ║                                                                        ║
  ║  dns.lookup(hostname, { all: true })                                   ║
  ║        │                                                               ║
  ║        ▼                                                               ║
  ║  ┌─────────────────────────────────────────┐                           ║
  ║  │ For EACH resolved IP address:           │                           ║
  ║  │   ipaddr.process(ip).range()            │                           ║
  ║  │   Is it loopback? private? linkLocal?   │                           ║
  ║  │   uniqueLocal? unspecified?             │                           ║
  ║  └──────────────┬──────────────────────────┘                           ║
  ║                 │                                                      ║
  ║          ┌──────┴──────┐                                               ║
  ║       ANY private     ALL public                                       ║
  ║          │                │                                            ║
  ║          ▼                ▼                                            ║
  ║    ┌──────────┐    ┌──────────┐                                        ║
  ║    │  BLOCKED  │    │   SAFE   │                                        ║
  ║    │  skip     │    │  proceed │                                        ║
  ║    └──────────┘    └──────────┘                                        ║
  ╚═══════════╤════════════╤════════════════════════════════════════════════╝
        blocked            safe
              │                │
              ▼                ▼
     return {              ╔═══════════════════════════════════════════════╗
       status: 'down',     ║  HTTP CHECK — runCheck(url)                  ║
       message: 'SSRF      ║                                              ║
         blocked'          ║  fetch(url, {                                ║
     }                     ║    method: 'GET',                            ║
                           ║    signal: AbortSignal.timeout(5000),        ║
                           ║    redirect: 'follow'                        ║
                           ║  })                                          ║
                           ║         │                                    ║
                           ║    ┌────┴────────────────┐                   ║
                           ║    │                     │                   ║
                           ║  success              catch (error)          ║
                           ║    │                     │                   ║
                           ║    ▼                     ▼                   ║
                           ║  cancel body      ┌──────────────┐          ║
                           ║  (free socket)     │ AbortError?  │          ║
                           ║    │              └──────┬───────┘          ║
                           ║    │              yes    │    no            ║
                           ║    │               │     │     │            ║
                           ║    ▼               ▼     │     ▼            ║
                           ║ ┌────────┐  ┌─────────┐ │ ┌─────────┐     ║
                           ║ │response│  │'timeout' │ │ │ 'down'  │     ║
                           ║ │.ok ?   │  └─────────┘ │ │ DNS fail│     ║
                           ║ └───┬────┘              │ │ refused │     ║
                           ║  yes│  no               │ └─────────┘     ║
                           ║     ▼    ▼              │                  ║
                           ║  'up'  'down'            │                  ║
                           ╚═══╤══════╤═══════╤══════╤══════════════════╝
                               │      │       │      │
                               ▼      ▼       ▼      ▼
                           ┌──────────────────────────────┐
                           │  checkResult = {              │
                           │    status,                    │
                           │    responseCode (or null),    │
                           │    responseTimeMs,            │
                           │    message                    │
                           │  }                            │
                           └──────────────┬───────────────┘
                                          │
                                          ▼
  ╔══════════════════════════════════════════════════════════════════════════╗
  ║  STATE MACHINE + TRANSACTION                                           ║
  ║                                                                        ║
  ║  withTransaction(async (client) => {                                   ║
  ║                                                                        ║
  ║    ┌─────────────────────────────────────────────┐                     ║
  ║    │ WRITE 1: INSERT INTO check_logs             │                     ║
  ║    │   (monitor_id, status, response_code,       │                     ║
  ║    │    response_time_ms, message, checked_at)   │                     ║
  ║    └─────────────────────────────────────────────┘                     ║
  ║                                                                        ║
  ║    ┌─────────────────────────────────────────────┐                     ║
  ║    │ STATE MACHINE: decide new monitor state     │                     ║
  ║    │                                             │                     ║
  ║    │   Was the check UP or DOWN/TIMEOUT?         │                     ║
  ║    │                                             │                     ║
  ║    │      UP                    DOWN / TIMEOUT   │                     ║
  ║    │       │                         │           │                     ║
  ║    │       ▼                         ▼           │                     ║
  ║    │  failures = 0          failures += 1        │                     ║
  ║    │                                             │                     ║
  ║    │  was alerted?     failures >= threshold     │                     ║
  ║    │    yes → clear       AND not yet alerted?   │                     ║
  ║    │    (recovery)          yes → set alerted    │                     ║
  ║    │                        (new incident)       │                     ║
  ║    │                        no  → stay as-is     │                     ║
  ║    │                        (already alerting)   │                     ║
  ║    └─────────────────────────────────────────────┘                     ║
  ║                                                                        ║
  ║    ┌─────────────────────────────────────────────┐                     ║
  ║    │ WRITE 2: UPDATE monitors SET                │                     ║
  ║    │   last_status         = 'up' / 'down'       │                     ║
  ║    │   last_checked_at     = NOW()               │                     ║
  ║    │   consecutive_failures = new count           │                     ║
  ║    │   is_alerted          = true / false         │                     ║
  ║    │   next_check_at       = NOW() + interval    │ ◄── reschedule     ║
  ║    └─────────────────────────────────────────────┘                     ║
  ║                                                                        ║
  ║  }) ◄── COMMIT: both writes succeed, or ROLLBACK: neither does         ║
  ╚══════════════════════════════════════════════════════════════════════════╝
```

### 3. The state machine up close

How `consecutive_failures` and `is_alerted` evolve over a real sequence of checks:

```
  Check #    Result    failures   is_alerted   What happened
  ───────    ──────    ────────   ──────────   ──────────────────────────
     1        UP          0        false       Normal — site is fine
     2        DOWN        1        false       First failure, keep watching
     3        DOWN        2        false → true  Hit threshold (2) → ALERT
     4        DOWN        3        true        Still down, no duplicate alert
     5        DOWN        4        true        Still down, still no alert
     6        UP          0        true → false  Recovered → CLEAR ALERT
     7        UP          0        false       Normal again
```

Key rules:
- Alert fires **once** when `failures >= threshold` AND `is_alerted` is still `false`
- Every subsequent DOWN check: counter goes up, but no new alert
- The **first UP** after alerting: counter resets to 0, `is_alerted` clears (recovery)
- One alert per incident. One recovery per incident. No spam.

### 4. The retention cleanup — separate job

```
  ╔═══════════════════════════════════════════════════════════════╗
  ║  node-cron fires daily at 3:00 AM (0 3 * * *)               ║
  ╚══════════════════════════╤════════════════════════════════════╝
                             │
                             ▼
                   ┌───────────────────────┐
                   │ DELETE FROM check_logs │
                   │ WHERE checked_at      │
                   │   < NOW() - 30 days   │
                   └───────────────────────┘
                             │
                             ▼
                   Prevents unbounded table growth.
                   Runs at a quiet hour to avoid
                   competing with live checks.
```

### 5. Putting it all together — one-page overview

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │                         SERVER PROCESS                              │
  │                                                                     │
  │  ┌──────────────────────────────────────────────────────────────┐   │
  │  │  CRON JOB 1: every minute                                   │   │
  │  │                                                              │   │
  │  │  if (isRunning) skip ─────────────── prevents overlap        │   │
  │  │         │                                                    │   │
  │  │         ▼                                                    │   │
  │  │  findDueMonitors() ──────────────── PostgreSQL query         │   │
  │  │         │                                                    │   │
  │  │         ▼                                                    │   │
  │  │  pLimit(50) + Promise.allSettled ── controlled concurrency   │   │
  │  │         │                                                    │   │
  │  │         ├── processCheck(monitor1)                           │   │
  │  │         │      │                                             │   │
  │  │         │      ├── resolveAndValidate(url) ── SSRF guard     │   │
  │  │         │      ├── fetch(url, 5s timeout) ─── HTTP check     │   │
  │  │         │      ├── body.cancel() ──────────── free socket    │   │
  │  │         │      │                                             │   │
  │  │         │      └── withTransaction ────────── atomic write   │   │
  │  │         │            ├── INSERT check_logs        (log)      │   │
  │  │         │            ├── state machine        (decide)       │   │
  │  │         │            └── UPDATE monitors    (reschedule)     │   │
  │  │         │                                                    │   │
  │  │         ├── processCheck(monitor2) ── same flow              │   │
  │  │         ├── processCheck(monitor3)                           │   │
  │  │         └── ...                                              │   │
  │  │                                                              │   │
  │  └──────────────────────────────────────────────────────────────┘   │
  │                                                                     │
  │  ┌──────────────────────────────────────────────────────────────┐   │
  │  │  CRON JOB 2: daily at 3 AM                                  │   │
  │  │                                                              │   │
  │  │  DELETE check_logs older than 30 days ── retention cleanup   │   │
  │  └──────────────────────────────────────────────────────────────┘   │
  │                                                                     │
  └──────────────┬──────────────────────────────────┬───────────────────┘
                 │                                  │
                 ▼                                  ▼
          ┌──────────────┐                   ┌──────────────┐
          │  PostgreSQL   │                   │   Internet   │
          │              │                   │              │
          │  monitors    │                   │  target URLs │
          │  check_logs  │                   │  (HTTP GET)  │
          └──────────────┘                   └──────────────┘
```

---

## The files

| File | What it owns |
|------|--------------|
| `scheduler/index.js` | The two cron jobs (checks every minute, cleanup daily) |
| `services/checks.service.js` | The logic: run a check, decide the new state, coordinate |
| `db/checks.queries.js` | The SQL: find due, insert log, update monitor |
| `db/retention.queries.js` | The cleanup query |
| `utils/url-safety.js` | SSRF guard (its own file) |

---

## The code, explained

### The cron job — `scheduler/index.js`

```js
let isRunning = false;

cron.schedule('* * * * *', async () => {
  if (isRunning) return;       // skip if the last run hasn't finished
  isRunning = true;
  try {
    await checkAllDueMonitors();
  } catch (err) {
    console.error('Scheduler error:', err);
  } finally {
    isRunning = false;
  }
});
```

`'* * * * *'` is cron for "every minute." The `isRunning` flag is the important part: if a run takes longer than 60 seconds (lots of slow sites), the next tick would overlap with the one still going — double-checking everything. The flag says "if I'm already working, skip this tick." `finally` guarantees the flag resets even if something throws, so the scheduler can't get permanently stuck.

```js
cron.schedule('0 3 * * *', async () => {
  const deleted = await deleteExpiredCheckLogs();
});
```

A second job at `'0 3 * * *'` (3:00 AM daily) deletes old logs. Run cleanup at a quiet hour so it doesn't compete with peak traffic.

### Finding due monitors — `findDueMonitors`

```js
export const findDueMonitors = async () => {
  const result = await query(
    `SELECT id, url, failure_threshold, consecutive_failures, is_alerted, interval_minutes
     FROM monitors
     WHERE next_check_at <= NOW()
       AND is_active = true
       AND is_deleted = false`
  );
  return result.rows;
};
```

One query gets the whole batch. The `WHERE` filters out paused (`is_active = false`) and deleted monitors. There's a partial database index on exactly this condition, so even with millions of rows it stays fast. We select only the columns the check logic needs — nothing more.

### Running one check — `runCheck`

```js
const response = await fetch(url, {
  method: 'GET',
  signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),   // 5s cap
  redirect: 'follow',
});

const responseTimeMs = Date.now() - startTime;
await response.body?.cancel();                       // release the socket

if (response.ok) return { status: 'up', responseCode: response.status, ... };
return { status: 'down', responseCode: response.status, ... };
```

A few deliberate choices:
- `AbortSignal.timeout(5000)` — a dead site must not hang the check forever. After 5 seconds we give up and call it a timeout.
- `response.body?.cancel()` — we only care about the status code, not the page content. Cancelling the body releases the network connection immediately instead of leaving it half-open (which would leak sockets over time).
- The `catch` block sorts failures: a timeout becomes `'timeout'`, anything else (DNS failure, refused connection) becomes `'down'`. We never throw — every outcome maps to a clean status.

### The decision + write — `processCheck`

```js
export const processCheck = async (monitor) => {
  const checkResult = await runCheck(monitor.url);

  await withTransaction(async (client) => {
    await insertCheckLog(client, monitor.id, checkResult);

    let consecutiveFailures = monitor.consecutive_failures;
    let isAlerted = monitor.is_alerted;

    if (checkResult.status === 'up') {
      consecutiveFailures = 0;
      if (isAlerted) isAlerted = false;            // recovered
    } else {
      consecutiveFailures += 1;
      if (consecutiveFailures >= monitor.failure_threshold && !isAlerted) {
        isAlerted = true;                          // crossed the threshold
      }
    }

    await updateMonitorAfterCheck(client, monitor.id, { ... });
  });
};
```

This is a small **state machine**. On success: reset the failure count, and if we were alerting, mark recovery. On failure: increment, and if we've hit the threshold *and haven't already alerted*, raise the flag.

That `&& !isAlerted` is what prevents alert spam — once we've alerted for an incident, we don't re-alert on every subsequent failed check. One alert per incident.

The whole thing runs inside `withTransaction`. Inserting the log and updating the monitor are **two writes that must both succeed or both fail**. If the log saved but the update crashed, the monitor would look unchecked while a log says otherwise — inconsistent data. The transaction makes them atomic: all or nothing.

### Why `next_check_at = NOW() + interval`

```js
next_check_at = NOW() + ($3 || ' minutes')::interval
```

After each check, the next one is scheduled. We compute it in SQL using the database's clock, not the app's, so all timestamps are consistent regardless of which server ran the check.

### The concurrency limit — `checkAllDueMonitors`

```js
const limit = pLimit(MAX_CONCURRENT_CHECKS);   // 50

const results = await Promise.allSettled(
  dueMonitors.map((monitor) => limit(() => processCheck(monitor)))
);
```

This is the most important scaling line. Without `pLimit`, `map` would fire *all* due monitors at once — 5,000 monitors = 5,000 simultaneous HTTP requests and database connections, which crashes the process. `pLimit(50)` gates it: at most 50 run concurrently, the rest queue and start as slots free up. Same total work, controlled resource usage.

`Promise.allSettled` (not `Promise.all`) is also deliberate: `all` rejects the instant *one* check fails, abandoning the rest. `allSettled` waits for every check regardless of individual failures — one broken site can't stop the others from being monitored.

---

## Lessons worth keeping

**1. Store the schedule in the database, not in memory.**
Using `next_check_at` instead of in-process timers means the system survives crashes and restarts with zero lost work. State that matters should live somewhere durable. In-memory schedules vanish when the process dies.

**2. Always cap concurrency on bulk work.**
Firing N operations at once where N is unbounded is a crash waiting to happen. A concurrency limit (`pLimit`) gives you the same throughput without exhausting sockets, memory, or DB connections. **Never `map` an unbounded list straight into `Promise.all` for real I/O.**

**3. `allSettled` for independent tasks, `all` for dependent ones.**
If each task stands alone (checking different sites), use `allSettled` so one failure doesn't kill the batch. Only use `all` when you genuinely need every task to succeed together.

**4. Wrap multi-step writes in a transaction.**
Whenever one logical action touches more than one table (log + update), a transaction makes them atomic. Without it, a mid-way crash leaves your data in a contradictory state that's painful to debug later.

**5. Prevent overlapping runs of a scheduled job.**
A simple `isRunning` guard stops a slow run from colliding with the next tick. Many scheduling bugs are really "the job ran twice at once." Guard against it explicitly.

**6. Always time-box external calls.**
A check without a timeout can hang forever on a dead host, and one stuck call ties up a concurrency slot. `AbortSignal.timeout` ensures every call ends in bounded time, success or fail.

**7. Clean up resources you don't need.**
Cancelling the response body releases sockets immediately. Under high volume, "small leaks" become outages. Release what you borrow — connections, file handles, memory.

**8. Bound your data growth from day one.**
The history table would grow forever without the daily cleanup. Any table that gets a row per event needs a retention plan, or it eventually becomes your biggest problem. Decide how long data lives *before* it piles up.

**9. Model alert logic as a state machine.**
"Alert once when crossing the threshold, clear on recovery, don't repeat" is a tiny state machine. Tracking `consecutive_failures` + `is_alerted` turns a fuzzy requirement into precise, testable rules. Notification systems live or die on not spamming — make the states explicit.
