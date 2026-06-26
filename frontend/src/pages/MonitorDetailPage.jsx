import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useMonitorDetail } from '@/hooks/useMonitorDetail';
import { useCheckLogs, PAGE_SIZE } from '@/hooks/useCheckLogs';
import Spinner from '@/components/ui/Spinner';
import MonitorHeader from '@/components/monitors/MonitorHeader';
import StatsRow from '@/components/monitors/StatsRow';
import UptimeBar from '@/components/monitors/UptimeBar';
import ResponseTimeChart from '@/components/monitors/ResponseTimeChart';
import CheckHistory from '@/components/monitors/CheckHistory';

export default function MonitorDetailPage() {
  const { id } = useParams();
  const { monitor, isLoading: monitorLoading, isError: monitorError } = useMonitorDetail(id);
  const [page, setPage] = useState(0);
  const { checks: currentPage, isLoading: checksLoading } = useCheckLogs(id, page);
  const [loadedChecks, setLoadedChecks] = useState([]);

  useEffect(() => {
    if (currentPage.length === 0) return;

    if (page === 0) {
      setLoadedChecks(currentPage);
    } else {
      setLoadedChecks((prev) => {
        const existingIds = new Set(prev.map((c) => c.id));
        const newChecks = currentPage.filter((c) => !existingIds.has(c.id));
        return newChecks.length > 0 ? [...prev, ...newChecks] : prev;
      });
    }
  }, [currentPage, page]);

  const hasMore = currentPage.length === PAGE_SIZE;

  if (monitorLoading) return <Spinner />;

  if (monitorError || !monitor) {
    return (
      <div className="flex flex-col items-center justify-center min-h-96 gap-3">
        <span className="text-zinc-500">Monitor not found.</span>
        <a href="/dashboard" className="text-sm text-indigo-400 hover:text-indigo-300">
          Back to dashboard
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <MonitorHeader monitor={monitor} />
      <StatsRow monitor={monitor} stats={monitor.stats} />
      <UptimeBar rollups={monitor.stats.rollups} />
      <ResponseTimeChart rollups={monitor.stats.rollups} />
      <CheckHistory
        checks={loadedChecks}
        hasMore={hasMore}
        onLoadMore={() => setPage((p) => p + 1)}
        isLoading={checksLoading}
      />
    </div>
  );
}
