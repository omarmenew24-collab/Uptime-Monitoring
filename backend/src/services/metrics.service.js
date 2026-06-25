import { checkQueue } from '../queue/checkQueue.js';
import { notificationQueue } from '../queue/notificationQueue.js';
import { query } from '../config/db.js';
import redis from '../cache/redis.js';

const LAG_THRESHOLD_SECONDS = 300;

export const getMetrics = async () => {
  const [
    checksWaiting,
    checksActive,
    checksFailed,
    notifWaiting,
    notifFailed,
    monitorCount,
    latestCheck,
    redisOk,
    pgOk,
  ] = await Promise.allSettled([
    checkQueue.getWaitingCount(),
    checkQueue.getActiveCount(),
    checkQueue.getFailedCount(),
    notificationQueue.getWaitingCount(),
    notificationQueue.getFailedCount(),
    query('SELECT COUNT(*)::int AS n FROM monitors WHERE is_active = true AND is_deleted = false'),
    query('SELECT MAX(checked_at) AS latest FROM check_logs'),
    redis.ping(),
    query('SELECT 1'),
  ]);

  const val = (result, fallback = null) =>
    result.status === 'fulfilled' ? result.value : fallback;

  const latestCheckedAt = val(latestCheck)?.rows?.[0]?.latest ?? null;
  const lagSeconds = latestCheckedAt
    ? Math.round((Date.now() - new Date(latestCheckedAt).getTime()) / 1000)
    : null;

  const redisConnected = val(redisOk) === 'PONG';
  const pgConnected = pgOk.status === 'fulfilled';

  let status = 'healthy';
  if (!redisConnected || !pgConnected) {
    status = 'unhealthy';
  } else if (lagSeconds !== null && lagSeconds > LAG_THRESHOLD_SECONDS) {
    status = 'degraded';
  }

  return {
    status,
    timestamp: new Date().toISOString(),
    checks: {
      queue: {
        waiting: val(checksWaiting, 0),
        active: val(checksActive, 0),
        failed: val(checksFailed, 0),
      },
      lag_seconds: lagSeconds,
      latest: latestCheckedAt,
    },
    notifications: {
      queue: {
        waiting: val(notifWaiting, 0),
        failed: val(notifFailed, 0),
      },
    },
    monitors: {
      total: val(monitorCount)?.rows?.[0]?.n ?? 0,
    },
    connections: {
      redis: redisConnected,
      postgres: pgConnected,
    },
  };
};
