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

export const pauseMonitor = async (monitorId, userId) => {
  const result = await query(
    `UPDATE monitors SET is_active = false, updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND is_deleted = false
     RETURNING id, is_active`,
    [monitorId, userId]
  );
  return result.rows[0] ?? null;
};

export const resumeMonitor = async (monitorId, userId) => {
  const result = await query(
    `UPDATE monitors SET is_active = true, next_check_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND is_deleted = false
     RETURNING id, is_active`,
    [monitorId, userId]
  );
  return result.rows[0] ?? null;
};

export const softDeleteMonitor = async (monitorId, userId) => {
  const result = await query(
    `UPDATE monitors SET is_deleted = true, is_active = false, updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND is_deleted = false
     RETURNING id`,
    [monitorId, userId]
  );
  return result.rows[0] ?? null;
};

export const updateMonitor = async (monitorId, userId, data) => {
  const result = await query(
    `UPDATE monitors
     SET name = COALESCE($3, name),
         url = COALESCE($4, url),
         interval_minutes = COALESCE($5, interval_minutes),
         failure_threshold = COALESCE($6, failure_threshold),
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND is_deleted = false
     RETURNING ${SAFE_COLUMNS}`,
    [monitorId, userId, data.name ?? null, data.url ?? null, data.interval_minutes ?? null, data.failure_threshold ?? null]
  );
  return result.rows[0] ?? null;
};

export const findMonitorByIdAndUser = async (monitorId, userId) => {
  const result = await query(
    `SELECT ${SAFE_COLUMNS}, user_id, consecutive_failures, is_alerted
     FROM monitors
     WHERE id = $1 AND user_id = $2 AND is_deleted = false`,
    [monitorId, userId]
  );
  return result.rows[0] ?? null;
};
