import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const statusColors = {
  up: 'text-emerald-400',
  down: 'text-red-400',
  timeout: 'text-amber-400',
};

function StatCard({ label, value, className }) {
  return (
    <Card className="flex-1 p-5">
      <span className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">
        {label}
      </span>
      <span className={cn('block text-2xl font-semibold font-mono', className)}>
        {value}
      </span>
    </Card>
  );
}

export default function StatsRow({ monitor, stats }) {
  const statusLabel = monitor.last_status?.toUpperCase() || 'PENDING';
  const statusColor = statusColors[monitor.last_status] || 'text-zinc-400';
  const avgResponse = stats.avg_response_ms != null ? `${stats.avg_response_ms}ms` : '—';

  return (
    <div className="grid grid-cols-3 gap-4">
      <StatCard label="Current Status" value={statusLabel} className={statusColor} />
      <StatCard label="Avg Response" value={avgResponse} className="text-zinc-100" />
      <StatCard label="Total Checks" value={stats.total_checks.toLocaleString()} className="text-zinc-100" />
    </div>
  );
}
