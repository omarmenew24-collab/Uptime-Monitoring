import { Queue } from 'bullmq';
import { connection } from './connection.js';

export const CHECK_QUEUE_NAME = 'checks';

// The producer side: the dispatcher adds one job per due monitor here.
// attempts + backoff give automatic retry of a crashed check; failed jobs are
// retained (not removed) so the BullMQ failed set acts as a dead-letter queue.
export const checkQueue = new Queue(CHECK_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});
