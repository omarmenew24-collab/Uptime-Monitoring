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
    refetchInterval: 10_000,
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

export const usePauseMonitor = () => {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  const { mutateAsync: pauseMonitor, isPending } = useMutation({
    mutationFn: async (monitorId) => {
      const token = await getToken();
      return api.patch(ENDPOINTS.MONITOR_PAUSE(monitorId), {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
    },
    onSuccess: (_, monitorId) => {
      toast.success('Monitor paused');
      queryClient.invalidateQueries({ queryKey: ['monitors'] });
      queryClient.invalidateQueries({ queryKey: ['monitor', monitorId] });
    },
    onError: () => toast.error('Failed to pause monitor'),
  });

  return { pauseMonitor, isPending };
};

export const useResumeMonitor = () => {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  const { mutateAsync: resumeMonitor, isPending } = useMutation({
    mutationFn: async (monitorId) => {
      const token = await getToken();
      return api.patch(ENDPOINTS.MONITOR_RESUME(monitorId), {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
    },
    onSuccess: (_, monitorId) => {
      toast.success('Monitor resumed');
      queryClient.invalidateQueries({ queryKey: ['monitors'] });
      queryClient.invalidateQueries({ queryKey: ['monitor', monitorId] });
    },
    onError: () => toast.error('Failed to resume monitor'),
  });

  return { resumeMonitor, isPending };
};

export const useDeleteMonitor = () => {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  const { mutateAsync: deleteMonitor, isPending } = useMutation({
    mutationFn: async (monitorId) => {
      const token = await getToken();
      return api.delete(ENDPOINTS.MONITOR_DELETE(monitorId), {
        headers: { Authorization: `Bearer ${token}` },
      });
    },
    onSuccess: () => {
      toast.success('Monitor deleted');
      queryClient.invalidateQueries({ queryKey: ['monitors'] });
    },
    onError: () => toast.error('Failed to delete monitor'),
  });

  return { deleteMonitor, isPending };
};
