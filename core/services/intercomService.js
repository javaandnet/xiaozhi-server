import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger.js';
import { SERVER_MESSAGE_TYPES, TTS_STATES } from '../constants/messageTypes.js';
import { fixedText } from '../constants/i18n.js';

/**
 * 对讲机（intercom）原声透传服务：双设备间 Opus 上行帧直连转发，旁路 ASR/LLM/TTS。
 *
 * 半双工 PTT 模型：
 * - 按住按键（listen mode=manual 轮）= 讲话：申请口权(floor)，上行帧字节级转发对端；
 *   松手（listen stop / 空帧）= 说完：宽限期后向对端发 tts stop(listen:disable)。
 * - 口权独占：同一房间同时只允许一个方向转发；对端讲话中申请 → 忙提示音拒绝。
 * - 回声抑制三闸：①接收端 intercomIncoming 期间丢弃其上行帧（挂在 websocket.js
 *   handleBinaryData 的广播静音闸门同一条件上）；②发送端收口：floor 释放后无口权
 *   帧直接吞掉（防止声音经对端喇叭绕回本机麦再转回去形成声学回环）；③接收端播完
 *   补一段 broadcastIgnoreUntil 宽限，吃掉尾音回声。
 * - 对讲模式下的 auto/realtime（唤醒词）轮不进透传，仍走正常识别链路，
 *   因此「退出对讲 / 呼叫X」口令随时可切换回来。
 *
 * 下行格式零转码：服务端 hello 应答原样回显设备上报的 audio_params（opus/16k/60ms），
 * 固件按 hello 声明的下行采样率自适应解码，因此本机上行帧可原样喂给对端。
 *
 * 模式进出：config.modeKeywords.intercomOn/intercomOff 词表 + 「呼叫前缀+人设名」
 * （intercomCall 前缀表），或管理端点 /api/settings/intercom 远程开关。
 * 对端缺省解析：本机 settings.intercom.peer（deviceId/clientId/人设名），或呼叫寻址。
 */
class IntercomService {
  constructor(handler) {
    this.handler = handler;
    // clientId -> room（一台设备同一时刻至多一个房间；房间双方共享同一对象）
    this.byClient = new Map();
  }

  opts() {
    const c = this.handler.config.intercom || {};
    return {
      silenceReleaseMs: c.silenceReleaseMs ?? 1200,   // 口权持有期间无上行帧超时自动收口
      maxFloorMs: c.maxFloorMs ?? 60000,               // 单次讲话硬上限
      tailGraceMs: c.tailGraceMs ?? 300,               // 松手后尾帧宽限再发 stop
      releaseGraceMs: c.releaseGraceMs ?? 800,         // 对端播完后的麦克风忽略宽限
      idleExitMs: c.idleExitMs ?? 180000               // 无活动静默退对讲（防忘退出卡模式）
    };
  }

  _t(ws, key) {
    return fixedText(this.handler.deviceLang(ws), key);
  }

  // ==================== 呼叫寻址 ====================

  /**
   * 「呼叫 + 人设名」匹配：text 归一后以 config.modeKeywords.intercomCall
   * 任一前缀开头且余量非空时返回寻址名（归一后），否则 null。
   */
  matchCall(text) {
    const list = (this.handler.config.modeKeywords || {}).intercomCall || [];
    const t = this.handler._normAddr(text);
    if (!t) return null;
    for (const p of list) {
      const np = this.handler._normAddr(p);
      if (np && t.startsWith(np) && t.length > np.length + 1) return t.slice(np.length);
    }
    return null;
  }

  /**
   * 解析对端在线连接：descriptor 可为 deviceId/clientId（大小写不敏感）或人设名。
   * 排除自身与非小智语音设备（robot/peripheral/mcp_only）。
   */
  _resolvePeer(ws, descriptor) {
    const h = this.handler;
    if (!descriptor) return null;
    const norm = h._normAddr(String(descriptor));
    for (const d of h.getBroadcastTargets(null)) {
      const conn = d.connection;
      if (!conn || conn === ws || conn.clientId === ws.clientId) continue;
      const dtype = String(conn.deviceType || '').toLowerCase();
      if (['robot', 'peripheral', 'mcp_only'].includes(dtype)) continue;
      const name = h._normAddr(((h.deviceSettings(conn).persona || {}).name || ''));
      if (h._sameIdent(d.deviceId, descriptor) || h._sameIdent(conn.clientId, descriptor) || (name && name === norm)) {
        return conn;
      }
    }
    return null;
  }

