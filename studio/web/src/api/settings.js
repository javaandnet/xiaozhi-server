/** Runtime settings endpoints (global VAD/language/practice + per-device override). */
import { apiGet, apiPost } from './http';

export const getAudioThresholds = () => apiGet('/api/settings/audio');
export const setAudioThresholds = (body) => apiPost('/api/settings/audio', body);

export const getDefaultLanguage = () => apiGet('/api/settings/language');
export const setDefaultLanguage = (body) => apiPost('/api/settings/language', body);

export const getPracticeSettings = () => apiGet('/api/settings/practice');
export const setPracticeSettings = (body) => apiPost('/api/settings/practice', body);

export const getDeviceSettings = (deviceId) =>
  apiGet(`/api/settings/device?deviceId=${encodeURIComponent(deviceId)}`);
export const setDeviceSettings = (body) => apiPost('/api/settings/device', body);
