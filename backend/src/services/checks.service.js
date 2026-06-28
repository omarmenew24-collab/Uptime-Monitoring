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
  const result = await runCheck(monitor.url);

  const { query } = await import('../config/db.js');
  const jobId = `${monitor.id}_manual_${Date.now()}`;

  const row = await query(
    `INSERT INTO check_logs (monitor_id, status, response_code, response_time_ms, message, job_id, checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (job_id) DO NOTHING
     RETURNING id, status, response_code, response_time_ms, checked_at`,
    [monitor.id, result.status, result.responseCode, result.responseTimeMs, result.message, jobId]
  );

  await invalidateMonitorCache(monitor.id, monitor.user_id);

  return row.rows[0] || { status: result.status, response_code: result.responseCode, response_time_ms: result.responseTimeMs, checked_at: new Date().toISOString() };
};
