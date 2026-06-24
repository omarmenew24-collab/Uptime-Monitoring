import { Worker } from 'bullmq';
import { connection } from './connection.js';
import { CHECK_QUEUE_NAME } from './checkQueue.js';
import { processCheck } from '../services/checks.service.js';

// Concurrency replaces the old pLimit(50): to process more in parallel, raise
// WORKER_CONCURRENCY or run another worker process — same code, no changes.
const concurrency = Number(process.env.WORKER_CONCURRENCY) || 50;

export const createCheckWorker = () =>
  new Worker(
    CHECK_QUEUE_NAME,
    async (job) => {
      await processCheck(job.data, job.id);
    },
    { connection, concurrency }
  );
