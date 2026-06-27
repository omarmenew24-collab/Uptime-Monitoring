import { Card } from '@/components/ui/card';
import StatusBadge from './StatusBadge';

function timeAgo(dateString) {
  if (!dateString) return '—';
  const seconds = Math.floor((Date.now() - new Date(dateString).getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function CheckHistory({ checks, hasMore, onLoadMore, isLoading }) {
  return (
    <Card className="overflow-hidden">
      <div className="px-5 py-3 border-b border-zinc-800 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-300">Check History</h2>
        <span className="text-xs text-zinc-500">
          Showing {checks.length} check{checks.length !== 1 ? 's' : ''}
          {hasMore && ' (scroll to load more)'}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-zinc-800">
              <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">Status</th>
              <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">Code</th>
              <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">Response Time</th>
              <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">Checked At</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((check) => (
              <tr key={check.id} className="border-b border-zinc-800/50 hover:bg-zinc-900/50 transition-colors">
                <td className="px-5 py-3">
                  <StatusBadge status={check.status} />
                </td>
                <td className="px-5 py-3 font-mono text-sm text-zinc-300">
                  {check.response_code ?? '—'}
                </td>
                <td className="px-5 py-3 font-mono text-sm text-zinc-500">
                  {check.response_time_ms != null ? `${check.response_time_ms}ms` : '—'}
                </td>
                <td className="px-5 py-3 text-sm text-zinc-500">
                  {timeAgo(check.checked_at)}
                </td>
              </tr>
            ))}
            {checks.length === 0 && (
              <tr>
                <td colSpan={4} className="px-5 py-8 text-center text-sm text-zinc-500">
                  No checks yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {hasMore && (
        <div className="px-5 py-3 border-t border-zinc-800 flex items-center justify-center">
          <button
            onClick={onLoadMore}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-indigo-400 hover:text-indigo-300 hover:bg-zinc-800/50 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? '⟳ Loading more...' : '↓ Load earlier checks'}
          </button>
        </div>
      )}
    </Card>
  );
}
