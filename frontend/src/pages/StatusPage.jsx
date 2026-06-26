import { useParams } from 'react-router-dom';
import { Activity, Loader2 as Loader } from 'lucide-react';
import { usePublicStatus } from '@/hooks/usePublicStatus';
import { cn } from '@/lib/utils';

const overallColors = {
  operational: 'text-emerald-400',
  degraded: 'text-amber-400',
  major_outage: 'text-red-400',
};

const overallLabels = {
  operational: 'All Systems Operational',
  degraded: 'Degraded Performance',
  major_outage: 'Major Outage',
};

const overallDotColors = {
  operational: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  major_outage: 'bg-red-500',
};

const statusDots = {
  up: 'bg-emerald-500',
  down: 'bg-red-500',
  timeout: 'bg-amber-500',
};

const statusLabels = {
  up: 'Operational',
  down: 'Down',
  timeout: 'Timeout',
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

export default function StatusPage() {
  const { userId } = useParams();
  const { status, isLoading, isError } = usePublicStatus(userId);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#09090b] flex items-center justify-center">
        <Loader className="h-6 w-6 animate-spin text-zinc-500" />
      </div>
    );
  }

  if (isError || !status) {
    return (
      <div className="min-h-screen bg-[#09090b] flex items-center justify-center">
        <div className="text-zinc-500 text-sm">Status page not found.</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100">
      <div className="max-w-2xl mx-auto px-6 py-12">
        <div className="flex items-center gap-3 mb-8">
          <Activity size={24} strokeWidth={1.5} className="text-indigo-400" />
          <h1 className="text-xl font-semibold">System Status</h1>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5 mb-8">
          <div className="flex items-center gap-3">
            <div className={cn('h-3 w-3 rounded-full', overallDotColors[status.overallStatus])} />
            <span className={cn('text-lg font-medium', overallColors[status.overallStatus])}>
              {overallLabels[status.overallStatus]}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {status.monitors.map((monitor) => (
            <div
              key={monitor.name}
              className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 flex items-center justify-between"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className={cn('h-2.5 w-2.5 rounded-full shrink-0', statusDots[monitor.status] || 'bg-zinc-600')} />
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm font-medium text-zinc-200 truncate">{monitor.name}</span>
                  <span className="text-xs text-zinc-600 font-mono truncate">{monitor.url}</span>
                </div>
              </div>
              <div className="flex items-center gap-4 shrink-0 text-xs">
                <span className={cn('font-medium', monitor.status === 'up' ? 'text-emerald-400' : monitor.status === 'down' ? 'text-red-400' : 'text-amber-400')}>
                  {statusLabels[monitor.status] || 'Unknown'}
                </span>
                {monitor.uptimePercent && (
                  <span className="text-zinc-500 font-mono">{monitor.uptimePercent}%</span>
                )}
                <span className="text-zinc-600">{timeAgo(monitor.lastCheckedAt)}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-8 text-center text-xs text-zinc-700">
          Updated every 30 seconds
        </div>
      </div>
    </div>
  );
}
