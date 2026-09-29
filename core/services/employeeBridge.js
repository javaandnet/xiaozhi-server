import { logger } from '../../utils/logger.js';

/**
 * aiinterview 数字员工桥（员工模式）
 *
 * 设备语音在员工模式下 POST 到 aiinterview 的免登录端点
 * /api/xiaozhi/employee-turn（X-Xiaozhi-Key 共享密钥），
 * 由按设备映射的数字员工同步跑一个 chat turn 并返回回复文本。
 *
 * 配置项（config.json → employee）：
 * {
 *   "enabled": true,
 *   "baseUrl": "http://127.0.0.1:30005",
 *   "token": "<与 aiinterview 进程 env XIAOZHI_VOICE_TOKEN 相同>",
 *   "timeoutMs": 90000
 * }
 */

/** 员工模式是否可用（配置齐全才算启用） */
export function employeeModeEnabled(cfg) {
  return !!(cfg && cfg.enabled !== false && cfg.baseUrl && cfg.token);
}

/**
 * 向数字员工发起一次语音指令回合（同步等待回复）。
 * @returns {Promise<{ok:boolean, reply:string, employee:{id,name}, executed:boolean, workLogId:string|null}>}
 * @throws 网络/HTTP/业务失败时抛错，由调用方决定播报文案
 */
export async function askEmployee(cfg, deviceId, text) {
  const url = `${String(cfg.baseUrl).replace(/\/$/, '')}/api/xiaozhi/employee-turn`;
  const timeoutMs = Number(cfg.timeoutMs) || 90000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Xiaozhi-Key': String(cfg.token)
      },
      body: JSON.stringify({ deviceId, text }),
      signal: ac.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${data.error || data.message || res.statusText}`);
    }
    if (!data.ok) {
      throw new Error(data.error || '员工端点返回未知错误');
    }
    logger.info(`🧠 员工桥响应 (${((Date.now() - startedAt) / 1000).toFixed(1)}s) [${data.employee?.name || '?'}] "${String(data.reply || '').slice(0, 40)}…"`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}
