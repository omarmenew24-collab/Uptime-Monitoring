import { Globe, Clock, Timer, AlertTriangle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import StatusBadge from './StatusBadge';

const borderColors = {
  up: 'border-l-emerald-500',
  down: 'border-l-red-500',
  timeout: 'border-l-amber-500',
  paused: 'border-l-zinc-500',
};

const dotColors = {
  up: 'bg-emerald-500',
  down: 'bg-red-500',
  timeout: 'bg-amber-500',
  paused: 'bg-zinc-500',
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
        'group relative border-l-[3px] p-5 transition-colors hover:bg-zinc-900/50',
        borderColors[variant]
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3.5 min-w-0">
          <div className="mt-1 relative">
            <div className={cn(
              'h-2.5 w-2.5 rounded-full',
              dotColors[variant]
            )} />
            {variant === 'up' && (
              <div className={cn(
                'absolute inset-0 h-2.5 w-2.5 rounded-full animate-ping opacity-30',
                dotColors[variant]
              )} />
            )}
          </div>
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex items-center gap-2.5">
              <span className="text-[15px] font-medium text-zinc-100 truncate">
                {monitor.name}
              </span>
              <StatusBadge status={monitor.last_status} isActive={monitor.is_active} />
            </div>
            <div className="flex items-center gap-1.5 text-zinc-500">
              <Globe size={13} strokeWidth={1.5} />
              <span className="font-mono text-[13px] truncate">{monitor.url}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 shrink-0 text-[13px] text-zinc-500">
          <div className="flex items-center gap-1.5">
            <Clock size={13} strokeWidth={1.5} />
            <span>{timeAgo(monitor.last_checked_at)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Timer size={13} strokeWidth={1.5} />
            <span className="font-mono">{monitor.interval_minutes}m</span>
          </div>
          {monitor.is_alerted && (
            <div className="flex items-center gap-1.5 text-red-400">
              <AlertTriangle size={13} strokeWidth={1.5} />
              <span className="text-xs font-medium">Alert</span>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
