import { withTransaction } from '../config/db.js';
import { insertCheckLog, updateMonitorAfterCheck } from '../db/checks.queries.js';
import { resolveAndValidate } from '../utils/url-safety.js';
import { invalidateMonitorCache } from '../cache/monitorCache.js';
import { notificationQueue } from '../queue/notificationQueue.js';
import { acquireDomainSlot, releaseDomainSlot } from '../middleware/domainLimiter.js';

const CHECK_TIMEOUT_MS = 5000;

export const runCheck = async (url) => {
  const dnsCheck = await resolveAndValidate(url);
  if (!dnsCheck.safe) {
    return {
      status: 'down',
      responseCode: null,
      responseTimeMs: null,
      message: `Blocked: ${dnsCheck.reason}`,
    };
  }

  const startTime = Date.now();

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      redirect: 'follow',
    });

    const responseTimeMs = Date.now() - startTime;

    await response.body?.cancel();

    if (response.ok) {
      return {
        status: 'up',
        responseCode: response.status,
        responseTimeMs,
        message: null,
      };
    }

    return {
      status: 'down',
      responseCode: response.status,
      responseTimeMs,
      message: response.statusText,
    };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return {
        status: 'timeout',
        responseCode: null,
        responseTimeMs: null,
        message: `Request timed out after ${CHECK_TIMEOUT_MS}ms`,
      };
    }

    return {
      status: 'down',
      responseCode: null,
      responseTimeMs: null,
      message: err.message,
    };
  }
};

export const processCheck = async (monitor, jobId) => {
  const domain = new URL(monitor.url).hostname;
  const acquired = await acquireDomainSlot(domain);
  if (!acquired) {
    throw new Error(`Domain ${domain} concurrency limit reached`);
  }

  let checkResult;
  try {
    checkResult = await runCheck(monitor.url);
  } finally {
    await releaseDomainSlot(domain);
  }

  const previouslyAlerted = monitor.isAlerted;

  let consecutiveFailures;
  let isAlerted;

  await withTransaction(async (client) => {
    const inserted = await insertCheckLog(client, monitor.monitorId, checkResult, jobId);
    if (!inserted) return;

    consecutiveFailures = monitor.consecutiveFailures;
    isAlerted = monitor.isAlerted;

    if (checkResult.status === 'up') {
      consecutiveFailures = 0;
      if (isAlerted) {
        isAlerted = false;
      }
    } else {
      consecutiveFailures += 1;
      if (consecutiveFailures >= monitor.failureThreshold && !isAlerted) {
        isAlerted = true;
      }
    }

    await updateMonitorAfterCheck(client, monitor.monitorId, {
      lastStatus: checkResult.status,
      consecutiveFailures,
      isAlerted,
    });
  });

  await invalidateMonitorCache(monitor.monitorId, monitor.userId);

  if (consecutiveFailures !== undefined) {
    if (!previouslyAlerted && isAlerted) {
      await notificationQueue.add('monitor.down', {
        type: 'monitor.down',
        monitorId: monitor.monitorId,
        userId: monitor.userId,
        monitorName: monitor.monitorName,
        url: monitor.url,
        consecutiveFailures,
        failureThreshold: monitor.failureThreshold,
        timestamp: new Date().toISOString(),
      });
    }

    if (previouslyAlerted && !isAlerted) {
      await notificationQueue.add('monitor.recovered', {
        type: 'monitor.recovered',
        monitorId: monitor.monitorId,
        userId: monitor.userId,
        monitorName: monitor.monitorName,
        url: monitor.url,
        timestamp: new Date().toISOString(),
      });
    }
  }
};

export const checkNow = async (monitor) => {
  const jobId = `${monitor.id}:manual:${Date.now()}`;
  await processCheck(monitor, jobId);

  // Fetch and return the latest check result
  const { query } = await import('../config/db.js');
  const result = await query(
    'SELECT id, status, response_code, response_time_ms, checked_at FROM check_logs WHERE monitor_id = $1 AND job_id = $2',
    [monitor.id, jobId]
  );

  if (!result.rows[0]) {
    throw new Error('Check executed but result not found');
  }

  return result.rows[0];
};
