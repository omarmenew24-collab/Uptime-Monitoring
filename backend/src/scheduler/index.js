import cron from 'node-cron';
import { checkAllDueMonitors } from '../services/checks.service.js';

let isRunning = false;

const job = cron.schedule('* * * * *', async () => {
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

export default job;
