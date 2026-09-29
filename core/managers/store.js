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

import Database from 'better-sqlite3';
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
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');

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
    } catch (error) {
      // 数据库不可用不阻断频道启动，降级为内存 no-op
      this.disabled = true;
      this.db = null;
      logger.error(`XiaozhiStore 初始化失败（持久化已禁用）: ${error.message}`);
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
        info.deviceId, info.clientId || null, info.name || null, info.type || null,
        info.model || null, info.version || null, info.mac || null, info.ip || null,
        info.source || 'ws', online, connectInc, now, now,
        online, connectInc
      );
    } catch (error) {
      logger.warn(`设备登记失败（忽略）: ${error.message}`);
    }
  }

  /** 标记设备离线（WebSocket 断开时调用） */
  markDeviceOffline(deviceId) {
    if (this.disabled || !deviceId) return;
    try {
      this.db.prepare(`
        UPDATE ${TABLE_DEVICES} SET online = 0, last_seen = ? WHERE device_id = ?
      `).run(Date.now(), deviceId);
    } catch (error) {
      logger.warn(`设备离线标记失败（忽略）: ${error.message}`);
    }
  }

  /** 已知设备列表（含离线） */
  listDevices({ limit = 100, offset = 0 } = {}) {
    if (this.disabled) return { total: 0, items: [] };
    try {
      const total = this.db.prepare(`SELECT COUNT(*) AS c FROM ${TABLE_DEVICES}`).get().c;
      const items = this.db.prepare(`
        SELECT * FROM ${TABLE_DEVICES} ORDER BY last_seen DESC LIMIT ? OFFSET ?
      `).all(limit, offset);
      return { total, items };
    } catch (error) {
      logger.error(`查询设备列表失败: ${error.message}`);
      return { total: 0, items: [] };
    }
  }

  // ==================== 对话记录 ====================

  /**
   * 记录一条对话
   * @param {Object} entry - {sessionId, deviceId, clientId, questId, role, text, emotion, provider}
   */
  logConversation(entry = {}) {
    if (this.disabled) return;
    const text = typeof entry.text === 'string' ? entry.text.trim() : '';
    if (!text || !entry.role) return;
    try {
      this.db.prepare(`
        INSERT INTO ${TABLE_CONVERSATIONS}
          (session_id, device_id, client_id, quest_id, role, text, emotion, provider, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.sessionId || null, entry.deviceId || null, entry.clientId || null,
        entry.questId || null, entry.role, text, entry.emotion || null,
        entry.provider || null, Date.now()
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
