# 13 — Time-Series Rollups + Tiered Retention (Phase 4)

> System-design phase 4 of `system-design-roadmap.md`. This spec adds
> pre-computed daily summaries (`check_rollups`) so the uptime bar, uptime
> percentage, and response-time stats read from 30 rows instead of scanning
> the full `check_logs` table. It also enforces tiered retention: raw logs
> kept for 30 days, rollups kept indefinitely.

## What this covers

The monitor detail page currently computes stats by scanning every row in
`check_logs` on every request:

```sql
SELECT COUNT(*), AVG(response_time_ms), COUNT(*) FILTER (WHERE status = 'up') ...
FROM check_logs WHERE monitor_id = $1
```

With 1,000 monitors at 5-minute intervals, that's 288 rows per monitor per day,
~8,600 per month, millions per year. The aggregate gets slower as the table
grows, and the table grows without bound.

This spec fixes both problems:

1. **Rollup job** — a background task that runs hourly and writes one summary
   row per monitor per day into a `check_rollups` table. The detail page and
   future uptime bar read from rollups (30 rows for 30 days) instead of
   scanning raw logs.
2. **Tiered retention** — raw `check_logs` are kept for 30 days (already
   implemented in `retention.queries.js`). Rollups are kept indefinitely. After
   30 days, the raw data is gone but the daily summaries remain — so 90-day and
   yearly uptime percentages stay queryable forever.

### What this teaches

- Time-series aggregation (raw rows → bucketed summaries)
- Rollup jobs (periodic background materialization)
- Tiered retention (different lifetimes for different granularities)
- The tradeoff between query-time aggregation and write-time pre-computation

---

## Existing state this spec builds on

**Backend has:**
- `check_logs` table: `monitor_id`, `status`, `response_code`,
  `response_time_ms`, `message`, `checked_at`, `job_id`
- Index: `check_logs_monitor_id_checked_at_idx` on `(monitor_id, checked_at)`
- `getCheckStats(monitorId)` in `checks.queries.js` — scans all `check_logs`
  for a monitor to compute `total_checks`, `avg_response_ms`, `up_count`,
  `down_count`, `timeout_count`. This is the query rollups replace.
- `monitors.service.js` — `getMonitorDetail` calls `getCheckStats` and caches
  the result (Phase 2 cache, 60s TTL)
- `retention.queries.js` — `deleteExpiredCheckLogs()` deletes logs older than
  30 days, runs at 3 AM daily in `worker.js`
- `worker.js` — runs the dispatcher cron, the retention cron, the BullMQ
  worker, and the event consumers

---

## Migration — create `check_rollups` table

`src/db/migrations/1750000000004_check-rollups.js`

```js
export const up = (pgm) => {
  pgm.createTable('check_rollups', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    monitor_id: { type: 'uuid', notNull: true, references: 'monitors(id)', onDelete: 'CASCADE' },
    date: { type: 'date', notNull: true },
    total_checks: { type: 'integer', notNull: true, default: 0 },
    up_count: { type: 'integer', notNull: true, default: 0 },
    down_count: { type: 'integer', notNull: true, default: 0 },
    timeout_count: { type: 'integer', notNull: true, default: 0 },
    avg_response_ms: { type: 'integer' },
    min_response_ms: { type: 'integer' },
    max_response_ms: { type: 'integer' },
  });

  pgm.addConstraint('check_rollups', 'check_rollups_monitor_date_unique',
    'UNIQUE(monitor_id, date)');
};

export const down = (pgm) => {
  pgm.dropTable('check_rollups');
};
```

One row per monitor per day. The `UNIQUE(monitor_id, date)` constraint ensures
the rollup job can use `ON CONFLICT ... DO UPDATE` (upsert) — re-running the
job for the same day overwrites rather than duplicates, making the job
idempotent and self-healing.

Columns:
- `total_checks` — total check count for the day
- `up_count`, `down_count`, `timeout_count` — status breakdown
- `avg_response_ms`, `min_response_ms`, `max_response_ms` — response time
  summary (null if all checks were timeouts/errors with no response)

---

## Files to create

### 1. `db/rollups.queries.js` — rollup write + read

