import { insertMonitor, findMonitorsByUserId, findMonitorByIdAndUser } from '../db/monitors.queries.js';
import { getCheckStats, findChecksByMonitor } from '../db/checks.queries.js';
import {
  getCachedMonitorsByUser,
  setCachedMonitorsByUser,
  getCachedMonitorDetail,
  setCachedMonitorDetail,
  invalidateMonitorCache,
} from '../cache/monitorCache.js';

export const createMonitor = async (userId, data) => {
  const monitor = await insertMonitor(userId, data);
  await invalidateMonitorCache(null, userId);
  return monitor;
};

export const getMonitorsByUser = async (userId) => {
  const cached = await getCachedMonitorsByUser(userId);
  if (cached) return cached;

  const monitors = await findMonitorsByUserId(userId);
  await setCachedMonitorsByUser(userId, monitors);
  return monitors;
};

export const getMonitorDetail = async (monitorId, userId) => {
  const cached = await getCachedMonitorDetail(monitorId);
  if (cached) {
    if (cached.user_id && cached.user_id !== userId) return null;
    return cached;
  }

  const monitor = await findMonitorByIdAndUser(monitorId, userId);
  if (!monitor) return null;

  const stats = await getCheckStats(monitorId);
  const result = { ...monitor, stats };

  await setCachedMonitorDetail(monitorId, result);
  return result;
};

export const getMonitorChecks = async (monitorId, userId, limit, offset) => {
  const monitor = await findMonitorByIdAndUser(monitorId, userId);
  if (!monitor) return null;

  return findChecksByMonitor(monitorId, limit, offset);
};
