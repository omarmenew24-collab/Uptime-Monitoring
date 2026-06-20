import { insertMonitor, findMonitorsByUserId } from '../db/monitors.queries.js';

export const createMonitor = async (userId, data) => {
  return insertMonitor(userId, data);
};

export const getMonitorsByUser = async (userId) => {
  return findMonitorsByUserId(userId);
};
