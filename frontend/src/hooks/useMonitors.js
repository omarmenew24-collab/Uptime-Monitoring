import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import { toast } from 'sonner';
import api from '@/lib/axios';
import { ENDPOINTS } from '@/lib/endpoints';

export const useGetMonitors = () => {
  const { getToken } = useAuth();

  const fetchMonitors = async () => {
    const token = await getToken();
    const res = await api.get(ENDPOINTS.MONITORS, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.data;
  };

  const {
    data,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['monitors'],
    queryFn: fetchMonitors,
  });

  return { monitors: data?.data ?? [], isLoading, isError };
};

export const useCreateMonitor = () => {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  const createMonitor = async (monitorData) => {
    const token = await getToken();
    const res = await api.post(ENDPOINTS.MONITORS, monitorData, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.data;
  };

  const {
    mutateAsync: createMyMonitor,
    isPending,
    isError,
    isSuccess,
  } = useMutation({
    mutationFn: createMonitor,
    onSuccess: () => {
      toast.success('Monitor created successfully!');
      queryClient.invalidateQueries({ queryKey: ['monitors'] });
    },
    onError: (error) => {
      toast.error(error.response?.data?.error || 'Failed to create monitor');
    },
  });

  return { createMyMonitor, isPending, isError, isSuccess };
};
