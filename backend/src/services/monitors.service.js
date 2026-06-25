import { insertMonitor, findMonitorsByUserId, findMonitorByIdAndUser, pauseMonitor, resumeMonitor, softDeleteMonitor } from '../db/monitors.queries.js';
import { findChecksByMonitor } from '../db/checks.queries.js';
import { enforceMonitorQuota } from '../middleware/quota.js';
import { getRollupsByMonitor, getUptimePercentage } from '../db/rollups.queries.js';
import {
  getCachedMonitorsByUser,
  setCachedMonitorsByUser,
  getCachedMonitorDetail,
  setCachedMonitorDetail,
  invalidateMonitorCache,
} from '../cache/monitorCache.js';

export const createMonitor = async (userId, data) => {
  await enforceMonitorQuota(userId);
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

  const rollups = await getRollupsByMonitor(monitorId, 30);
  const uptimeData = await getUptimePercentage(monitorId, 30);
  const uptimePercent = uptimeData.total > 0
    ? ((uptimeData.up / uptimeData.total) * 100).toFixed(2)
    : null;

  const result = {
    ...monitor,
    stats: { rollups, uptimePercent, totalChecks: uptimeData.total },
  };

  await setCachedMonitorDetail(monitorId, result);
  return result;
};

export const pause = async (monitorId, userId) => {
  const result = await pauseMonitor(monitorId, userId);
  if (result) await invalidateMonitorCache(monitorId, userId);
  return result;
};

export const resume = async (monitorId, userId) => {
  const result = await resumeMonitor(monitorId, userId);
  if (result) await invalidateMonitorCache(monitorId, userId);
  return result;
};

export const remove = async (monitorId, userId) => {
  const result = await softDeleteMonitor(monitorId, userId);
  if (result) await invalidateMonitorCache(monitorId, userId);
  return result;
};

export const getMonitorChecks = async (monitorId, userId, limit, offset) => {
  const monitor = await findMonitorByIdAndUser(monitorId, userId);
  if (!monitor) return null;

  return findChecksByMonitor(monitorId, limit, offset);
};
