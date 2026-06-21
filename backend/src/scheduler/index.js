import cron from 'node-cron';
import { checkAllDueMonitors } from '../services/checks.service.js';
import { deleteExpiredCheckLogs } from '../db/retention.queries.js';

let isRunning = false;

cron.schedule('* * * * *', async () => {
  if (isRunning) return;
  isRunning = true;
  try {
    await checkAllDueMonitors();
  } catch (err) {
    console.error('Scheduler error:', err);
  } finally {
    isRunning = false;
  }
});

cron.schedule('0 3 * * *', async () => {
  try {
    const deleted = await deleteExpiredCheckLogs();
    if (deleted > 0) {
      console.error(`Retention: deleted ${deleted} check logs older than 30 days`);
    }
  } catch (err) {
    console.error('Retention error:', err);
  }
});
