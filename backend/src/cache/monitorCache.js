import redis from './redis.js';

const TTL_SECONDS = 60;

const STATUS_TTL_SECONDS = 120;

const KEYS = {
  userMonitors: (userId) => `monitors:user:${userId}`,
  monitorDetail: (monitorId) => `monitor:${monitorId}`,
  statusPage: (userId) => `status:user:${userId}`,
};

export const getCachedMonitorsByUser = async (userId) => {
  try {
    const data = await redis.get(KEYS.userMonitors(userId));
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
};

export const setCachedMonitorsByUser = async (userId, monitors) => {
  try {
    await redis.set(KEYS.userMonitors(userId), JSON.stringify(monitors), 'EX', TTL_SECONDS);
  } catch {
    // cache write failure is not fatal
  }
};

export const getCachedMonitorDetail = async (monitorId) => {
  try {
    const data = await redis.get(KEYS.monitorDetail(monitorId));
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
};

export const setCachedMonitorDetail = async (monitorId, monitor) => {
  try {
    await redis.set(KEYS.monitorDetail(monitorId), JSON.stringify(monitor), 'EX', TTL_SECONDS);
  } catch {
    // cache write failure is not fatal
  }
};

export const getCachedStatusPage = async (userId) => {
  try {
    const data = await redis.get(KEYS.statusPage(userId));
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
};

export const setCachedStatusPage = async (userId, status) => {
  try {
    await redis.set(KEYS.statusPage(userId), JSON.stringify(status), 'EX', STATUS_TTL_SECONDS);
  } catch {
    // cache write failure is not fatal
  }
};

export const invalidateMonitorCache = async (monitorId, userId) => {
  try {
    const keys = [];
    if (monitorId) keys.push(KEYS.monitorDetail(monitorId));
    if (userId) {
      keys.push(KEYS.userMonitors(userId));
      keys.push(KEYS.statusPage(userId));
    }
    if (keys.length > 0) await redis.del(...keys);
  } catch {
    // cache invalidation failure is not fatal
  }
};
