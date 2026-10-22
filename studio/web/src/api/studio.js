/** Studio (console) endpoints — express router at /firmware/api. */
import { apiGet, apiPost } from './http';

export const getEnv = () => apiGet('studio/env');
export const getConfig = () => apiGet('studio/config');
export const getFirmwareList = () => apiGet('studio/firmware');
export const login = (body) => apiPost('studio/login', body, { authRedirect: false });
export const logout = () => apiPost('studio/logout', {});
