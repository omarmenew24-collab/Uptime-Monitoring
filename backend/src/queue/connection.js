import IORedis from 'ioredis';

// Shared Redis connection for the queue, dispatcher, and worker.
// maxRetriesPerRequest must be null — BullMQ workers require it for blocking commands.
export const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});
