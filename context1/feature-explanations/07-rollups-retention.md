# Phase 4: Rollups and Retention (Handling Data That Never Stops Growing)

## What it does

Every 5 minutes, every monitor generates a check log row. One monitor = 288 rows/day. 100 monitors = 28,800 rows/day. After a year, that's 10.5 million rows per 100 monitors.

Two problems hit at the same time:
1. **Graphs get slow.** The uptime chart needs to aggregate 30 days of data. Scanning 8,640 rows (one monitor, one month) for every page load is expensive. With 100 monitors, it's 864,000 rows.
2. **Storage grows forever.** Without cleanup, the `check_logs` table grows without bound.

Phase 4 solves both with two mechanisms:
- **Rollups** — pre-aggregate raw check logs into daily summary rows. The chart reads 30 rows instead of 8,640.
- **Retention** — delete raw logs older than 30 days. Keep rollups forever (they're tiny).

---

## The core idea

Think of a bank statement.

Your bank records every transaction (coffee $4.50, gas $45.00, rent $1200). That's the raw data. But when you look at your monthly summary, you don't see every transaction — you see **totals**: spent $3,200, income $5,000, savings $1,800.

The raw transactions are the `check_logs`. The monthly summary is the `check_rollups`. You need the raw transactions for 30 days (in case of disputes). After that, the summary is enough.

---

## How it flows

### Rollup job (runs hourly)

```
Every hour at :05
        │
        ▼
  ┌────────────────────────────────┐
  │ For each active monitor:       │
  │   For yesterday AND today:     │
  │     1. COUNT all checks        │
  │     2. COUNT up/down/timeout   │
  │     3. AVG response time       │
  │     4. MIN/MAX response time   │
  │     5. Store in check_rollups  │
  └────────────────────────────────┘
```

### Retention job (runs daily at 3 AM)

```
Every day at 3:00 AM
        │
        ▼
  ┌──────────────────────────────────┐
  │ DELETE FROM check_logs           │
  │ WHERE checked_at < 30 days ago   │
  └──────────────────────────────────┘
```

### What stays, what goes

```
Day 1 ─────────── raw logs (288 rows) + rollup (1 row)
Day 2 ─────────── raw logs (288 rows) + rollup (1 row)
...
Day 30 ────────── raw logs (288 rows) + rollup (1 row)
Day 31 ────────── rollup only (raw logs deleted)
Day 32 ────────── rollup only
...
Day 365 ───────── rollup only

Raw logs: always ~8,640 rows per monitor (bounded at 30 days)
Rollups:  always growing, but only 1 row/day/monitor (tiny)
```

---

## The files

| File | Role |
|------|------|
| `backend/src/db/rollups.queries.js` | Compute daily stats, upsert rollup, read rollups |
| `backend/src/jobs/rollupJob.js` | The hourly job that creates/updates rollups |
| `backend/src/db/retention.queries.js` | Delete old check logs |
| `backend/src/worker.js` | Schedules both jobs via node-cron |

---

## The code, explained

### Computing a daily rollup

```javascript
// backend/src/db/rollups.queries.js

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
```

One query compresses 288 rows into 7 numbers: total, up, down, timeout, avg, min, max. That's the rollup.

The `FILTER (WHERE ...)` syntax is Postgres-specific. It counts only rows matching the condition. Much cleaner than `CASE WHEN ... THEN 1 ELSE 0 END`.

### Storing the rollup (upsert)

```javascript
export const upsertDailyRollup = async (monitorId, date, stats) => {
  await query(
    `INSERT INTO check_rollups
       (monitor_id, date, total_checks, up_count, down_count, timeout_count,
        avg_response_ms, min_response_ms, max_response_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (monitor_id, date)
     DO UPDATE SET
       total_checks = EXCLUDED.total_checks,
       up_count = EXCLUDED.up_count,
       ...`,
    [monitorId, date, stats.total_checks, stats.up_count, ...]
  );
};
```

**Why upsert (ON CONFLICT DO UPDATE)?**

The rollup for "today" is partial — the day isn't over yet. Every hour, we recompute it with the latest data. The first run inserts. Subsequent runs update the same row with new totals.

Without upsert, you'd need to check if the row exists, then INSERT or UPDATE. That's two queries and a race condition. Upsert does it in one atomic query.

`EXCLUDED` refers to the values you tried to insert. So `total_checks = EXCLUDED.total_checks` means "replace the existing value with the new one."

### The rollup job

```javascript
// backend/src/jobs/rollupJob.js

export const runRollupJob = async () => {
  const monitors = await query(
    'SELECT id FROM monitors WHERE is_active = true AND is_deleted = false'
  );

  const today = new Date().toISOString().slice(0, 10);      // "2026-06-28"
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const dates = [yesterday, today];

  for (const monitor of monitors.rows) {
    for (const date of dates) {
      const stats = await computeDailyStats(monitor.id, date);
      if (stats.total_checks === 0) continue;   // No checks that day — skip
      await upsertDailyRollup(monitor.id, date, stats);
    }
  }
};
```

**Why recompute BOTH yesterday and today?**

- **Today** is partial. Recomputing adds the latest checks since the last run.
- **Yesterday** might have been missed if the job failed at midnight. Since upsert is safe to repeat, recomputing yesterday is cheap insurance.

**Why skip when `total_checks === 0`?**

No point creating a rollup row that says "0 checks, 0% uptime." It would clutter the chart with empty days. The frontend handles missing days by showing gray ticks.

### Reading rollups for the chart

```javascript
export const getRollupsByMonitor = async (monitorId, days) => {
  const result = await query(
    `SELECT date, total_checks, up_count, down_count, timeout_count,
            avg_response_ms, min_response_ms, max_response_ms
     FROM check_rollups
     WHERE monitor_id = $1
       AND date >= CURRENT_DATE - ($2 || ' days')::interval
     ORDER BY date ASC`,
    [monitorId, String(days)]
  );
  return result.rows;
};
```

30 days = 30 rows max. The uptime bar and response time chart both read from this. No matter how many checks exist, the query is always fast.

### Retention (deleting old raw data)

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

Simple but critical. Without this, `check_logs` grows by ~28,800 rows/day for 100 monitors. After a year, that's 10.5 million rows. The DELETE keeps it bounded at ~864,000 rows (30 days).

### Scheduling both jobs

```javascript
// backend/src/worker.js

// Rollups: every hour at :05 (after checks have run at :00)
const rollupTask = cron.schedule('5 * * * *', async () => {
  await runRollupJob();
});

// Retention: once a day at 3 AM (low traffic period)
const retentionTask = cron.schedule('0 3 * * *', async () => {
  await deleteExpiredCheckLogs();
});
```

Rollups run at `:05` (not `:00`) to avoid competing with the dispatcher, which runs at `:00`. Retention runs at 3 AM because deleting thousands of rows is heavy — do it when nobody is using the app.

### Backfill utility

```javascript
// backend/src/jobs/rollupJob.js

export const backfillRollups = async () => {
  const dates = await query(
    'SELECT DISTINCT DATE(checked_at) AS date FROM check_logs ORDER BY date'
  );

  const monitors = await query('SELECT id FROM monitors WHERE is_deleted = false');

  for (const monitor of monitors.rows) {
    for (const { date } of dates.rows) {
      const stats = await computeDailyStats(monitor.id, dateStr);
      if (stats.total_checks === 0) continue;
      await upsertDailyRollup(monitor.id, dateStr, stats);
    }
  }
};
```

For when you deploy rollups for the first time. You already have weeks of raw check logs but no rollup rows. This function creates rollups for all historical data in one shot. Run it once, then the hourly job keeps them current.

---

## Lessons worth keeping

1. **Pre-aggregate reads you'll repeat.** If a query scans thousands of rows and the result only changes hourly, compute it once and store the summary. This is what every analytics dashboard does (Datadog, Google Analytics, Mixpanel).

2. **Upsert makes recomputation safe.** Because of `ON CONFLICT DO UPDATE`, you can run the rollup job twice for the same day without creating duplicates or corrupting data. Idempotent jobs are worry-free jobs.

3. **Tiered retention matches business needs.** Raw data (every check) is useful for debugging recent issues. Summaries (daily rollups) are useful for long-term trends. You don't need per-check granularity from 6 months ago.

4. **Schedule heavy operations during low traffic.** Retention deletes thousands of rows. Run it at 3 AM, not during peak hours. Same principle as database migrations.

5. **The size math matters.** Before building, calculate: 288 rows/day × 1000 monitors × 365 days = 105 million rows. With retention: 288 × 1000 × 30 = 8.6 million (bounded). With rollups: reads scan 30 rows instead of 8,640. Know your numbers.
