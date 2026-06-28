import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import api from '@/lib/axios';
import { ENDPOINTS } from '@/lib/endpoints';

export const useCheckNow = () => {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  const { mutate, isPending } = useMutation({
    mutationFn: async (monitorId) => {
      const token = await getToken();
      const res = await api.post(ENDPOINTS.CHECK_NOW(monitorId), {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.data.data;
    },
    onSuccess: (data, monitorId) => {
      queryClient.invalidateQueries({ queryKey: ['checks', monitorId] });
      queryClient.invalidateQueries({ queryKey: ['monitor', monitorId] });
    },
  });

  const executeCheckNow = (monitorId, options = {}) => {
    mutate(monitorId, options);
  };

  return { executeCheckNow, isPending };
};
