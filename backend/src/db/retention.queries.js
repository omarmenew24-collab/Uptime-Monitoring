import { query } from '../config/db.js';

const RETENTION_DAYS = 30;

export const deleteExpiredCheckLogs = async () => {
  const result = await query(
    `DELETE FROM check_logs
     WHERE checked_at < NOW() - ($1 || ' days')::interval`,
    [String(RETENTION_DAYS)]
  );
  return result.rowCount;
};
