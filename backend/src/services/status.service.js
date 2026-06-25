import { findPublicMonitorsByUserId } from '../db/monitors.queries.js';
import { getUptimePercentage } from '../db/rollups.queries.js';
import { getCachedStatusPage, setCachedStatusPage } from '../cache/monitorCache.js';

export const getPublicStatus = async (userId) => {
  const cached = await getCachedStatusPage(userId);
  if (cached) return cached;

  const monitors = await findPublicMonitorsByUserId(userId);
  if (monitors.length === 0) return null;

  const monitorsWithUptime = await Promise.all(
    monitors.map(async (monitor) => {
      const uptimeData = await getUptimePercentage(monitor.id, 30);
      const uptimePercent = uptimeData.total > 0
        ? ((uptimeData.up / uptimeData.total) * 100).toFixed(2)
        : null;

      return {
        name: monitor.name,
        url: monitor.url,
        status: monitor.last_status,
        lastCheckedAt: monitor.last_checked_at,
        uptimePercent,
      };
    })
  );

  const downCount = monitorsWithUptime.filter((m) => m.status === 'down' || m.status === 'timeout').length;
  let overallStatus = 'operational';
  if (downCount === monitorsWithUptime.length) {
    overallStatus = 'major_outage';
  } else if (downCount > 0) {
    overallStatus = 'degraded';
  }

  const result = { monitors: monitorsWithUptime, overallStatus };

  await setCachedStatusPage(userId, result);
  return result;
};
