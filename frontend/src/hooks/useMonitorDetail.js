import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import api from '@/lib/axios';
import { ENDPOINTS } from '@/lib/endpoints';

export const useMonitorDetail = (monitorId) => {
  const { getToken } = useAuth();

  const fetchMonitor = async () => {
    const token = await getToken();
    const res = await api.get(ENDPOINTS.MONITOR_DETAIL(monitorId), {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.data;
  };

  const { data, isLoading, isError } = useQuery({
    queryKey: ['monitor', monitorId],
    queryFn: fetchMonitor,
    enabled: !!monitorId,
    refetchInterval: 10_000,
  });

  return { monitor: data?.data ?? null, isLoading, isError };
};