  // ==================== 模式进出 ====================

  /**
   * 进入对讲模式。peerDescriptor 为空时回落本机 settings.intercom.peer。
   * @returns {Promise<boolean>} 是否成功进入
   */
  async enter(ws, peerDescriptor = null) {
    const h = this.handler;
    if (h.config.intercom && h.config.intercom.enabled === false) {
      // 功能总开关关闭（config.intercom.enabled=false）：不进模式，仅语音告知
      logger.info(`[Intercom] feature disabled by config, refuse enter [${ws.clientId}]`);
      await h._speakFixed(ws, this._t(ws, 'intercomDisabled'));
      return false;
    }
    const desc = peerDescriptor || ((((h.deviceSettings(ws) || {}).intercom) || {}).peer) || null;
    if (ws.intercomMode) {
      // 重复进入/改拨号：已有在线房间且（未拨号或拨的就是当前对端）则幂等保留
      const room = this.byClient.get(ws.clientId);
      const livePeer = room ? this._peerOf(room, ws) : null;
      if (livePeer && livePeer.readyState === 1) {
        const target = desc ? this._resolvePeer(ws, desc) : livePeer;
        if (target === livePeer) {
          this._scheduleIdleExit(ws);
          return true;
        }
      }
      this._teardown(ws.clientId, 'rebind');
    }
    if (!desc) {
      logger.info(`[Intercom] no peer configured, refuse enter [${ws.clientId}]`);
      await h._speakFixed(ws, this._t(ws, 'intercomNoPeer'));
      return false;
    }
    const peer = this._resolvePeer(ws, desc);
    if (!peer) {
      logger.info(`[Intercom] peer offline for "${desc}", refuse enter [${ws.clientId}]`);
      await h._speakFixed(ws, this._t(ws, 'intercomPeerOffline'));
      return false;
    }
    // 对端已有旧房间（如与第三方结对）一并拆除，保证房间一对一
    this._teardown(peer.clientId, 'peer rebind');

    ws.intercomMode = true;
    ws.intercomPeerClientId = peer.clientId;
    ws.employeeMode = false; // 与其它语音模式互斥（同 practice-on 口径）
    ws.practiceMode = false;
    ws.practiceBuffer = [];

    const room = {
      members: [ws, peer],
      floor: null,           // 当前持口权的 clientId
      started: false,        // 本轮是否已向对端发过 tts start
      turnId: null,
      floorAt: 0,
      lastFrameAt: 0,
      frames: 0,
      busyNotified: false,
      timers: {}
    };
    this.byClient.set(ws.clientId, room);
    this.byClient.set(peer.clientId, room);
    h._sendMode(ws);
    this._scheduleIdleExit(ws);
    // 被叫自动入房：双向对答（电话应答模型）；但若被叫正处于口语/员工/流程采集
    // 等其它语音模式，不强占其模式标记：它仍可作为纯接收端（收流不需模式），
    // 想回话需自己退出当前模式后说进入对讲。
    if (!peer.practiceMode && !peer.employeeMode && !peer.flowCollect) {
      peer.intercomMode = true;
      peer.intercomPeerClientId = ws.clientId;
      h._sendMode(peer);
      this._scheduleIdleExit(peer);
      logger.info(`[Intercom] callee auto-joined [${peer.clientId}]`);
      // 来电提示只播报不入队等待（不阻塞主叫的进入播报）
      h._speakFixed(peer, this._t(peer, 'intercomConnected')).catch((e) => logger.warn(`[Intercom] callee announce failed: ${e.message}`));
    } else {
      logger.info(`[Intercom] callee busy in other mode, receive-only [${peer.clientId}]`);
    }
    logger.info(`[Intercom] room open: ${ws.clientId} <-> ${peer.clientId} (dialed "${desc}")`);
    await h._speakFixed(ws, this._t(ws, 'intercomEnter'));
    return true;
  }

  /** 退出对讲模式（语音口令或管理端点），双方房间整体拆除、静默复位对端展示态 */
  async exit(ws, { silent = false } = {}) {
    this._teardown(ws.clientId, silent ? 'remote off' : 'voice off');
    if (!silent) await this.handler._speakFixed(ws, this._t(ws, 'intercomExit'));
  }

