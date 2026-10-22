/**
 * Shared authorization helpers for external system endpoints.
 * Extracted from index.js setupRoutes closure.
 */

/**
 * Validate X-Xiaozhi-Key against config.voiceFlow.token.
 * @param {object} config - runtime config (live reference)
 * @param {import('express').Request} req
 * @returns {{ok:true}|{ok:false, code:number, error:string}}
 */
export function vfAuthorized(config, req) {
  const vf = config.voiceFlow || {};
  if (!vf.token) return { ok: false, code: 503, error: 'voiceFlow 未启用（服务器侧 token 未设置）' };
  const key = req.headers['x-xiaozhi-key'] || req.body?.token || '';
  if (String(key) !== String(vf.token)) return { ok: false, code: 401, error: '无效或缺失 X-Xiaozhi-Key' };
  return { ok: true };
}

/**
 * Check whether a callback URL is allowed by the SSRF whitelist.
 * @param {object} config - runtime config (live reference)
 * @param {string} urlStr
 * @returns {boolean}
 */
export function vfCallbackAllowed(config, urlStr) {
  const allow = config.voiceFlow?.callbackAllowList || [];
  if (!Array.isArray(allow) || allow.length === 0) return false;
  let u;
  try { u = new URL(urlStr); } catch { return false; }
  const host = u.hostname.toLowerCase();
  const origin = u.origin.toLowerCase();
  return allow.some((p) => {
    const s = String(p || '').trim().toLowerCase();
    if (!s) return false;
    if (s === '*') return true;
    if (s === host || s === origin) return true;
    if (s.startsWith('.') && (host === s.slice(1) || host.endsWith(s))) return true;
    return false;
  });
}
