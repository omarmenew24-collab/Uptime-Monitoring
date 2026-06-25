import { query } from '../config/db.js';

const SAFE_COLUMNS = `id, name, url, interval_minutes, failure_threshold, is_active,
  last_status, last_checked_at, next_check_at, created_at`;

export const insertMonitor = async (userId, data) => {
  const result = await query(
    `INSERT INTO monitors (user_id, name, url, interval_minutes, failure_threshold, next_check_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     RETURNING ${SAFE_COLUMNS}`,
    [userId, data.name, data.url, data.interval_minutes, data.failure_threshold]
  );
  return result.rows[0];
};

export const findMonitorsByUserId = async (userId) => {
  const result = await query(
    `SELECT ${SAFE_COLUMNS}
     FROM monitors
     WHERE user_id = $1 AND is_deleted = false
     ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
};

export const findMonitorByIdAndUser = async (monitorId, userId) => {
  const result = await query(
    `SELECT ${SAFE_COLUMNS}, consecutive_failures, is_alerted
     FROM monitors
     WHERE id = $1 AND user_id = $2 AND is_deleted = false`,
    [monitorId, userId]
  );
  return result.rows[0] ?? null;
};
