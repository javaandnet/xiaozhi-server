/** MasterPi endpoints: SSH-patched connection config, MJPEG preview, face library. */
import { apiDelete, apiGet, apiPost } from './http';

export const getMasterPiConfig = () => apiGet('studio/masterpi/config');

export const getMasterPiStatus = () => apiGet('studio/masterpi/status');

export const setMasterPiConfig = (body) => apiPost('studio/masterpi/config', body);

// MJPEG 预览控制已改走主通道 /api/masterpi/stream/*（见 api/mcp.js 的 *Xz 端点，
// 云端 hub 侧经 peer 链路转发家里）；studio/masterpi/stream/* 后端仍保留供旧页面用。

export const listFaces = () => apiGet('studio/masterpi/faces');

export const deleteFace = (id) => apiDelete(`studio/masterpi/faces?name=${encodeURIComponent(id)}`);

export const renameFace = (body) => apiPost('studio/masterpi/faces/rename', body);

export const setFaceLogin = (on) => apiPost('studio/masterpi/faces/facelogin', { on });

export const setFaceThreshold = (value) => apiPost('studio/masterpi/faces/threshold', { value });
