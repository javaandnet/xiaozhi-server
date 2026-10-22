/** MasterPi endpoints: SSH-patched connection config, MJPEG preview, face library. */
import { apiDelete, apiGet, apiPost } from './http';

export const getMasterPiConfig = () => apiGet('studio/masterpi/config');

export const getMasterPiStatus = () => apiGet('studio/masterpi/status');

export const setMasterPiConfig = (body) => apiPost('studio/masterpi/config', body);

export const getStreamStatus = () => apiGet('studio/masterpi/stream/status');

export const startStream = () => apiPost('studio/masterpi/stream/start', {});

export const stopStream = () => apiPost('studio/masterpi/stream/stop', {});

export const listFaces = () => apiGet('studio/masterpi/faces');

export const deleteFace = (id) => apiDelete(`studio/masterpi/faces?name=${encodeURIComponent(id)}`);

export const renameFace = (body) => apiPost('studio/masterpi/faces/rename', body);

export const setFaceLogin = (on) => apiPost('studio/masterpi/faces/facelogin', { on });

export const setFaceThreshold = (value) => apiPost('studio/masterpi/faces/threshold', { value });
