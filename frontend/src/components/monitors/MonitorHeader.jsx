import { ArrowLeft, ExternalLink, Pause, Play, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import StatusBadge from './StatusBadge';
import { usePauseMonitor, useResumeMonitor, useDeleteMonitor } from '@/hooks/useMonitors';

function formatDate(dateString) {
  if (!dateString) return '—';
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function MonitorHeader({ monitor }) {
  const navigate = useNavigate();
  const { pauseMonitor, isPending: pausePending } = usePauseMonitor();
  const { resumeMonitor, isPending: resumePending } = useResumeMonitor();
  const { deleteMonitor, isPending: deletePending } = useDeleteMonitor();

  const handlePauseResume = async () => {
    if (monitor.is_active) {
      await pauseMonitor(monitor.id);
    } else {
      await resumeMonitor(monitor.id);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete "${monitor.name}"? Check history will be preserved but the monitor will stop running.`)) return;
    await deleteMonitor(monitor.id);
    navigate('/dashboard');
  };

  return (
    <Card className="p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <button
            onClick={() => navigate('/dashboard')}
            className="mt-1 p-1 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            <ArrowLeft size={18} strokeWidth={1.5} />
          </button>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-semibold text-zinc-100">{monitor.name}</h1>
              <StatusBadge status={monitor.last_status} isActive={monitor.is_active} />
            </div>
            <a
              href={monitor.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 font-mono text-sm text-zinc-500 hover:text-indigo-400 transition-colors"
            >
              {monitor.url}
              <ExternalLink size={12} strokeWidth={1.5} />
            </a>
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <span>Every {monitor.interval_minutes}min</span>
              <span className="text-zinc-700">·</span>
              <span>Alert after {monitor.failure_threshold} failures</span>
              <span className="text-zinc-700">·</span>
              <span>Created {formatDate(monitor.created_at)}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handlePauseResume}
            disabled={pausePending || resumePending}
            className="gap-1.5 text-zinc-400 hover:text-zinc-100"
          >
            {monitor.is_active ? (
              <><Pause size={14} strokeWidth={1.5} /> Pause</>
            ) : (
              <><Play size={14} strokeWidth={1.5} /> Resume</>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDelete}
            disabled={deletePending}
            className="gap-1.5 text-zinc-400 hover:text-red-400 hover:border-red-800"
          >
            <Trash2 size={14} strokeWidth={1.5} />
          </Button>
        </div>
      </div>
    </Card>
  );
}
