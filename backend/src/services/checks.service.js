import { withTransaction } from '../config/db.js';
import { findDueMonitors, insertCheckLog, updateMonitorAfterCheck } from '../db/checks.queries.js';

const CHECK_TIMEOUT_MS = 5000;

export const runCheck = async (url) => {
  const startTime = Date.now();

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      redirect: 'follow',
    });

    const responseTimeMs = Date.now() - startTime;

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

export const processCheck = async (monitor) => {
  const checkResult = await runCheck(monitor.url);

  await withTransaction(async (client) => {
    await insertCheckLog(client, monitor.id, checkResult);

    let consecutiveFailures = monitor.consecutive_failures;
    let isAlerted = monitor.is_alerted;

    if (checkResult.status === 'up') {
      consecutiveFailures = 0;
      if (isAlerted) {
        isAlerted = false;
      }
    } else {
      consecutiveFailures += 1;
      if (consecutiveFailures >= monitor.failure_threshold && !isAlerted) {
        isAlerted = true;
      }
    }

    await updateMonitorAfterCheck(client, monitor.id, {
      lastStatus: checkResult.status,
      intervalMinutes: monitor.interval_minutes,
      consecutiveFailures,
      isAlerted,
    });
  });
};

export const checkAllDueMonitors = async () => {
  const dueMonitors = await findDueMonitors();

  if (dueMonitors.length === 0) return;

  const results = await Promise.allSettled(
    dueMonitors.map((monitor) => processCheck(monitor))
  );

  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    console.error(`Scheduler: ${failed.length}/${dueMonitors.length} checks failed to process`);
    failed.forEach((r) => console.error('  -', r.reason?.message));
  }
};