  // ==================== 回合流转（websocket.js 挂钩点） ====================

  /**
   * PTT 键按下（intercomMode 下 listen start, mode=manual）。
   * @returns {Promise<boolean>} true = 本轮由对讲消费
   */
  async onListenStart(ws) {
    const room = this.byClient.get(ws.clientId);
    if (!room) {
      // 房间已随对端断开消失：清残留标记，本轮回落普通链路
      ws.intercomMode = false;
      return false;
    }
    const peer = this._peerOf(room, ws);
    if (!peer || peer.readyState !== 1) {
      this._teardown(ws.clientId, 'peer gone at press');
      ws.intercomMode = true; // 保留进入意图，提示离线后仍可再呼/退出
      this.handler.sendTtsNotice(ws, ws.sessionId, this._t(ws, 'intercomPeerOffline'));
      return true;
    }
    if (room.floor && room.floor !== ws.clientId) {
      // 半双工：对方讲话中，按键不抢口，忙提示（每段占用只提示一次）
      if (!room.busyNotified) {
        room.busyNotified = true;
        logger.info(`[Intercom] floor busy, reject ${ws.clientId} (holder ${room.floor})`);
        this.handler.sendTtsNotice(ws, ws.sessionId, this._t(ws, 'intercomBusy'));
      }
      return true;
    }
    const o = this.opts();
    room.floor = ws.clientId;
    room.started = false;
    room.frames = 0;
    room.busyNotified = false;
    room.floorAt = Date.now();
    room.lastFrameAt = Date.now();
    room.turnId = uuidv4();
    this._clearFloorTimers(room);
    room.timers.max = setTimeout(() => { this._endTurn(room, 'max floor time exceeded'); }, o.maxFloorMs);
    this._armSilence(room);
    logger.info(`[Intercom] floor granted: ${ws.clientId} -> ${peer.clientId}`);
    this._scheduleIdleExit(ws);
    return true;
  }

  /** PTT 讲话中的上行帧：口权持有则原样转发对端（首帧触发对端 tts start 与静音闸） */
  async onUplinkFrame(ws, frame) {
    const room = this.byClient.get(ws.clientId);
    if (!room) return;
    if (room.floor !== ws.clientId) {
      return; // 发送端收口闸：无口权帧静默吞掉（声学回环抑制）
    }
    const peer = this._peerOf(room, ws);
    if (!peer || peer.readyState !== 1) {
      this._teardown(ws.clientId, 'peer lost mid-stream');
      return;
    }
    if (!room.started) {
      room.started = true;
      this.handler.sendMessage(peer, {
        type: SERVER_MESSAGE_TYPES.TTS,
        session_id: room.turnId,
        state: TTS_STATES.START,
        timestamp: new Date().toISOString()
      });
      peer.intercomIncoming = true; // 接收端静音闸（handleBinaryData 条件）
      logger.info(`[Intercom] stream start: ${ws.clientId} -> ${peer.clientId}`);
    }
    try {
      peer.send(frame); // 二进制 Opus 帧原样转发
      room.frames++;
    } catch (e) {
      logger.warn(`[Intercom] frame relay failed: ${e.message}, teardown room`);
      this._teardown(ws.clientId, 'send error');
      return;
    }
    room.lastFrameAt = Date.now();
    this._armSilence(room);
    this._scheduleIdleExit(ws);
    this._scheduleIdleExit(peer); // 双向活动都要续命，避免应答方静默超时拆房
  }

  /**
   * PTT 松手（listen stop / 空帧）：尾帧宽限后收口。
   * @returns {Promise<boolean>} true = 本轮由对讲消费
   */
  async onListenStop(ws) {
    const room = this.byClient.get(ws.clientId);
    if (!room) return false;
    if (room.floor !== ws.clientId) return true; // 已被超时/异常收口，吞掉迟到的 stop
    if (!room.started) {
      // 按键即松（无语音帧）：静默释放，不打扰对端
      this._clearFloorState(room);
      logger.info(`[Intercom] empty press released [${ws.clientId}]`);
      return true;
    }
    const o = this.opts();
    this._clearFloorTimers(room);
    room.timers.tail = setTimeout(() => { this._endTurn(room, 'ptt release'); }, o.tailGraceMs);
    return true;
  }

