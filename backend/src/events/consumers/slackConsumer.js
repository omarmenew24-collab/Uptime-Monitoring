import { findUserById } from '../../db/users.queries.js';

export const sendSlackNotification = async (event) => {
  const user = await findUserById(event.userId);
  if (!user?.slack_webhook_url) return;

  let text;

  if (event.type === 'monitor.down') {
    text = `🔴 *${event.monitorName}* is DOWN\n${event.url}\n${event.consecutiveFailures} consecutive failures`;
  } else if (event.type === 'monitor.recovered') {
    text = `✅ *${event.monitorName}* is back UP\n${event.url}`;
  } else {
    return;
  }

  const response = await fetch(user.slack_webhook_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook failed: ${response.status}`);
  }
};
