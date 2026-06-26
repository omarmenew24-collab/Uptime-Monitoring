import { query } from '../config/db.js';

export const findUserById = async (userId) => {
  const result = await query(
    'SELECT id, email, slack_webhook_url FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0] ?? null;
};

export const updateUserSlackWebhook = async (userId, slackWebhookUrl) => {
  const result = await query(
    'UPDATE users SET slack_webhook_url = $2 WHERE id = $1 RETURNING id, email, slack_webhook_url',
    [userId, slackWebhookUrl || null]
  );
  return result.rows[0] ?? null;
};
