import { query } from '../config/db.js';

export const findUserById = async (userId) => {
  const result = await query(
    'SELECT id, email, slack_webhook_url FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0] ?? null;
};
