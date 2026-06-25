import { query } from '../config/db.js';

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
       down_count = EXCLUDED.down_count,
       timeout_count = EXCLUDED.timeout_count,
       avg_response_ms = EXCLUDED.avg_response_ms,
       min_response_ms = EXCLUDED.min_response_ms,
       max_response_ms = EXCLUDED.max_response_ms`,
    [
      monitorId, date,
      stats.total_checks, stats.up_count, stats.down_count, stats.timeout_count,
      stats.avg_response_ms, stats.min_response_ms, stats.max_response_ms,
    ]
  );
};

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

export const getUptimePercentage = async (monitorId, days) => {
  const result = await query(
    `SELECT
       COALESCE(SUM(total_checks), 0)::int AS total,
       COALESCE(SUM(up_count), 0)::int AS up
     FROM check_rollups
     WHERE monitor_id = $1
       AND date >= CURRENT_DATE - ($2 || ' days')::interval`,
    [monitorId, String(days)]
  );
  return result.rows[0];
};