  /** 连接断开：仅当该 ws 确为房间成员时拆房（重连的迟到 close 不误伤新房） */
  onDisconnect(ws) {
    const room = this.byClient.get(ws.clientId);
    if (room && room.members.includes(ws)) {
      this._teardown(ws.clientId, 'disconnect');
    }
    if (ws._intercomIdleTimer) {
      clearTimeout(ws._intercomIdleTimer);
      ws._intercomIdleTimer = null;
    }
  }

  // ==================== 内部 ====================

  _peerOf(room, ws) {
    return room.members.find((m) => m !== ws) || null;
  }

  _sameIdent(a, b) {
    return this.handler._sameIdent(a, b);
  }

  _armSilence(room) {
    clearTimeout(room.timers.silence);
    room.timers.silence = setTimeout(() => {
      if (Date.now() - room.lastFrameAt >= this.opts().silenceReleaseMs) {
        this._endTurn(room, 'silence timeout');
      }
    }, this.opts().silenceReleaseMs);
  }

  _clearFloorTimers(room) {
    clearTimeout(room.timers.silence);
    clearTimeout(room.timers.max);
    clearTimeout(room.timers.tail);
    room.timers = {};
  }

  /** 释放口权（不发对端消息、不动接收闸）：空按键/异常路径用 */
  _clearFloorState(room) {
    this._clearFloorTimers(room);
    room.floor = null;
    room.started = false;
    room.busyNotified = false;
  }

  /** 正常收口：向接收端发 tts stop(listen:disable) 并复位双方闸门与口权 */
  _endTurn(room, reason) {
    const [a, b] = room.members;
    const sender = a.clientId === room.floor ? a : b;
    const peer = this._peerOf(room, sender);
    if (room.started && peer && peer.readyState === 1) {
      this.handler.sendMessage(peer, {
        type: SERVER_MESSAGE_TYPES.TTS,
        session_id: room.turnId,
        state: TTS_STATES.STOP,
        listen: 'disable', // 播完不回倾听，直接回 idle/休息（PTT 接收端语义）
        timestamp: new Date().toISOString()
      });
      const dur = Date.now() - (room.floorAt || Date.now());
      logger.info(`[Intercom] stream end (${reason}): ${sender.clientId} -> ${peer.clientId}, ${room.frames} frames / ${dur}ms`);
    }
    if (peer) {
      peer.intercomIncoming = false;
      const grace = Date.now() + this.opts().releaseGraceMs;
      peer.broadcastIgnoreUntil = Math.max(peer.broadcastIgnoreUntil || 0, grace);
    }
    this._clearFloorState(room);
  }

  /** 拆房：清空口权与闸门，双方退出对讲展示态（对端可能本未进入模式，_sendMode 兜底刷新标签） */
  _teardown(clientId, reason) {
    const room = this.byClient.get(clientId);
    if (!room) return;
    const [a, b] = room.members;
    this.byClient.delete(a.clientId);
    this.byClient.delete(b.clientId);
    if (room.floor && room.started) this._endTurn(room, `room teardown (${reason})`);
    else this._clearFloorState(room);
    for (const m of [a, b]) {
      m.intercomMode = false;
      m.intercomIncoming = false;
      m.intercomPeerClientId = null;
      if (m._intercomIdleTimer) {
        clearTimeout(m._intercomIdleTimer);
        m._intercomIdleTimer = null;
      }
      if (m.readyState === 1) {
        try { this.handler._sendMode(m); } catch { /* connection may be closing; label refresh is best-effort */ }
      }
    }
    logger.info(`[Intercom] room closed (${reason}): ${a.clientId} <-> ${b.clientId}`);
  }

  /** 无活动静默退出：只作用于主动进入方；对端（未进模式的被动收方）不受影响 */
  _scheduleIdleExit(ws) {
    clearTimeout(ws._intercomIdleTimer);
    ws._intercomIdleTimer = setTimeout(() => {
      ws._intercomIdleTimer = null;
      if (!ws.intercomMode) return;
      logger.info(`[Intercom] idle timeout, silent exit [${ws.clientId}]`);
      this.exit(ws, { silent: true });
    }, this.opts().idleExitMs);
  }
}

export default IntercomService;
