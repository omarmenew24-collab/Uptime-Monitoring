import 'dotenv/config';
import cron from 'node-cron';
import pool from './config/db.js';
import { connection } from './queue/connection.js';
import { checkQueue } from './queue/checkQueue.js';
import { notificationQueue } from './queue/notificationQueue.js';
import { createCheckWorker } from './queue/checkWorker.js';
import { createNotificationWorker } from './queue/notificationWorker.js';
import { dispatchDueChecks } from './queue/dispatcher.js';
import { deleteExpiredCheckLogs } from './db/retention.queries.js';

const checkWorker = createCheckWorker();
const notificationWorker = createNotificationWorker();

checkWorker.on('failed', (job, err) => {
  console.error(`Check job ${job?.id} failed:`, err.message);
});

notificationWorker.on('failed', (job, err) => {
  console.error(`Notification job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message);
});

const dispatchTask = cron.schedule('* * * * *', async () => {
  try {
    await dispatchDueChecks();
  } catch (err) {
    console.error('Dispatcher error:', err);
  }
});

const retentionTask = cron.schedule('0 3 * * *', async () => {
  try {
    await deleteExpiredCheckLogs();
  } catch (err) {
    console.error('Retention error:', err);
  }
});

let shuttingDown = false;

const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  dispatchTask.stop();
  retentionTask.stop();
  await checkWorker.close();
  await notificationWorker.close();
  await checkQueue.close();
  await notificationQueue.close();
  await connection.quit();
  await pool.end();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.error('Worker started');
