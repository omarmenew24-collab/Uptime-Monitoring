import 'dotenv/config';
import cron from 'node-cron';
import pool from './config/db.js';
import { connection } from './queue/connection.js';
import { checkQueue } from './queue/checkQueue.js';
import { createCheckWorker } from './queue/checkWorker.js';
import { dispatchDueChecks } from './queue/dispatcher.js';
import { deleteExpiredCheckLogs } from './db/retention.queries.js';
import { createPublisher, createSubscriber } from './events/eventBus.js';
import { handleEmailEvent } from './events/consumers/emailConsumer.js';
import { handleSlackEvent } from './events/consumers/slackConsumer.js';
import { setEventPublisher } from './services/checks.service.js';

const publisher = createPublisher();
setEventPublisher(publisher.publish);

const subscriber = createSubscriber(async (event) => {
  await handleEmailEvent(event);
  await handleSlackEvent(event);
});

const worker = createCheckWorker();

worker.on('failed', (job, err) => {
  console.error(`Check job ${job?.id} failed:`, err.message);
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
  await worker.close();
  await checkQueue.close();
  await subscriber.close();
  await publisher.close();
  await connection.quit();
  await pool.end();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.error('Worker started');
