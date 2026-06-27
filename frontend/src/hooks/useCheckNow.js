import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import api from '@/lib/axios';
import { ENDPOINTS } from '@/lib/endpoints';

export const useCheckNow = () => {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  const { mutate: executeCheckNow, isPending } = useMutation({
    mutationFn: async (monitorId) => {
      const token = await getToken();
      const res = await api.post(ENDPOINTS.CHECK_NOW(monitorId), {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.data.data;
    },
    onSuccess: (data, monitorId) => {
      queryClient.invalidateQueries(['checks', monitorId]);
      queryClient.invalidateQueries(['monitor', monitorId]);
    },
  });

  return { executeCheckNow, isPending };
};
