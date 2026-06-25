import { query } from '../config/db.js';
import { computeDailyStats, upsertDailyRollup } from '../db/rollups.queries.js';

export const runRollupJob = async () => {
  const monitors = await query(
    'SELECT id FROM monitors WHERE is_active = true AND is_deleted = false'
  );

  if (monitors.rows.length === 0) return 0;

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const dates = [yesterday, today];

  let count = 0;

  for (const monitor of monitors.rows) {
    for (const date of dates) {
      const stats = await computeDailyStats(monitor.id, date);
      if (stats.total_checks === 0) continue;
      await upsertDailyRollup(monitor.id, date, stats);
      count++;
    }
  }

  return count;
};

export const backfillRollups = async () => {
  const dates = await query(
    'SELECT DISTINCT DATE(checked_at) AS date FROM check_logs ORDER BY date'
  );

  const monitors = await query(
    'SELECT id FROM monitors WHERE is_deleted = false'
  );

  let count = 0;

  for (const monitor of monitors.rows) {
    for (const { date } of dates.rows) {
      const dateStr = new Date(date).toISOString().slice(0, 10);
      const stats = await computeDailyStats(monitor.id, dateStr);
      if (stats.total_checks === 0) continue;
      await upsertDailyRollup(monitor.id, dateStr, stats);
      count++;
    }
  }

  return count;
};
