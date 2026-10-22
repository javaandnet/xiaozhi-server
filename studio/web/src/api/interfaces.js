/** 接口管理：externalSystems 注册表 / sharedToken / voiceFlow SSRF 白名单（studio 端点）。 */
import { apiGet, apiPost } from './http';

export const getInterfaces = () => apiGet('studio/interfaces');

export const saveInterfaces = (body) => apiPost('studio/interfaces/save', body);
