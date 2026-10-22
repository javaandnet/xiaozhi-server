/** Voice-side endpoints: TTS broadcast, wake-up (exit rest), disconnect, text command. */
import { apiPost } from './http';

export const broadcast = (body) => apiPost('/api/broadcast', body);
export const wake = (body) => apiPost('/api/wake', body);
export const disconnect = (clientId) => apiPost('/api/disconnect', { clientId });
export const sendDeviceCommand = (body) => apiPost('/api/device/command', body);
