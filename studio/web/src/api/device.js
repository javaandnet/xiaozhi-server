/** Device registry + live session endpoints served by the main xiaozhi channel. */
import { apiGet, apiPost } from './http';

const PAGE_SIZE = 50;

export function listKnownDevices(page = 1) {
  return apiGet(`/api/devices/known?limit=${PAGE_SIZE}&offset=${(page - 1) * PAGE_SIZE}`);
}

export const listLiveDevices = () => apiGet('/api/devices');

export const deleteDevice = (deviceId) => apiPost('/api/devices/delete', { deviceId });

export const getDeviceStats = () => apiGet('/api/devices/stats');

export function listConversations({ deviceId = '', role = '', page = 1 } = {}) {
  const q = new URLSearchParams({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  if (deviceId) q.set('deviceId', deviceId);
  if (role) q.set('role', role);
  return apiGet(`/api/conversations?${q}`);
}

export const getWebsocketUrls = () => apiGet('/api/websocket/urls');

export const getHealth = () => apiGet('/health');
