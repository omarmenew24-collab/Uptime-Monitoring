import { claimDueMonitors } from '../db/checks.queries.js';
import { checkQueue } from './checkQueue.js';

const DISPATCH_BATCH = 500;

// Decide what to run: claim due monitors and enqueue one check job each.
// The jobId (monitorId:minuteBucket) makes enqueue idempotent — if two
// dispatcher ticks race in the same minute, BullMQ ignores the duplicate add.
// The monitor state snapshot rides in the job data so the worker never re-queries.
export const dispatchDueChecks = async () => {
  const monitors = await claimDueMonitors(DISPATCH_BATCH);
  if (monitors.length === 0) return 0;

  const minuteBucket = Math.floor(Date.now() / 60_000);

  await checkQueue.addBulk(
    monitors.map((monitor) => ({
      name: 'check',
      data: {
        monitorId: monitor.id,
        userId: monitor.user_id,
        url: monitor.url,
        failureThreshold: monitor.failure_threshold,
        consecutiveFailures: monitor.consecutive_failures,
        isAlerted: monitor.is_alerted,
      },
      opts: { jobId: `${monitor.id}_${minuteBucket}` },
    }))
  );

  return monitors.length;
};
