export const ENDPOINTS = {
  MONITORS: '/api/monitors',
  MONITOR_DETAIL: (id) => `/api/monitors/${id}`,
  MONITOR_CHECKS: (id) => `/api/monitors/${id}/checks`,
};
