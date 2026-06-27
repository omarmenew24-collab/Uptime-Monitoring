import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import api from '@/lib/axios';
import { ENDPOINTS } from '@/lib/endpoints';

const PAGE_SIZE = 10;

export const useCheckLogs = (monitorId, page = 0) => {
  const { getToken } = useAuth();

  const fetchChecks = async () => {
    const token = await getToken();
    const res = await api.get(ENDPOINTS.MONITOR_CHECKS(monitorId), {
      headers: { Authorization: `Bearer ${token}` },
      params: { limit: PAGE_SIZE, offset: page * PAGE_SIZE },
    });
    return res.data;
  };

  const { data, isLoading, isError } = useQuery({
    queryKey: ['checks', monitorId, page],
    queryFn: fetchChecks,
    enabled: !!monitorId,
    refetchInterval: 10_000,
  });

  return { checks: data?.data ?? [], isLoading, isError };
};

export { PAGE_SIZE };
