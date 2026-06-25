import { useState } from 'react';
import { Card } from '@/components/ui/card';

function getDayStatus(rollup) {
  if (!rollup) return 'none';
  if (rollup.down_count > 0) return 'down';
  if (rollup.timeout_count > 0) return 'timeout';
  return 'up';
}

const tickColors = {
  up: 'bg-emerald-500',
  down: 'bg-red-500',
  timeout: 'bg-amber-500',
  none: 'bg-zinc-800',
};

function buildDayGrid(rollups) {
  const days = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const rollupMap = new Map();
  for (const r of rollups) {
    const key = new Date(r.date).toISOString().slice(0, 10);
    rollupMap.set(key, r);
  }

  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({
      date: key,
      label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      rollup: rollupMap.get(key) ?? null,
    });
  }

  return days;
}

export default function UptimeBar({ rollups = [] }) {
  const [hovered, setHovered] = useState(null);
  const days = buildDayGrid(rollups);

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-semibold text-zinc-300">Uptime (30 days)</span>
        {hovered && (
          <span className="text-xs text-zinc-400 font-mono">
            {hovered.label} — {hovered.rollup
              ? `${((hovered.rollup.up_count / hovered.rollup.total_checks) * 100).toFixed(1)}% up (${hovered.rollup.total_checks} checks)`
              : 'No data'}
          </span>
        )}
      </div>
      <div className="flex gap-[2px] h-8 rounded-md overflow-hidden">
        {days.map((day) => {
          const status = getDayStatus(day.rollup);
          return (
            <div
              key={day.date}
              className={`flex-1 ${tickColors[status]} transition-opacity hover:opacity-80 cursor-pointer`}
              onMouseEnter={() => setHovered(day)}
              onMouseLeave={() => setHovered(null)}
            />
          );
        })}
      </div>
      <div className="flex justify-between mt-2">
        <span className="text-xs text-zinc-600">30 days ago</span>
        <span className="text-xs text-zinc-600">Today</span>
      </div>
    </Card>
  );
}
