import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import StatusBadge from './StatusBadge';

const borderColors = {
  up: 'border-l-emerald-500',
  down: 'border-l-red-500',
  timeout: 'border-l-amber-500',
  paused: 'border-l-zinc-500',
};

function timeAgo(dateString) {
  if (!dateString) return 'Never';
  const seconds = Math.floor((Date.now() - new Date(dateString).getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function MonitorCard({ monitor }) {
  const variant = !monitor.is_active ? 'paused' : (monitor.last_status || 'paused');

  return (
    <Card
      className={cn(
        'flex items-center justify-between p-6 border-l-[3px]',
        borderColors[variant]
      )}
    >
      <div className="flex items-center gap-4">
        <StatusBadge status={monitor.last_status} isActive={monitor.is_active} />
        <div className="flex flex-col gap-0.5">
          <span className="text-base font-medium text-foreground">{monitor.name}</span>
          <span className="font-mono text-sm text-muted-foreground">{monitor.url}</span>
        </div>
      </div>
      <div className="flex flex-col items-end gap-0.5">
        <span className="text-sm text-muted-foreground">Last checked: {timeAgo(monitor.last_checked_at)}</span>
        <span className="font-mono text-sm text-muted-foreground">{monitor.interval_minutes}min interval</span>
      </div>
    </Card>
  );
}
