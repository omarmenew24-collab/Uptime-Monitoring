import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';
import { ENDPOINTS } from '@/lib/endpoints';

export const usePublicStatus = (userId) => {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['status', userId],
    queryFn: async () => {
      const res = await api.get(ENDPOINTS.PUBLIC_STATUS(userId));
      return res.data;
    },
    enabled: !!userId,
    refetchInterval: 30_000,
  });

  return { status: data?.data ?? null, isLoading, isError };
};
