import { Worker } from 'bullmq';
import { connection } from './connection.js';
import { NOTIFICATION_QUEUE_NAME } from './notificationQueue.js';
import { sendEmailNotification } from '../events/consumers/emailConsumer.js';
import { sendSlackNotification } from '../events/consumers/slackConsumer.js';

export const createNotificationWorker = () =>
  new Worker(
    NOTIFICATION_QUEUE_NAME,
    async (job) => {
      await sendEmailNotification(job.data);
      await sendSlackNotification(job.data);
    },
    { connection, concurrency: 10 }
  );
