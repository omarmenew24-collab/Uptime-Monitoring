import { query } from '../config/db.js';

const MAX_MONITORS = Number(process.env.MAX_MONITORS_PER_USER) || 50;

export const enforceMonitorQuota = async (userId) => {
  const result = await query(
    'SELECT COUNT(*)::int AS n FROM monitors WHERE user_id = $1 AND is_deleted = false',
    [userId]
  );

  if (result.rows[0].n >= MAX_MONITORS) {
    const err = new Error(`Monitor limit reached (${MAX_MONITORS})`);
    err.statusCode = 403;
    throw err;
  }
};
