import { query } from '../config/db.js';

// Claim due monitors and advance their schedule in one atomic statement.
// FOR UPDATE SKIP LOCKED lets N dispatchers split the work instead of
// duplicating it; advancing next_check_at here means a claimed monitor is not
// re-selected on the next tick. The dispatcher owns next_check_at now — the
// worker no longer touches it, because BullMQ owns retry of unfinished checks.
export const claimDueMonitors = async (limit) => {
  const result = await query(
    `UPDATE monitors AS m
     SET next_check_at = NOW() + (m.interval_minutes || ' minutes')::interval,
         updated_at = NOW()
     FROM (
       SELECT id FROM monitors
       WHERE next_check_at <= NOW()
         AND is_active = true
         AND is_deleted = false
       ORDER BY next_check_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     ) AS due
     WHERE m.id = due.id
     RETURNING m.id, m.url, m.failure_threshold, m.consecutive_failures, m.is_alerted`,
    [limit]
  );
  return result.rows;
};

// Idempotent on job_id: a retried delivery of the same job inserts nothing and
// returns null, so processCheck can skip the state update.
export const insertCheckLog = async (client, monitorId, checkResult, jobId) => {
  const result = await client.query(
    `INSERT INTO check_logs (monitor_id, status, response_code, response_time_ms, message, job_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (job_id) DO NOTHING
     RETURNING id`,
    [monitorId, checkResult.status, checkResult.responseCode, checkResult.responseTimeMs, checkResult.message, jobId]
  );
  return result.rows[0] ?? null;
};

export const findChecksByMonitor = async (monitorId, limit, offset) => {
  const result = await query(
    `SELECT id, status, response_code, response_time_ms, message, checked_at
     FROM check_logs
     WHERE monitor_id = $1
     ORDER BY checked_at DESC
     LIMIT $2 OFFSET $3`,
    [monitorId, limit, offset]
  );
  return result.rows;
};

export const getCheckStats = async (monitorId) => {
  const result = await query(
    `SELECT
       COUNT(*)::int AS total_checks,
       ROUND(AVG(response_time_ms))::int AS avg_response_ms,
       COUNT(*) FILTER (WHERE status = 'up')::int AS up_count,
       COUNT(*) FILTER (WHERE status = 'down')::int AS down_count,
       COUNT(*) FILTER (WHERE status = 'timeout')::int AS timeout_count
     FROM check_logs
     WHERE monitor_id = $1`,
    [monitorId]
  );
  return result.rows[0];
};

// Worker writes result state only — next_check_at is owned by the dispatcher.
export const updateMonitorAfterCheck = async (client, monitorId, updates) => {
  const result = await client.query(
    `UPDATE monitors
     SET last_status = $2,
         last_checked_at = NOW(),
         consecutive_failures = $3,
         is_alerted = $4,
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, last_status, consecutive_failures, is_alerted`,
    [monitorId, updates.lastStatus, updates.consecutiveFailures, updates.isAlerted]
  );
  return result.rows[0];
};
