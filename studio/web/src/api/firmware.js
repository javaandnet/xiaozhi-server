/** Firmware workbench endpoints: boards, detect, releases, build, install, flash, accounts. */
import { apiGet, apiPost, apiPostStream, urlOf } from './http';

export const getBoards = (refresh = false) => apiGet(`studio/boards${refresh ? '?refresh=1' : ''}`);

export const getRecentDevices = (limit = 10) => apiGet(`studio/devices?limit=${limit}`);

export const detectBoard = () => apiGet('studio/detect');

export const checkOfficialRelease = (type) =>
  apiGet(`studio/releases${type ? `?type=${encodeURIComponent(type)}` : ''}`);

export const startBuild = (body) => apiPost('studio/build', body);

export const installFirmware = (body) => apiPost('studio/install', body);

export const deleteFirmware = (filename) => apiPost('studio/firmware/delete', { filename, confirm: true });

export const syncSource = (ref, onLine) =>
  apiPostStream('studio/sync', { ref, confirm: true }, onLine);

export const flashUsb = ({ port, board, name }, onLine) =>
  apiPostStream('studio/flash', { port, board, name, confirm: true }, onLine);

/** Build log push channel (SSE). */
export const buildEventsUrl = () => urlOf('studio/events');

export const firmwareDownloadUrl = (filename) =>
  `${urlOf('studio/firmware/download')}?file=${encodeURIComponent(filename)}`;

// ---- console accounts (admin users) ----
export const listUsers = () => apiGet('studio/users');

export const addUser = (username, password) => apiPost('studio/users/add', { username, password });

export const deleteUser = (username) => apiPost('studio/users/delete', { username });

export const setUserPassword = (username, password) => apiPost('studio/users/password', { username, password });
