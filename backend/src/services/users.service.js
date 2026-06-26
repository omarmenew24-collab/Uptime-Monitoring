import { findUserById, updateUserSlackWebhook } from '../db/users.queries.js';

export const getUserSettings = async (userId) => {
  const user = await findUserById(userId);
  if (!user) return null;

  return {
    email: user.email,
    slackWebhookUrl: user.slack_webhook_url,
  };
};

export const updateUserSettings = async (userId, data) => {
  if (data.slackWebhookUrl !== undefined && data.slackWebhookUrl !== '' && data.slackWebhookUrl !== null) {
    try {
      const url = new URL(data.slackWebhookUrl);
      if (url.protocol !== 'https:') {
        const err = new Error('Slack webhook URL must use HTTPS');
        err.statusCode = 400;
        throw err;
      }
    } catch (e) {
      if (e.statusCode) throw e;
      const err = new Error('Invalid Slack webhook URL');
      err.statusCode = 400;
      throw err;
    }
  }

  const user = await updateUserSlackWebhook(userId, data.slackWebhookUrl);
  if (!user) return null;

  return {
    email: user.email,
    slackWebhookUrl: user.slack_webhook_url,
  };
};
