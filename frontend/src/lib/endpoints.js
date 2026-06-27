export const ENDPOINTS = {
  MONITORS: '/api/monitors',
  MONITOR_DETAIL: (id) => `/api/monitors/${id}`,
  MONITOR_CHECKS: (id) => `/api/monitors/${id}/checks`,
  MONITOR_EDIT: (id) => `/api/monitors/${id}`,
  MONITOR_PAUSE: (id) => `/api/monitors/${id}/pause`,
  MONITOR_RESUME: (id) => `/api/monitors/${id}/resume`,
  MONITOR_DELETE: (id) => `/api/monitors/${id}`,
  CHECK_NOW: (id) => `/api/monitors/${id}/check-now`,
  PUBLIC_STATUS: (userId) => `/api/status/${userId}`,
  SETTINGS: '/api/settings',
};
