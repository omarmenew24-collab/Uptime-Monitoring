import { insertMonitor, findMonitorsByUserId, findMonitorByIdAndUser } from '../db/monitors.queries.js';
import { getCheckStats, findChecksByMonitor } from '../db/checks.queries.js';

export const createMonitor = async (userId, data) => {
  return insertMonitor(userId, data);
};

export const getMonitorsByUser = async (userId) => {
  return findMonitorsByUserId(userId);
};

export const getMonitorDetail = async (monitorId, userId) => {
  const monitor = await findMonitorByIdAndUser(monitorId, userId);
  if (!monitor) return null;

  const stats = await getCheckStats(monitorId);

  return { ...monitor, stats };
};

export const getMonitorChecks = async (monitorId, userId, limit, offset) => {
  const monitor = await findMonitorByIdAndUser(monitorId, userId);
  if (!monitor) return null;

  return findChecksByMonitor(monitorId, limit, offset);
};
