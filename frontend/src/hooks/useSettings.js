import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import { toast } from 'sonner';
import api from '@/lib/axios';
import { ENDPOINTS } from '@/lib/endpoints';

export const useGetSettings = () => {
  const { getToken } = useAuth();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const token = await getToken();
      const res = await api.get(ENDPOINTS.SETTINGS, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.data;
    },
  });

  return { settings: data?.data ?? null, isLoading, isError };
};

export const useUpdateSettings = () => {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  const { mutateAsync: updateSettings, isPending } = useMutation({
    mutationFn: async (data) => {
      const token = await getToken();
      const res = await api.patch(ENDPOINTS.SETTINGS, data, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.data;
    },
    onSuccess: () => {
      toast.success('Settings saved');
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error) => {
      toast.error(error.response?.data?.error || 'Failed to save settings');
    },
  });

  return { updateSettings, isPending };
};
