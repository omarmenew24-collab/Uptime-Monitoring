import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useMonitorDetail } from '@/hooks/useMonitorDetail';
import { useCheckLogs, PAGE_SIZE } from '@/hooks/useCheckLogs';
import MonitorHeader from '@/components/monitors/MonitorHeader';
import StatsRow from '@/components/monitors/StatsRow';
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

  if (monitorLoading) return null;

  if (monitorError || !monitor) {
    return (
      <div className="flex items-center justify-center min-h-96 text-zinc-500">
        Monitor not found.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <MonitorHeader monitor={monitor} />
      <StatsRow monitor={monitor} stats={monitor.stats} />
      <CheckHistory
        checks={loadedChecks}
        hasMore={hasMore}
        onLoadMore={() => setPage((p) => p + 1)}
        isLoading={checksLoading}
      />
    </div>
  );
}
