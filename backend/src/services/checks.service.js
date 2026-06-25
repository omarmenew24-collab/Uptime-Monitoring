import { withTransaction } from '../config/db.js';
import { insertCheckLog, updateMonitorAfterCheck } from '../db/checks.queries.js';
import { resolveAndValidate } from '../utils/url-safety.js';
import { invalidateMonitorCache } from '../cache/monitorCache.js';

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

// Called by the worker for one check job. `monitor` is the dispatch-time
// snapshot from the job payload (camelCase fields); `jobId` is the stable
// BullMQ id reused across retries. If the log insert hits the job_id conflict,
// this delivery already ran — skip the state update so retries are idempotent.
export const processCheck = async (monitor, jobId) => {
  const checkResult = await runCheck(monitor.url);

  await withTransaction(async (client) => {
    const inserted = await insertCheckLog(client, monitor.monitorId, checkResult, jobId);
    if (!inserted) return;

    let consecutiveFailures = monitor.consecutiveFailures;
    let isAlerted = monitor.isAlerted;

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
};
