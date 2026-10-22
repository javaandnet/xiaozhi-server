/** HomeKit (home devices) endpoints served by the main service. */
import { apiGet, apiPost } from './http';

export const getHomeKitStatus = () => apiGet('/api/homekit/status');

export const getHomeKitSettings = () => apiGet('/api/homekit/settings');

export const saveHomeKitSettings = (settings) => apiPost('/api/homekit/settings', settings);

export const scanHomeKit = () => apiPost('/api/homekit/scan', {});

export const getHomeKitStates = () => apiPost('/api/homekit/state', {});

export const pairHomeKit = (pin, deviceName) => apiPost('/api/homekit/pair', { pin, deviceName });

export const controlHomeKit = (light, args) => apiPost('/api/homekit/control', { light, ...args });

export const renameHomeKit = (light, name) => apiPost('/api/homekit/rename', { light, name });
