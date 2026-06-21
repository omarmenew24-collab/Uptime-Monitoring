import { query } from '../config/db.js';

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

export const insertCheckLog = async (client, monitorId, checkResult) => {
  const result = await client.query(
    `INSERT INTO check_logs (monitor_id, status, response_code, response_time_ms, message)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [monitorId, checkResult.status, checkResult.responseCode, checkResult.responseTimeMs, checkResult.message]
  );
  return result.rows[0];
};

export const updateMonitorAfterCheck = async (client, monitorId, updates) => {
  const result = await client.query(
    `UPDATE monitors
     SET last_status = $2,
         last_checked_at = NOW(),
         next_check_at = NOW() + ($3 || ' minutes')::interval,
         consecutive_failures = $4,
         is_alerted = $5,
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, last_status, consecutive_failures, is_alerted, next_check_at`,
    [monitorId, updates.lastStatus, String(updates.intervalMinutes), updates.consecutiveFailures, updates.isAlerted]
  );
  return result.rows[0];
};