**`upsertDailyRollup(monitorId, date, stats)`**

```sql
INSERT INTO check_rollups
  (monitor_id, date, total_checks, up_count, down_count, timeout_count,
   avg_response_ms, min_response_ms, max_response_ms)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (monitor_id, date)
DO UPDATE SET
  total_checks = EXCLUDED.total_checks,
  up_count = EXCLUDED.up_count,
  down_count = EXCLUDED.down_count,
  timeout_count = EXCLUDED.timeout_count,
  avg_response_ms = EXCLUDED.avg_response_ms,
  min_response_ms = EXCLUDED.min_response_ms,
  max_response_ms = EXCLUDED.max_response_ms
```

`ON CONFLICT ... DO UPDATE` makes this an upsert — the job can run multiple
times for the same day and the result is always correct (idempotent). This is
key: if the job crashes halfway through, re-running it fixes the partial state
instead of creating duplicates.

**`computeDailyStats(monitorId, date)`**

```sql
SELECT
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
  AND checked_at < ($2::date + interval '1 day')
```

Aggregates one day of raw `check_logs` for one monitor. Used by the rollup job.

**`getRollupsByMonitor(monitorId, days)`**

```sql
SELECT date, total_checks, up_count, down_count, timeout_count,
       avg_response_ms, min_response_ms, max_response_ms
FROM check_rollups
WHERE monitor_id = $1
  AND date >= CURRENT_DATE - ($2 || ' days')::interval
ORDER BY date ASC
```

Returns the last N days of rollups for the detail page and uptime bar. 30 rows
for 30 days — always fast regardless of how many raw `check_logs` exist.

**`getUptimePercentage(monitorId, days)`**

```sql
SELECT
  COALESCE(SUM(total_checks), 0)::int AS total,
  COALESCE(SUM(up_count), 0)::int AS up
FROM check_rollups
WHERE monitor_id = $1
  AND date >= CURRENT_DATE - ($2 || ' days')::interval
```

Returns the two numbers needed to compute uptime %: `up / total * 100`. Done
in the service layer, not SQL, so the caller controls rounding and edge cases
(e.g., total = 0).

### 2. `jobs/rollupJob.js` — the rollup background job

```js
import { query } from '../config/db.js';
import { computeDailyStats, upsertDailyRollup } from '../db/rollups.queries.js';
```

**`runRollupJob()`**

1. Get all active, non-deleted monitor IDs:
   `SELECT id FROM monitors WHERE is_active = true AND is_deleted = false`
2. Determine which dates to roll up. On a normal hourly run, roll up **today**
   and **yesterday** (yesterday catches any late-arriving checks from around
   midnight; today gives a partial-day running total):
   ```js
   const today = new Date().toISOString().slice(0, 10);
   const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
   const dates = [yesterday, today];
   ```
3. For each monitor × each date: `computeDailyStats` → `upsertDailyRollup`.
4. Log how many rollups were written.

The job is idempotent (upsert) so running it more than once for the same
date is safe — it overwrites with the correct values.

**Backfill:** On first deploy (or if rollups are empty), a one-time backfill
function rolls up all historical dates from `check_logs`:

```js
export const backfillRollups = async () => {
  const dates = await query(
    `SELECT DISTINCT DATE(checked_at) AS date FROM check_logs ORDER BY date`
  );
  // for each date × each monitor: computeDailyStats → upsertDailyRollup
};
```

Called manually or on first run if the `check_rollups` table is empty.

---

## Files to change

### `worker.js` — add the rollup cron

Add an hourly cron job alongside the existing minute (dispatcher) and daily
(retention) jobs:

```js
import { runRollupJob } from './jobs/rollupJob.js';

const rollupTask = cron.schedule('5 * * * *', async () => {
  try {
    await runRollupJob();
  } catch (err) {
    console.error('Rollup job error:', err);
  }
});
```

`'5 * * * *'` = minute 5 of every hour. Offset from the top of the hour so it
doesn't collide with the dispatcher tick. Stop it in `shutdown()`.

### `monitors.service.js` — swap `getCheckStats` for rollups

**`getMonitorDetail`** currently calls `getCheckStats` (scans raw `check_logs`).
Replace it with rollup reads:

```js
import { getRollupsByMonitor, getUptimePercentage } from '../db/rollups.queries.js';

export const getMonitorDetail = async (monitorId, userId) => {
  // ... existing cache-aside + ownership check ...

  const rollups = await getRollupsByMonitor(monitorId, 30);
  const uptimeData = await getUptimePercentage(monitorId, 30);
  const uptimePercent = uptimeData.total > 0
    ? ((uptimeData.up / uptimeData.total) * 100).toFixed(2)
    : null;

  const result = {
    ...monitor,
    stats: { rollups, uptimePercent, totalChecks: uptimeData.total },
  };

  await setCachedMonitorDetail(monitorId, result);
  return result;
};
```

The `stats` shape changes — the frontend detail page will need to read
`stats.rollups` (array of daily summaries), `stats.uptimePercent` (string like
`"99.87"`), and `stats.totalChecks` (integer).

### `checks.queries.js` — keep `getCheckStats` but stop using it from the service

`getCheckStats` remains available (it's useful for ad-hoc queries and the
backfill) but `monitors.service.js` no longer calls it for the detail page.

### `db/schema.js` — add `check_rollups` to the reference

```js
check_rollups: {
  id:               'uuid      PK  gen_random_uuid()',
  monitor_id:       'uuid      NOT NULL  FK → monitors.id  ON DELETE CASCADE',
  date:             'date      NOT NULL',
  total_checks:     'integer   NOT NULL  default 0',
  up_count:         'integer   NOT NULL  default 0',
  down_count:       'integer   NOT NULL  default 0',
  timeout_count:    'integer   NOT NULL  default 0',
  avg_response_ms:  'integer   nullable',
  min_response_ms:  'integer   nullable',
  max_response_ms:  'integer   nullable',
  _constraints: ['UNIQUE(monitor_id, date)'],
},
```

### Frontend — update StatsRow to use new stats shape

`StatsRow` currently reads `stats.avg_response_ms` and `stats.total_checks`.
Update to read from `stats.uptimePercent` and `stats.totalChecks`. The avg
response time can be computed from the latest rollup entry or from the rollups
array.

---

## How the data flows after this spec

```
Every 5 min:  worker runs check → writes to check_logs (raw)
Every hour:   rollup job reads check_logs → writes to check_rollups (summary)
Every day:    retention job deletes check_logs older than 30 days

Detail page reads:
  stats.rollups        ← from check_rollups (30 rows, always fast)
  stats.uptimePercent  ← from check_rollups (one SUM query)
  check history table  ← from check_logs (paginated, indexed, recent data only)
```

After 30 days, raw `check_logs` rows are deleted, but `check_rollups` rows
remain — so the 90-day uptime percentage stays accurate even though the
individual check-by-check detail is gone.

---

## What this spec does NOT cover

- Uptime bar UI component (the visual 30/90-day strip) — separate UI spec that
  reads from `stats.rollups`
- Response time line chart — separate UI spec that reads from `stats.rollups`
- Hourly rollup granularity (daily is sufficient for the uptime bar and stats;
  hourly would be needed for zoomed-in graphs — deferred)
- Table partitioning on `check_logs` by date (the daily `DELETE` retention is
  sufficient; partitioning would let us `DROP PARTITION` instead of row-by-row
  delete — a future optimization, not forced by a current requirement)

---

## Acceptance criteria

1. Migration creates `check_rollups` with `UNIQUE(monitor_id, date)`
2. The rollup job computes daily stats from `check_logs` and upserts into
   `check_rollups` — running it twice for the same day produces the same result
   (idempotent)
3. `GET /api/monitors/:id` returns `stats.rollups` (array of daily summaries),
   `stats.uptimePercent`, and `stats.totalChecks` — read from `check_rollups`,
   not raw `check_logs`
4. The rollup job runs every hour at minute 5 in the worker process
5. Backfill function populates rollups for all historical dates in `check_logs`
6. After 30-day retention deletes raw logs, rollups remain — uptime % for older
   periods is still accurate
7. The detail page stats card shows uptime percentage (e.g., "99.87%")
8. `check_rollups` rows are deleted when a monitor is deleted (`ON DELETE CASCADE`)
