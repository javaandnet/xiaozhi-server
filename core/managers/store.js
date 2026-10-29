/**
 * XiaozhiStore - 设备注册表与对话记录持久化
 *
 * 库文件：workspace/db/gala.db（与平台主库共用，独立表前缀 xz_）
 * - xz_devices       已知设备（OTA 上报 / WebSocket 接入均登记，含离线设备）
 * - xz_conversations 对话记录（每轮 user 输入与 bot 回复各一条）
 *
 * 设计约束：Store 写入失败绝不能影响语音对话主流程，
 * 所有写方法内部捕获异常并降级为 no-op（logger.warn）。
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// standalone 默认库：项目内 data/xz.db；可用环境变量 XZ_DB_PATH 覆盖（如需仍指向共享 gala.db）
function defaultDbPath() {
  const env = process.env.XZ_DB_PATH;
  if (env) return path.resolve(env);
  return path.join(__dirname, '..', '..', 'data', 'xz.db');
}

const TABLE_DEVICES = 'xz_devices';
const TABLE_CONVERSATIONS = 'xz_conversations';

class XiaozhiStore {
  constructor(dbPath = null) {
    this.dbPath = dbPath || defaultDbPath();
    this.db = null;
    this.disabled = false;
    this.init();
  }

  init() {
    try {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec('PRAGMA journal_mode = WAL');

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ${TABLE_DEVICES} (
          device_id TEXT PRIMARY KEY,
          client_id TEXT,
          name TEXT,
          type TEXT,
          model TEXT,
          firmware_version TEXT,
          mac TEXT,
          ip TEXT,
          source TEXT DEFAULT 'ws',
          online INTEGER DEFAULT 0,
          connect_count INTEGER DEFAULT 0,
          first_seen INTEGER NOT NULL,
          last_seen INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ${TABLE_CONVERSATIONS} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT,
          device_id TEXT,
          client_id TEXT,
          quest_id TEXT,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          emotion TEXT,
          provider TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_xz_conv_device_time ON ${TABLE_CONVERSATIONS}(device_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_xz_conv_time ON ${TABLE_CONVERSATIONS}(created_at);
        CREATE INDEX IF NOT EXISTS idx_xz_dev_last_seen ON ${TABLE_DEVICES}(last_seen);
      `);
      logger.info(`XiaozhiStore 已初始化: ${this.dbPath}`);
      // 迁移：devices 表补 per-device 设定列（JSON：language/audio 等，缺省跟随全局）
      const cols = this.db.prepare(`PRAGMA table_info(${TABLE_DEVICES})`).all();
      if (!cols.some((c) => c.name === 'settings')) {
        this.db.exec(`ALTER TABLE ${TABLE_DEVICES} ADD COLUMN settings TEXT`);
        logger.info(`XiaozhiStore: ${TABLE_DEVICES} 已补 settings 列`);
      }
      // 迁移：休息模式持久标记（设备进休后断开 WS 仍能展示为“休息”，而非“离线”）
      if (!cols.some((c) => c.name === 'resting')) {
        this.db.exec(`ALTER TABLE ${TABLE_DEVICES} ADD COLUMN resting INTEGER DEFAULT 0`);
        logger.info(`XiaozhiStore: ${TABLE_DEVICES} 已补 resting 列`);
      }
      // 迁移：conversations 表补说话人列（声纹识别/默认单一说话人）
      const convCols = this.db.prepare(`PRAGMA table_info(${TABLE_CONVERSATIONS})`).all();
      if (!convCols.some((c) => c.name === 'speaker')) {
        this.db.exec(`ALTER TABLE ${TABLE_CONVERSATIONS} ADD COLUMN speaker TEXT`);
        logger.info(`XiaozhiStore: ${TABLE_CONVERSATIONS} 已补 speaker 列`);
      }
      this.healIdentityFragments();
    } catch (error) {
      // 数据库不可用不阻断频道启动，降级为内存 no-op
      this.disabled = true;
      this.db = null;
      logger.error(`XiaozhiStore 初始化失败（持久化已禁用）: ${error.message}`);
    }
  }

  // ==================== 设备身份归一 ====================

  /** 身份键归一：去空白 + 转小写（与展示层 _normKey 同一口径） */
  _normIdent(v) {
    return String(v == null ? '' : v).trim().toLowerCase();
  }

  /**
   * 同一物理设备的所有行（幂等迁移）：
   * 历史上设备上报的 device_id 大小写不一（如 mac 的大/小写），裂成多行后
   * 设定只存在其中一行，精确匹配读就“静默丢设定”。此处把已存设定补齐到同身份的其他行。
   */
  healIdentityFragments() {
    if (this.disabled || !this.db) return 0;
    try {
      const rows = this.db.prepare(`SELECT device_id, mac, settings FROM ${TABLE_DEVICES}`).all();
      const groups = new Map();
      for (const r of rows) {
        const key = this._normIdent((r.mac && String(r.mac).trim()) || r.device_id) || this._normIdent(r.device_id);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      let healed = 0;
      for (const [, g] of groups) {
        if (g.length < 2) continue;
        const src = g.find((r) => r.settings);
        if (!src) continue;
        for (const r of g) {
          if (r.settings === src.settings) continue;
          this.db.prepare(`UPDATE ${TABLE_DEVICES} SET settings = ? WHERE device_id = ?`).run(src.settings, r.device_id);
          healed++;
        }
      }
      if (healed) logger.info(`XiaozhiStore: 已补齐 ${healed} 行的 per-device 设定（同一设备身份裂行修正）`);
      return healed;
    } catch (error) {
      logger.warn(`设备身份归一迁移失败（忽略）: ${error.message}`);
      return 0;
    }
  }

  // ==================== 设备注册 ====================

  /**
   * 登记/更新设备（OTA 上报与 WS 接入共用）
   * @param {Object} info - {deviceId, clientId, name, model, version, mac, ip, type, source, online}
   */
  recordDevice(info = {}) {
    if (this.disabled || !info.deviceId) return;
    try {
      const now = Date.now();
      const online = info.online === undefined ? null : (info.online ? 1 : 0);
      const connectInc = info.newConnection ? 1 : 0;

      // 身份归一：同一物理设备（device_id 或 mac 小写后相等）已登记则回写那一行，
      // 避免大小写变体裂成新行导致 per-device 设定分散。
      const id = String(info.deviceId).trim();
      const canon = this.db.prepare(`
        SELECT device_id FROM ${TABLE_DEVICES}
        WHERE LOWER(device_id) = LOWER(?) OR (mac IS NOT NULL AND LOWER(mac) = LOWER(?))
        ORDER BY last_seen DESC LIMIT 1
      `).get(id, id);
      const targetId = (canon && canon.device_id) ? canon.device_id : id;

      this.db.prepare(`
        INSERT INTO ${TABLE_DEVICES}
          (device_id, client_id, name, type, model, firmware_version, mac, ip, source, online, connect_count, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          client_id        = COALESCE(excluded.client_id, client_id),
          name             = COALESCE(excluded.name, name),
          type             = COALESCE(excluded.type, type),
          model            = COALESCE(excluded.model, model),
          firmware_version = COALESCE(excluded.firmware_version, firmware_version),
          mac              = COALESCE(excluded.mac, mac),
          ip               = COALESCE(excluded.ip, ip),
          source           = excluded.source,
          online           = COALESCE(?, online),
          connect_count    = connect_count + ?,
          last_seen        = excluded.last_seen
      `).run(
        targetId, info.clientId || null, info.name || null, info.type || null,
        info.model || null, info.version || null, info.mac || null, info.ip || null,
        info.source || 'ws', online, connectInc, now, now,
        online, connectInc
      );
    } catch (error) {
      logger.warn(`设备登记失败（忽略）: ${error.message}`);
    }
  }

  /** 读 per-device 设定（JSON）；无行/无设定返回 null
   *  身份按小写归一匹配（device_id 或 mac），优先取带设定且最近上报的那行 */
  getDeviceSettings(deviceId) {
    if (this.disabled || !deviceId) return null;
    try {
      const rows = this.db.prepare(`
        SELECT settings FROM ${TABLE_DEVICES}
        WHERE LOWER(device_id) = LOWER(?) OR (mac IS NOT NULL AND LOWER(mac) = LOWER(?))
        ORDER BY (settings IS NULL) ASC, last_seen DESC
      `).all(String(deviceId).trim(), String(deviceId).trim());
      const hit = rows.find((r) => r.settings);
      if (!hit) return null;
      return JSON.parse(hit.settings);
    } catch (e) {
      logger.warn(`getDeviceSettings 失败(${deviceId}): ${e.message}`);
      return null;
    }
  }

  /** 反查绑定到某机器人身体（settings.robot.body）的小智语音设备。
   *  bodyKey 大小写不敏感；多台命中优先取在线行。无命中返回 null。
   *  用于跨实例场景：本机（branch）持有绑定关系但语音设备连在对端（hub）时，
   *  先解析出 deviceId，再带 deviceId 走 peer 转发。 */
  findVoiceDeviceByBody(bodyKey) {
    if (this.disabled || !bodyKey) return null;
    const want = String(bodyKey).trim().toLowerCase();
    if (!want) return null;
    try {
      const rows = this.db.prepare(
        `SELECT device_id, mac, settings, online FROM ${TABLE_DEVICES} WHERE settings IS NOT NULL ORDER BY online DESC, last_seen DESC`
      ).all();
      for (const r of rows) {
        let s;
        try { s = JSON.parse(r.settings); } catch { continue; }
        const body = s && s.robot && s.robot.body ? String(s.robot.body).trim().toLowerCase() : null;
        if (body && body === want) return r.device_id || r.mac || null;
      }
      return null;
    } catch (e) {
      logger.warn(`findVoiceDeviceByBody 失败(${bodyKey}): ${e.message}`);
      return null;
    }
  }

  /** 写 per-device 设定（整体覆盖）；仅限已登记设备，无行返回 false
   *  同身份的所有同步行，保证后续无论设备以哪种大小写上报都读到同一设定 */
  setDeviceSettings(deviceId, settings = {}) {
    if (this.disabled || !deviceId) return false;
    try {
      const now = Date.now();
      const val = JSON.stringify(settings || {});
      const r = this.db.prepare(`
        UPDATE ${TABLE_DEVICES} SET settings = ?, last_seen = ?
        WHERE LOWER(device_id) = LOWER(?) OR (mac IS NOT NULL AND LOWER(mac) = LOWER(?))
      `).run(val, now, String(deviceId).trim(), String(deviceId).trim());
      return r.changes > 0;
    } catch (e) {
      logger.error(`setDeviceSettings 失败(${deviceId}): ${e.message}`);
      return false;
    }
  }

  /** 标记设备离线（WebSocket 断开时调用） */
  markDeviceOffline(deviceId) {
    if (this.disabled || !deviceId) return;
    try {
      this.db.prepare(`
        UPDATE ${TABLE_DEVICES} SET online = 0, last_seen = ?
        WHERE LOWER(device_id) = LOWER(?) OR (mac IS NOT NULL AND LOWER(mac) = LOWER(?))
      `).run(Date.now(), String(deviceId).trim(), String(deviceId).trim());
    } catch (error) {
      logger.warn(`设备离线标记失败（忽略）: ${error.message}`);
    }
  }

  /**
   * 复位所有陈旧在线标记（进程新起时调用）：
   * 此时尚未建立任何 WS 连接，DB 里 online=1 均为上一进程强杀/掉线未走 close 复位的残留，一律置 0。
   */
  markAllOffline() {
    if (this.disabled) return 0;
    try {
      const r = this.db.prepare(`UPDATE ${TABLE_DEVICES} SET online = 0 WHERE online = 1`).run();
      return (r && r.changes) || 0;
    } catch (error) {
      logger.warn(`在线标记复位失败（忽略）: ${error.message}`);
      return 0;
    }
  }

  /** 标记设备休息态（进休置 1、退出/唤醒/重连置 0）：仅改 resting，不动 last_seen */
  markDeviceRest(deviceId, resting = 1) {
    if (this.disabled || !deviceId) return;
    try {
      this.db.prepare(`UPDATE ${TABLE_DEVICES} SET resting = ? WHERE LOWER(device_id) = LOWER(?) OR (mac IS NOT NULL AND LOWER(mac) = LOWER(?))`).run(resting ? 1 : 0, String(deviceId).trim(), String(deviceId).trim());
    } catch (error) {
      logger.warn(`设备休息标记失败（忽略）: ${error.message}`);
    }
  }

  /** 归一化设备身份键：优先用 mac，mac 缺失时回退 device_id；统一小写去空白。
   *  同一物理设备（相同 mac）无论 device_id 大小写/历史残留，都归为一台。 */
  _normKey(row = {}) {
    const raw = (row.mac && String(row.mac).trim()) || (row.device_id && String(row.device_id).trim()) || '';
    return raw.toLowerCase();
  }

  /** 已知设备列表（含离线）；按 mac 归一合并，同一物理设备只展示一条 */
  listDevices({ limit = 100, offset = 0 } = {}) {
    if (this.disabled) return { total: 0, items: [] };
    try {
      const rows = this.db.prepare(`SELECT * FROM ${TABLE_DEVICES} ORDER BY last_seen DESC`).all();
      const groups = new Map();
      for (const r of rows) {
        const key = this._normKey(r);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      const merged = [];
      for (const [key, g] of groups) {
        // 代表行：优先带 settings 的那条（保证 ⚙语音/设定读到已存值），否则取最近一条（rows 已按 last_seen DESC）
        const rep = g.find((r) => r.settings) || g[0];
        const lastSeen = Math.max(...g.map((r) => Number(r.last_seen) || 0));
        const firstSeen = Math.min(...g.map((r) => Number(r.first_seen) || lastSeen));
        merged.push({
          ...rep,
          mac: rep.mac || key,
          online: g.some((r) => Number(r.online) === 1) ? 1 : 0,
          resting: g.some((r) => Number(r.resting) === 1) ? 1 : 0,
          connect_count: g.reduce((s, r) => s + (Number(r.connect_count) || 0), 0),
          last_seen: lastSeen,
          first_seen: firstSeen,
          device_ids: g.map((r) => r.device_id),
          merged: g.length
        });
      }
      merged.sort((a, b) => (Number(b.last_seen) || 0) - (Number(a.last_seen) || 0));
      const total = merged.length;
      const items = merged.slice(offset, offset + limit);
      return { total, items };
    } catch (error) {
      logger.error(`查询设备列表失败: ${error.message}`);
      return { total: 0, items: [] };
    }
  }

  /** 删除设备：按 mac 归一键删除同一物理设备的全部行（历史大小写/残留合并删除）；返回删除条数 */
  deleteDevice(deviceId) {
    if (this.disabled || !deviceId) return 0;
    try {
      const row = this.db.prepare(`SELECT device_id, mac FROM ${TABLE_DEVICES} WHERE device_id = ?`).get(deviceId);
      if (!row) return 0;
      const key = this._normKey(row);
      const all = this.db.prepare(`SELECT device_id, mac FROM ${TABLE_DEVICES}`).all();
      const ids = all.filter((r) => this._normKey(r) === key).map((r) => r.device_id);
      const del = this.db.prepare(`DELETE FROM ${TABLE_DEVICES} WHERE device_id = ?`);
      let n = 0;
      for (const id of ids) n += del.run(id).changes;
      logger.info(`设备删除: key=${key} 共 ${n} 条`);
      return n;
    } catch (error) {
      logger.error(`deleteDevice 失败(${deviceId}): ${error.message}`);
      return 0;
    }
  }

  // ==================== 对话记录 ====================

  /**
   * 记录一条对话
   * @param {Object} entry - {sessionId, deviceId, clientId, questId, role, text, emotion, provider, speaker}
   */
  logConversation(entry = {}) {
    if (this.disabled) return;
    const text = typeof entry.text === 'string' ? entry.text.trim() : '';
    if (!text || !entry.role) return;
    try {
      this.db.prepare(`
        INSERT INTO ${TABLE_CONVERSATIONS}
          (session_id, device_id, client_id, quest_id, role, text, emotion, provider, speaker, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.sessionId || null, entry.deviceId || null, entry.clientId || null,
        entry.questId || null, entry.role, text, entry.emotion || null,
        entry.provider || null, entry.speaker || null, Date.now()
      );
    } catch (error) {
      logger.warn(`对话记录写入失败（忽略）: ${error.message}`);
    }
  }

  /**
   * 查询对话记录（时间倒序返回，前端展示时自行反转）
   * @param {Object} query - {deviceId, role, limit, offset}
   */
  listConversations({ deviceId = null, role = null, limit = 50, offset = 0 } = {}) {
    if (this.disabled) return { total: 0, items: [] };
    try {
      const where = [];
      const params = [];
      if (deviceId) { where.push('device_id = ?'); params.push(deviceId); }
      if (role) { where.push('role = ?'); params.push(role); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const total = this.db.prepare(
        `SELECT COUNT(*) AS c FROM ${TABLE_CONVERSATIONS} ${whereSql}`
      ).get(...params).c;
      const items = this.db.prepare(`
        SELECT * FROM ${TABLE_CONVERSATIONS} ${whereSql}
        ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
      `).all(...params, limit, offset);
      return { total, items };
    } catch (error) {
      logger.error(`查询对话记录失败: ${error.message}`);
      return { total: 0, items: [] };
    }
  }

  // ==================== 统计 ====================

  getStats() {
    const stats = {
      enabled: !this.disabled,
      devices: { total: 0, online: 0 },
      conversations: { total: 0, today: 0 }
    };
    if (this.disabled) return stats;
    try {
      stats.devices.total = this.db.prepare(`SELECT COUNT(*) AS c FROM ${TABLE_DEVICES}`).get().c;
      stats.devices.online = this.db.prepare(`SELECT COUNT(*) AS c FROM ${TABLE_DEVICES} WHERE online = 1`).get().c;
      stats.conversations.total = this.db.prepare(`SELECT COUNT(*) AS c FROM ${TABLE_CONVERSATIONS}`).get().c;
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      stats.conversations.today = this.db.prepare(
        `SELECT COUNT(*) AS c FROM ${TABLE_CONVERSATIONS} WHERE created_at >= ?`
      ).get(midnight.getTime()).c;
    } catch (error) {
      logger.warn(`统计查询失败（忽略）: ${error.message}`);
    }
    return stats;
  }

  close() {
    try {
      if (this.db) this.db.close();
    } catch { /* ignore */ }
    this.db = null;
  }
}

export default XiaozhiStore;
