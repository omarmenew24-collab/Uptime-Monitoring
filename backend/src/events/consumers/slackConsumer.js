import { findUserById } from '../../db/users.queries.js';

export const handleSlackEvent = async (event) => {
  try {
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

    await fetch(user.slack_webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error('Slack consumer error:', err.message);
  }
};
