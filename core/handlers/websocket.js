import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger.js';
import {
  CHAT_STATES,
  CLIENT_MESSAGE_TYPES,
  LISTEN_STATES,
  SERVER_MESSAGE_TYPES,
  TTS_STATES
} from '../constants/messageTypes.js';
import DeviceManager from '../managers/device.js';
import DeviceModel from '../models/device.js';
import McpService, { ToolType } from '../services/mcp.js';
import ACTION_TYPES from '../services/robotActions.js';
import { getQuestManager } from '../managers/quest.js';
import { audioConverter } from '../utils/audioConverter.js';
import { analyzeAudioGate } from '../utils/audioGate.js';
import { resolveMockFlags } from '../utils/devMode.js';
import TtsCache from '../utils/ttsCache.js';
import { STATUS_TEXTS, PRACTICE_STATUS_OVERRIDES, PRACTICE_STATUS_CONTINUE, REST_STATUS_OVERRIDES, MODE_LABELS, currentLang, fixedText } from '../constants/i18n.js';
import { employeeModeEnabled, askEmployee } from '../services/employeeBridge.js';

/**
 * WebSocket 处理器
 * 负责连接管理、消息处理、业务逻辑
 * 参照Python实现：receiveAudioHandle.py
 */
class WebSocketHandler {
  constructor(options = {}) {
    this.wss = options.wss;
    this.heartbeatInterval = null;
    this.config = options.config || {};
    this.deviceManager = options.deviceManager;
    this.sessionManager = options.sessionManager;
    this.audioManager = options.audioManager;
    this.ttsService = options.ttsService;
    this.sttService = options.sttService;
    this.llmService = options.llmService;
    this.vadService = options.vadService;
    this.mcpService = options.mcpService || new McpService();
    this.voiceprintService = options.voiceprintService;
    this.questManager = options.questManager || getQuestManager();
    // 持久化 Store（设备注册表/对话记录，可为空）
    this.store = options.store || null;
    // 固定播报 TTS 帧缓存（模式播报/欢迎等常用短句：命中则跳过网络合成与ffmpeg转码）
    this.ttsCache = new TtsCache(this.config.ttsCache || {});

    // 音频有效性检测默认阈值（可被设备设置覆盖）
    this.defaultAudioThresholds = {
      minMaxAmplitude: this.config.audio?.minMaxAmplitude || 500,
      minAvgAmplitude: this.config.audio?.minAvgAmplitude || 50
    };

    // 注册到设备管理器
    if (this.deviceManager && !this.deviceManager.addDevice) {
      // 使用内部的deviceManager实例
      this.internalDeviceManager = new DeviceManager();
    }

    // 添加sendMessage兼容性方法
    this.sendMessage = this.sendToClient.bind(this);

    // 初始化STT服务回调
    if (this.sttService) {
      this.sttService.setResultCallback(this._handleSttResult.bind(this));
      this.sttService.setErrorCallback(this._handleSttError.bind(this));
    }
    // 活跃语音流程登记表（按 deviceId）：让 /api/voice/session 的采集态跨设备重连存活
    // （物理设备 WS 会频繁断连重建，采集态若只绑连接对象，重连后 boot 按键会掉回普通聊天）
    this.activeVoiceFlows = new Map();
    // 活跃连接登记表（clientId -> 当前 ws）：设备重连时 clientId 不变，旧 socket 的迟到
    // close 不得按 clientId 无主误删新连接的在线记录（迟到 close 守卫，与 MCP 层同模式）
    this.activeConnections = new Map();
  }

  // ==================== 连接管理 ====================

  /**
   * 处理新连接 - 设置客户端信息和事件监听
   */
  handleConnection(ws, req) {
    const clientId = req.headers['client-id'] || uuidv4();
    const deviceId = req.headers['device-id'] || uuidv4();
    const clientIp = req.socket.remoteAddress;

    // 解析URL参数
    const urlParams = new URLSearchParams(req.url.split('?')[1] || '');
    const clientType = urlParams.get('client_type') || 'hard';
    const timestamp = urlParams.get('timestamp');

    logger.info(`新的WebSocket连接: ${clientId} 来自 ${clientIp} client_type=${clientType}, timestamp=${timestamp}`);


    // 设置客户端信息
    ws.clientId = clientId;
    // 关键：把连接握手 HTTP header 解析出的 device-id 记到 ws.deviceId，
    // 供 per-device 设定（语言/音频/机器人）与 store 查询使用。ESP32 硬件的 hello
    // 通常不带 device_id，若不在这里落到 ws.deviceId，deviceSettings(ws) 会因
    // ws.deviceId 为空而返回 {}，导致「是否为机器人」设定读不到（function calling 不注入）。
    ws.deviceId = deviceId;
    ws.clientIp = clientIp;
    ws.connectedAt = new Date();
    ws.isAlive = true;
    // 同一 clientId 重连时这里覆盖旧登记：后续 close 只有命中当前登记对象才做设备层清理
    this.activeConnections.set(clientId, ws);
    ws.isAuthenticated = false;
    ws.sessionId = null;
    // 口语练习模式：全局默认开启时新连接直接处于模式内（远程设定，语音指令同样可进出）
    if (this.config.practice?.enabled) {
      ws.practiceMode = true;
      ws.practiceBuffer = [];
      ws.practiceEndMode = this.config.practice.endMode || 'manual';
      ws.practiceLastActiveAt = Date.now();
    }
    // 语音流程采集态跨重连恢复：该设备若有未结束的活跃 flow，重建连接时自动恢复采集态与回调绑定
    const activeFlow = this.activeVoiceFlows.get(deviceId);
    if (activeFlow) {
      if (Date.now() - (activeFlow.storedAt || 0) > 30 * 60 * 1000) {
        this.activeVoiceFlows.delete(deviceId); // 兑底：控制器异常退出未关闭时，超 30 分钟的陈旧 flow 不再恢复
      } else {
        ws.practiceMode = true;
        ws.practiceBuffer = [];
        ws.practiceEndMode = activeFlow.endOn;
        ws.practiceLastActiveAt = Date.now();
        ws.flowCollect = { url: activeFlow.callbackUrl, sessionId: activeFlow.sessionId, token: activeFlow.token };
        logger.info(`🎙️ 语音流程采集态恢复(重连) → device=${deviceId}, endOn=${activeFlow.endOn}`);
      }
    }
    if (clientType !== "hard") {
      // 发送连接确认
      this.sendToClient(ws, {
        type: SERVER_MESSAGE_TYPES.CONNECTION_ACK,
        clientId: clientId,
        timestamp: new Date().toISOString()
      });
    }

    // 注册到设备管理器
    const dm = this.getDeviceManager();
    if (dm && dm.addDevice) {
      // 非法设备类型归一化为 unknown，避免未知 client_type 导致注册失败
      const validTypes = ['sensor', 'agent', 'hard', 'manager', 'unknown'];
      const deviceType = validTypes.includes(clientType) ? clientType : 'unknown';
      const deviceInfo = {
        id: ws.clientId,
        clientId: ws.clientId,
        deviceId: deviceId, // 网页客户端默认设备ID
        type: deviceType, // 使用URL参数中的客户端类型（白名单外降级为 unknown）
        ip: ws.clientIp,
        connection: ws, // 保存WebSocket连接引用
        connectedAt: new Date(),
        lastActivity: new Date(),
        status: 'online',
        // 添加额外的连接信息
        connectionInfo: {
          clientType: clientType,
          connectTime: timestamp ? new Date(parseInt(timestamp)) : new Date(),
          userAgent: req.headers['user-agent'] || 'hard'
        }
      };

      try {
        dm.addDevice(deviceInfo);
        logger.info(`设备注册成功: ${deviceInfo.deviceId} (${deviceInfo.clientId}), 类型: ${deviceType}, 状态: ${deviceInfo.status}, 连接: ${!!deviceInfo.connection}`);
        // 登记到持久化设备表（仅当设备真实上报了 device-id，避免为网页测试客户端伪造条目）
        if (this.store && req.headers['device-id']) {
          this.store.recordDevice({
            deviceId,
            clientId: ws.clientId,
            type: deviceType,
            ip: clientIp,
            source: 'ws',
            online: 1,
            newConnection: true
          });
        }
      } catch (deviceError) {
        // 注册失败仅断开当前连接，禁止让异常冒泡到 ws upgrade 回调拖垮整个服务进程
        logger.error(`设备注册失败，断开连接 [${clientId}]: ${deviceError.message}`);
        this.sendError(ws, '设备注册失败');
        try { ws.close(1008, 'device registration failed'); } catch { /* ignore */ }
        return;
      }
    }

    // 处理消息
    ws.on('message', (data) => {
      try {
        this.handleMessage(ws, data);
      } catch (error) {
        logger.error(`处理消息失败:`, error);
        this.sendError(ws, '消息处理失败');
      }
    });

    // 处理连接关闭
    ws.on('close', () => {
      logger.info(`WebSocket连接关闭: ${clientId}`);
      this.handleDisconnect(ws);
    });

    // 处理错误
    ws.on('error', (error) => {
      logger.error(`WebSocket错误 [${clientId}]:`, error);
    });

    // 心跳检测
    ws.on('pong', () => {
      ws.isAlive = true;
    });
  }

  /**
   * 处理连接断开
   */
  handleDisconnect(ws) {
    // 重连迟到 close 守卫：旧 socket 的 close 可能晚于新连接注册到达，仅凭 clientId
    // 删除会把刚登记的在线记录误删并持久化为离线（设备实际仍在正常对话，
    // 控制台却显示离线）。仅当该 clientId 当前活跃的正是这条被关闭的连接时，
    // 才做设备层清理与离线持久化；MCP 层自带归属校验，照旧无条件调用。
    if (this.activeConnections.get(ws.clientId) === ws) {
      this.activeConnections.delete(ws.clientId);

      const dm = this.getDeviceManager();
      if (dm && dm.removeDevice) {
        dm.removeDevice(ws.clientId);
      }

      // 持久化设备表标记离线
      if (this.store && ws.deviceId) {
        this.store.markDeviceOffline(ws.deviceId);
      }
    } else {
      logger.info(`🛡️ 跳过设备层清理（clientId ${ws.clientId} 已被新连接接管）`);
    }

    // 处理MCP客户端断开（传入 ws：重连时旧连接的迟到 close 不得清掉新登记）
    if (this.mcpService) {
      this.mcpService.handleDeviceDisconnect(ws.clientId, ws);
    }

    if (ws.sessionId) {
      logger.info(`会话结束: ${ws.sessionId} (${ws.clientId})`);
    }
  }

  /**
   * 处理MCP消息
   */
  async handleMcpMessage(ws, payload) {
    // 机器人身体主动上报的感知事件（method 通道）：统一在此拦截调度，不转发给 mcpService。
    const mcp = payload && payload.payload;
    if (mcp && mcp.method === 'robot.face_found') {
      const bodyKey = (mcp.params && mcp.params.provider) || ws.deviceId || ws.clientId;
      await this._dispatchFaceFound(bodyKey, mcp.params && mcp.params.person, mcp.params && mcp.params.person_id);
      return;
    }
    if (this.mcpService) {
      await this.mcpService.handleMcpMessage(ws, payload);
    } else {
      console.warn('MCP服务未初始化');
    }
  }

  /**
   * 发送MCP初始化消息到设备
   */
  sendMcpInitialize(ws) {
    if (this.mcpService) {
      this.mcpService.sendMcpInitializeMessage(ws);
    }
  }

  /**
   * 获取可用的MCP工具列表
   */
  getMcpTools() {
    if (this.mcpService) {
      return this.mcpService.getFunctionDescriptions();
    }
    return [];
  }

  /**
   * 处理消息
   */
  async handleMessage(ws, data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      // 如果不是JSON，可能是二进制音频数据
      await this.handleBinaryData(ws, data);
      return;
    }

    const { type, sessionId, ...payload } = message;
    console.log(`收到消息类型: ${type}, sessionId: ${sessionId}`);
    // 更新会话ID
    if (sessionId) {
      ws.sessionId = sessionId;
    }

    console.log(`处理消息类型: ${type}`);

    // 根据消息类型处理
    switch (type) {
      case CLIENT_MESSAGE_TYPES.HELLO:
      case CLIENT_MESSAGE_TYPES.LISTEN:
      case CLIENT_MESSAGE_TYPES.ABORT:
      case CLIENT_MESSAGE_TYPES.IOT:
      case CLIENT_MESSAGE_TYPES.CHAT:
        await this.handleProtocolMessage(ws, type, payload);
        break;
      case CLIENT_MESSAGE_TYPES.MCP:
        // console.log(`处理MCP消息 [${ws.clientId}]`);
        await this.handleMcpMessage(ws, payload);
        break;
      case CLIENT_MESSAGE_TYPES.START_RECOGNITION:
        console.log(`处理开始识别请求 [${ws.clientId}]`);
        this.sendMessage(ws, {
          type: SERVER_MESSAGE_TYPES.RECOGNITION_STARTED,
          sessionId: ws.sessionId,
          message: '语音识别已启动，可以说话了'
        });
        break;
      case CLIENT_MESSAGE_TYPES.AUDIO_DATA:
        console.log(`处理音频数据 [${ws.clientId}]: ${payload.audioData?.length || 0} bytes`);
        this.handleAudioData(ws, payload);
        break;
      case CLIENT_MESSAGE_TYPES.WAKE_WORD_DETECTED:
        console.log(`处理唤醒词检测通知 [${ws.clientId}]: ${payload.keyword}`);
        this.handleWakeWordDetected(ws, payload);
        break;
      case CLIENT_MESSAGE_TYPES.FRIEND:
        console.log(`处理好友消息 [${ws.clientId}]: 发送给 ${payload.clientid}`);
        await this.handleFriendMessage(ws, payload);
        break;
      default:
        console.warn(`未知消息类型: ${type}`);
    }
  }

  /**
   * 处理二进制数据（音频数据）
   * 参照Python: receiveAudioHandle.handleAudioMessage
   */
  async handleBinaryData(ws, data) {
    logger.debug(`收到二进制音频数据: ${data.length} bytes (${ws.clientId})`);

    // 语音放送播放期间停止监听：无AEC设备麦克风必收进自己喇叭的广播声，
    // 回声碎片会触发识别并打断广播；直接丢弃音频帧，播放完成+缓冲宽限期后恢复
    if (ws.broadcastActive || Date.now() < (ws.broadcastIgnoreUntil || 0)) {
      if (!ws.broadcastMutedLogged) {
        logger.info(`🔇 语音放送播放中，暂停麦克风输入 [${ws.clientId}]`);
        ws.broadcastMutedLogged = true;
      }
      if (ws.sessionId && this.sttService?.clearAudioBuffer) {
        this.sttService.clearAudioBuffer(ws.sessionId);
      }
      ws.clientHaveVoice = false;
      ws.clientVoiceStop = false;
      ws.clientVoiceWindow = [];
      return;
    }
    ws.broadcastMutedLogged = false;

    // 特殊处理：空帧表示录音结束
    if (data.length === 0) {
      logger.info(`📥 收到空帧，录音结束信号`);
      const sessionId = ws.sessionId;
      if (sessionId && this.sttService) {
        const sttSession = this.sttService.getSession(sessionId);
        const bufferCount = sttSession?.audioBuffer?.length || 0;
        logger.info(`📥 空帧触发识别: sessionId=${sessionId}, 缓冲帧数=${bufferCount}`);
        if (bufferCount >= 15) {
          await this._triggerSttRecognition(ws, sessionId);
        } else {
          logger.warn(`音频数据不足(${bufferCount}帧)，跳过识别`);
        }
      }
      return;
    }

    if (!this.sttService) {
      logger.warn(`STT服务未初始化，无法处理音频数据`);
      return;
    }

    try {
      // 检测是否有人说话（VAD）
      const hasVoice = await this._detectVoice(ws, data);

      // 如果设备刚刚被唤醒，短暂忽略VAD检测
      if (ws.justWokenUp) {
        logger.debug(`设备刚被唤醒，忽略VAD检测`);
        setTimeout(() => { ws.justWokenUp = false; }, 2000);
        return;
      }

      // 注意：这里不做“VAD检测到人声且正在播放→立即打断”。设备（如无AEC的立创板）
      // 麦克风会收进自己喇叭的播放声，服务端VAD无法区分回声与人声，立即打断会造成
      // 每轮回复被回声自杀→设备永远“倾听中”等不到声音。中止改在识别出有效文本后执行
      // （handleCompleteChatMessage），回声文本另有相似度过滤。

      // 设备长时间空闲检测，用于say goodbye（参照Python: no_voice_close_connect）
      await this._checkIdleTimeout(ws, hasVoice);

      // 确保会话存在
      let sessionId = ws.sessionId;
      if (!sessionId) {
        // 没有会话时自动创建
        const sessionResult = this.sessionManager.createSession({
          clientId: ws.clientId,
          deviceId: ws.deviceId || null
        });
        sessionId = sessionResult.sessionId;
        ws.sessionId = sessionId;
        logger.info(`自动创建会话: ${sessionId} (${ws.clientId})`);
      }

      // 确保STT服务中也有对应会话
      let sttSession = this.sttService.getSession(sessionId);
      if (!sttSession) {
        sttSession = this.sttService.createSession(sessionId, {
          listenMode: ws.clientListenMode || 'auto',
          format: ws.audioParams?.format || 'opus'
        });
        logger.debug(`创建STT会话: ${sessionId}`);
      }

      // VAD静默检测 - 参照Python: silero.py
      // 如果之前有声音，现在没有声音，且静默时间超过阈值，则触发识别
      // 静默阈值优先级：设备个体设定 > config.vad.silenceThresholdMs（全局） > 1500ms
      const SILENCE_THRESHOLD_MS = this.deviceSettings(ws).audio?.silenceThresholdMs ?? this.config.vad?.silenceThresholdMs ?? 1500;
      const now = Date.now();

      // 更新语音窗口
      ws.clientVoiceWindow = ws.clientVoiceWindow || [];
      ws.clientVoiceWindow.push(hasVoice);
      if (ws.clientVoiceWindow.length > 10) {
        ws.clientVoiceWindow = ws.clientVoiceWindow.slice(-10);
      }

      // 判断当前是否有声音（窗口内超过一半帧有声音）
      const voiceFrameCount = ws.clientVoiceWindow.filter(v => v).length;
      const clientHaveVoice = voiceFrameCount >= 5;

      logger.debug(`VAD窗口: ${voiceFrameCount}/10 帧有声音, 当前状态: ${clientHaveVoice ? '有声音' : '静默'}, 之前状态: ${ws.clientHaveVoice ? '有声音' : '静默'}`);

      // 如果之前有声音，现在没有声音，且静默时间超过阈值 → 判定一句话结束
      // 注意：不再使用额外的 200ms 短静默分支（曾在停顿期每帧连续重触发，把长句切碎成短句碎片）
      if (ws.clientHaveVoice && !clientHaveVoice) {
        const silenceDuration = now - (ws.lastVoiceTime || now);
        if (silenceDuration >= SILENCE_THRESHOLD_MS) {
          ws.clientVoiceStop = true;
        }
      }

      // 最长语音兜底：realtime 常开麦下若连续有声超过 maxUtteranceMs 仍判不出停顿（如底噪偏高），
      // 强制触发一次识别（后续仍经振幅有效性门过滤纯噪音），从根本上杜绝无限“倾听中”
      const MAX_UTTERANCE_MS = this.config.vad?.maxUtteranceMs ?? 8000;
      if (clientHaveVoice) {
        if (!ws.voiceStartTime) ws.voiceStartTime = now;
        if (now - ws.voiceStartTime >= MAX_UTTERANCE_MS) {
          logger.info(`⏱️ 连续语音超过 ${MAX_UTTERANCE_MS}ms 未检测到停顿，强制触发识别 [${ws.clientId}]`);
          ws.clientVoiceStop = true;
          ws.voiceStartTime = now; // 重置计时，避免下一帧又立即重复触发
        }
      } else {
        ws.voiceStartTime = null;
      }

      // 更新状态
      if (clientHaveVoice) {
        ws.clientHaveVoice = true;
        ws.lastVoiceTime = now;
      }

      // 接收音频并处理
      // 调试：检查数据格式
      logger.debug(`收到音频数据类型: ${typeof data}, 是Buffer: ${Buffer.isBuffer(data)}, 是Array: ${Array.isArray(data)}, 长度: ${data?.length}`);
      if (Array.isArray(data)) {
        logger.warn(`⚠️ 收到数组格式数据，长度: ${data.length}, 第一项类型: ${typeof data[0]}`);
      }

      await this.sttService.receiveAudio(sessionId, data, {
        hasVoice,
        format: ws.audioParams?.format || 'opus'
      });

      // 如果检测到语音停止，触发识别
      if (ws.clientVoiceStop && ws.clientListenMode !== 'manual') {
        ws.clientVoiceStop = false;
        // 触发后复位有语音状态与窗口：一句话只触发一次，避免停顿期连续重触发把长句切碎
        ws.clientHaveVoice = false;
        ws.clientVoiceWindow = [];
        ws.voiceStartTime = null;
        await this._triggerSttRecognition(ws, sessionId);
      }

    } catch (error) {
      logger.error(`处理二进制音频数据失败: ${error.message}`);
    }
  }

  // ==================== 协议消息处理 ====================

  async handleProtocolMessage(ws, type, payload) {
    // 处理原始ESP32协议消息
    switch (type) {
      case CLIENT_MESSAGE_TYPES.HELLO:
        // 支持两种hello消息格式
        const { version, transport, audio_params, device_id, device_name, device_mac, token, features, device_type } = payload;

        // 检查是否是Web客户端格式（没有version和transport字段）
        const isWebClient = !version && !transport && (device_id || device_name);

        // 如果不是Web客户端，检查协议版本
        if (!isWebClient && (version !== 1 || transport !== 'websocket')) {
          this.sendError(ws, '不支持的协议版本或传输方式', ws.sessionId);
          return;
        }

        // 保存设备信息
        if (device_id) ws.deviceId = device_id;
        if (device_name) ws.deviceName = device_name;
        if (device_mac) ws.deviceMac = device_mac;
        if (token) ws.token = token;
        if (features) ws.features = features;
        if (device_type) ws.deviceType = device_type;
        // 外设/机器人类（robot/peripheral/mcp_only）不是小智语音设备：不登记进设备注册表（设备一览），
        // 但仍保留其 device-MCP 工具提供方能力（按 clientId 走 deviceClients，与此登记路径无关）。
        const isPeripheral = ['robot', 'peripheral', 'mcp_only'].includes(String(device_type || '').toLowerCase());

        // 握手携带的设备元信息补登注册表（名称/MAC）
        if (this.store && ws.deviceId && !isPeripheral) {
          this.store.recordDevice({
            deviceId: ws.deviceId,
            clientId: ws.clientId,
            name: device_name,
            mac: device_mac,
            ip: ws.clientIp,
            source: 'ws',
            online: 1
          });
          // 初始启动/重连统一进入“休息”持久标记：与展示态口径一致
          // （原“重连=已唤醒”清除休息标记的语义废弃）
          this.store.markDeviceRest(ws.deviceId, 1);
          // 加载 per-device 设定（语言/音频阈值），缺省字段跟随全局
          ws.deviceSettings = this.store.getDeviceSettings(ws.deviceId) || {};
        }

        ws.audioParams = audio_params || {
          format: 'opus',
          sampleRate: 16000,
          channels: 1,
          frameDuration: 60
        };
        ws.isAuthenticated = true;
        ws.sessionId = this.sessionManager.createSession({
          clientId: ws.clientId,
          deviceId: ws.deviceId || null
        }).sessionId;

        this.sendMessage(ws, {
          type: SERVER_MESSAGE_TYPES.HELLO,
          transport: 'websocket',
          session_id: ws.sessionId,
          audio_params: ws.audioParams
        });
        // console.log(`设备握手成功: ${ws.clientId}, Session: ${ws.sessionId}`);

        // 屏幕布局下发（A方案）：配置 displayLayout 为数字 id 时，握手后热切换
        if (typeof this.config.displayLayout === 'number') {
          this.sendMessage(ws, {
            type: SERVER_MESSAGE_TYPES.LAYOUT,
            id: this.config.displayLayout,
            session_id: ws.sessionId
          });
          // console.log(`下发屏幕布局 id=${this.config.displayLayout}`);
        }
        // 初始启动/重连统一进入“休息”展示态：功能上与待机待唤完全一致
        // （idle+本地唤醒词，休息本就是纯展示态），与语音“进入休息模式”
        // 口径统一；说唤醒词即恢复“聊天”（listen start 钩子既有链路）。
        if (ws.deviceId && !isPeripheral) {
          ws.restMode = true;
          ws.employeeMode = false;
        }
        // 默认语言文案包下发（状态栏等屏幕文本跟随服务器设定）
        this.sendI18n(ws);
        // 同步当前会话模式标签到设备屏幕
        this._sendMode(ws);
        // 休息展示态下发：固件 SetRestMode(true) → 睡觉表情待机画面
        // （设备刚启动本就 idle，无副作用；表情区尽力同步 sleepy）
        if (ws.restMode && !isPeripheral) {
          this.sendMessage(ws, {
            type: SERVER_MESSAGE_TYPES.SLEEP,
            session_id: ws.sessionId,
            timestamp: new Date().toISOString()
          });
          this._sendEmotion(ws, 'sleepy');
        }

        // 如果设备支持MCP，发送MCP初始化消息
        if (ws.features?.mcp) {
          // console.log(`设备 ${ws.clientId} 支持MCP，发送初始化消息`);
          setTimeout(() => {
            this.sendMcpInitialize(ws);
          }, 100); // 延迟1秒发送，确保握手完成
        }
        break;

      case CLIENT_MESSAGE_TYPES.LISTEN:
        const { state: listenState, mode, text: listenText } = payload;

        // 调试日志 - 打印完整的listen消息
        logger.info(`收到listen消息 [${ws.clientId}]: state=${listenState}, mode=${mode}, payload=${JSON.stringify(payload)}`);

        // 设置监听模式
        if (mode) {
          ws.clientListenMode = mode;
          logger.debug(`客户端监听模式: ${mode}`);
        }

        if (!listenState) {
          this.sendError(ws, '缺少监听状态', ws.sessionId);
          return;
        }

        logger.info(`监听状态更新 [${ws.clientId}]: ${listenState}`);

        // 处理不同的监听状态
        if (listenState === LISTEN_STATES.START) {
          // 设备被本地唤醒词唤醒即视为离开"休息"展示态，回聊天（温和休眠下 WS 不断，靠此复位）
          if (ws.restMode) this._clearRestDisplay(ws);
          // 开始监听，清除音频状态
          // 设备开始新一轮采集，中止截至当前轮次的旧TTS音频流（带轮次归属，后面新轮不受影响）
          // 语音流程采集态豁免：此时在播的是控制器推的题目/反馈（脚本内容），
          // 不是可被新轮作废的旧聊天应答，误触发的 listen start 不得掐断它
          if (ws.clientIsSpeaking && ws.clientListenMode !== 'manual' && !ws.flowCollect) {
            logger.info(`🔊 新一轮采集开始，中止仍在发送的旧音频流 [${ws.clientId}]`);
            ws.abortUpTo = ws.turnSeq || 0;
            ws.clientIsSpeaking = false;
          }
          ws.clientHaveVoice = false;
          ws.clientVoiceStop = false;
          if (ws.sessionId && this.sttService) {
            this.sttService.clearAudioBuffer(ws.sessionId);
          }
          // devMode no longer auto-injects on listen start (that caused a
          // listen<->speak infinite loop). With stt.provider=mock the fixed
          // text is returned only when real voice audio passes the VAD gate.
        } else if (listenState === LISTEN_STATES.STOP) {
          // 口语练习模式（手动结束）：按键 stop = “我说完了”收卷信号——
          // 不走 batch 识别（片段已逐段聚合），直接以聚合全文发起总结轮
          if (ws.practiceMode && ws.practiceEndMode !== 'auto') {
            logger.info(`🔴 口语模式收卷：收到 listen stop [${ws.clientId}]`);
            await this._finalizePracticeTurn(ws);
            break;
          }
          // 停止监听，触发语音识别
          logger.info(`🔴 收到手动停止消息，准备触发语音识别`);
          ws.clientVoiceStop = true;

          // 确保会话存在
          let sessionId = ws.sessionId;
          if (!sessionId) {
            const sessionResult = this.sessionManager.createSession({
              clientId: ws.clientId,
              deviceId: ws.deviceId || null
            });
            sessionId = sessionResult.sessionId;
            ws.sessionId = sessionId;
            logger.info(`手动创建会话: ${sessionId}`);
          }

          // 触发语音识别
          if (this.sttService && sessionId) {
            // 设置语音停止标志
            this.sttService.setVoiceStop(sessionId, true);

            // 获取音频缓冲区大小
            const sttSession = this.sttService.getSession(sessionId);
            const bufferCount = sttSession?.audioBuffer?.length || 0;
            logger.info(`🔴 手动停止: 音频缓冲区帧数=${bufferCount}, sessionId=${sessionId}`);

            // 触发识别处理
            await this._triggerSttRecognition(ws, sessionId);
          } else {
            logger.warn(`无法触发识别: sttService=${!!this.sttService}, sessionId=${sessionId}`);
          }
        } else if (listenState === LISTEN_STATES.DETECT) {
          // 检测模式，处理文本
          ws.clientHaveVoice = false;
          ws.clientVoiceStop = false;
          // 唤醒词检出即用户明确打断：同步打开麦克风闸门
          ws.broadcastActive = false;
          ws.broadcastIgnoreUntil = 0;

          if (listenText) {
            // 直接处理文本
            await this._startToChat(ws, listenText);
          }
        }
        break;

      case CLIENT_MESSAGE_TYPES.ABORT:
        const { reason } = payload;
        console.log(`会话终止 [${ws.sessionId}]: ${reason || '未知原因'} (${ws.clientId})`);
        // 设备主动打断：中止截至当前轮次的音频流（只停旧轮，不误杀随后的新轮）
        ws.abortUpTo = ws.turnSeq || 0;
        ws.clientIsSpeaking = false;
        // 用户明确打断（唤醒词/按键）：同步开闸，否则广播类播报被 abort 后
        // broadcastIgnoreUntil 仍会丢弃紧随其后的指令语音帧
        ws.broadcastActive = false;
        ws.broadcastIgnoreUntil = 0;
        // 清除会话数据
        if (ws.sessionId) {
          this.sessionManager.closeSession(ws.sessionId);
          if (this.ttsService) {
            // this.ttsService.clearHistory(ws.sessionId);
          }
          if (this.sttService) {
            // this.sttService.clearHistory(ws.sessionId);
          }
        }
        break;

      case CLIENT_MESSAGE_TYPES.IOT:
        const { descriptors, states } = payload;
        console.log(`收到IoT消息 [${ws.clientId}]: descriptors=${!!descriptors}, states=${!!states}`);
        break;

      case CLIENT_MESSAGE_TYPES.CHAT:
        const { text: chatText, state: chatState, questId: chatQuestId, closeQuest } = payload;
        if (chatState === CHAT_STATES.COMPLETE && chatText) {
          console.log(`收到聊天消息 [${ws.clientId}]: ${chatText}, questId=${chatQuestId}`);
          // 转发用户消息给客户端显示
          this.sendMessage(ws, {
            type: SERVER_MESSAGE_TYPES.STT,
            session_id: ws.sessionId,
            text: chatText,
            timestamp: new Date().toISOString()
          });

          // 如果请求关闭当前Quest
          let effectiveQuestId = chatQuestId;
          if (closeQuest) {
            this.questManager.closeActiveQuest(ws.clientId);
            effectiveQuestId = null; // 强制创建新Quest
            logger.info(`请求关闭当前Quest，将创建新Quest`);
          }

          // 处理完整的聊天消息
          this.handleCompleteChatMessage(ws, chatText, effectiveQuestId);
        }
        break;
      case CLIENT_MESSAGE_TYPES.MCP:
        console.log(`收到MCP消息 [${ws.clientId}]: ${JSON.stringify(payload)}`);
        break;
    }
  }

  /**
   * 处理完整的聊天消息 - 核心语音对话流程
   * @param {WebSocket} ws - WebSocket连接
   * @param {string} text - 用户输入文本
   * @param {string} questId - 可选的Quest ID
   */
  async handleCompleteChatMessage(ws, text, questId = null, options = {}) {
    // 所有触发路径（STT回调 / listen文本 / chat消息）的总收敛过滤：
    // 噪音/语气词/空标点不进入对话轮，避免误触发挤掉用户正在等的真实回复
    if (this._isNoiseInput(text)) {
      logger.info(`🔇 忽略无效输入: "${text}" [${ws.clientId}]`);
      return;
    }

    // 模式闸门（休息/口语/办公/聊天）：与 _handleSttResultDirectly 共用同一实现；
    // options.skipModeGate：口语总结轮自发（聚合全文已由闸门收拢，不可再被拦截）
    if (!options.skipModeGate && await this._handleModeGate(ws, text)) return;

    // 回声判定：无AEC设备播放时麦克风收进自己喇叭的声音，识别结果与在播内容相似；
    // 整体忽略且**不中止**当前播放，否则回声会自杀式打断每轮回复
    if (this._isEchoOfSpoken(ws, text)) {
      logger.info(`🔁 判定为回声拾取，忽略: "${text}" [${ws.clientId}]`);
      return;
    }

    // 确认是有效新输入 → 此时才中止正在播放的旧语音（turnSeq 尚未递增，
    // _handleAbort 内部中止的是旧轮次，新轮不会被残留打断信号误杀）
    if (ws.clientIsSpeaking && ws.clientListenMode !== 'manual') {
      await this._handleAbort(ws);
    }

    // 新一轮接管：递增轮次序号。注意不清共享打断标志——
    // 打断信号用带归属的 abortUpTo（被中止到的最大轮次号），新轮号更大，天然不受旧打断影响
    const myTurn = (ws.turnSeq || 0) + 1;
    ws.turnSeq = myTurn;

    // 轮次串行化：同一连接同一时刻只有一条应答流程在发送音频，杜绝Opus帧交错混杂；
    // 看门狗超时防止单轮挂死（如LLM无响应）导致后续所有轮次永久排队
    const TURN_TIMEOUT_MS = (this.config.turnTimeoutSeconds || 90) * 1000;
    const prevTurn = ws.turnChain || Promise.resolve();
    ws.turnChain = prevTurn
      .catch(() => {})
      .then(() => Promise.race([
        this._runChatTurn(ws, text, questId, myTurn, options),
        new Promise((_, reject) => {
          const t = setTimeout(() => reject(new Error(`本轮处理超时（${TURN_TIMEOUT_MS / 1000}s），释放队列`)), TURN_TIMEOUT_MS);
          if (t.unref) t.unref();
        })
      ]))
      .catch((error) => {
        logger.warn(`轮次${myTurn}处理异常/超时 [${ws.clientId}]: ${error.message}`);
        // 兜底：本轮被看门狗超时接管（_runChatTurn 自身已 catch 的场景不会走到这里），
        // 仍向设备返回错误状态，避免卡“倾听中”
        this.sendTtsNotice(ws, ws.sessionId, this.errorText('llmTimeout'));
      });
    return ws.turnChain;
  }

  /**
   * 回声拾取判定：识别文本与近期正在/刚播放的TTS文本高度相似（子串或字符重合率>60%）
   * 口语/流程采集态直接豁免：跟读(repeat)模式下用户作答与题目播报文本天然同文，
   * 若不过滤豁免会把正常跟读误判为回声吞掉（播报期间麦克风已静音，真回声风险极低）
   */
  _isEchoOfSpoken(ws, text) {
    if (ws.practiceMode) return false;
    const spoken = ws.lastSpoken;
    if (!spoken || Date.now() > spoken.until) return false;
    const norm = (s) => String(s || '').replace(/[\s\p{P}\p{S}]/gu, '');
    const a = norm(spoken.text);
    const b = norm(text);
    if (!a || !b) return false;
    if (a.includes(b) || b.includes(a)) return true;
    const bSet = new Set(b);
    let hit = 0;
    for (const ch of bSet) if (a.includes(ch)) hit++;
    return hit / bSet.size > 0.6;
  }

  /**
   * 无效语音输入判定：去标点后过短、纯语气词（可用 stt.filterFillers 关闭）
   */
  _isNoiseInput(text) {
    if (this.config.stt && this.config.stt.filterFillers === false) return false;
    const cleaned = String(text || '').replace(/[\s\p{P}\p{S}]/gu, '');
    if (cleaned.length < 2) return true;
    const FILLERS = new Set(['嗯', '哦', '啊', '呃', '哎', '唉', '喂', '咳', '唔', '嗨', '哈', '额', '那个', '这个', '就是']);
    return FILLERS.has(cleaned);
  }

  /**
   * 执行单轮对话（LLM + TTS），由 handleCompleteChatMessage 串行调度
   * @param {WebSocket} ws - WebSocket连接
   * @param {string} text - 用户输入文本
   * @param {string|null} questId - Quest ID
   * @param {number} myTurn - 本轮的轮次序号
   */
  async _runChatTurn(ws, text, questId = null, myTurn = 0, options = {}) {
    const connectionId = ws.clientId;

    // 排队期间已有更新的请求接管，放弃本轮（不再为过期问题生成回复）
    if ((ws.turnSeq || 0) !== myTurn) {
      logger.info(`轮次${myTurn}已被新一轮接管，跳过处理 [${connectionId}]`);
      return;
    }

    const sessionId = ws.sessionId;
    let DEBUG = false;
    try {
      console.log(`开始处理聊天消息 [${connectionId}]: ${text}`);

      // ==================== Quest管理 ====================
      // 获取或创建活跃Quest
      let quest = null;
      if (questId) {
        // 如果指定了questId，尝试获取该Quest
        quest = this.questManager.getQuest(questId);
        if (quest && quest.isClosed()) {
          // Quest已关闭，创建新的
          quest = null;
          logger.info(`指定的Quest已关闭，将创建新Quest: ${questId}`);
        }
      }

      if (!quest) {
        // 没有指定questId或Quest已关闭，获取或创建活跃Quest
        quest = this.questManager.getOrCreateActiveQuest(connectionId, {
          sessionId,
          deviceId: ws.deviceId
        });
        questId = quest.questId;
        logger.info(`使用Quest: ${questId} (状态: ${quest.status})`);
      }

      // 增加消息计数
      quest.incrementMessageCount();
      // ==================== Quest管理结束 ====================

      if (DEBUG) {
        // 发送LLM消息
        this.sendMessage(ws, {
          type: SERVER_MESSAGE_TYPES.LLM,
          session_id: sessionId,
          state: TTS_STATES.SENTENCE_START,
          text: text,
          timestamp: new Date().toISOString()
        });
      } else {
        // 记录用户输入到对话日志
        this._logConversation(ws, { role: 'user', text, questId, sessionId });

        // 调用LLM生成回复（使用questId管理对话历史）
        const llmResponse = await this.generateLlmResponse(ws, text, questId, options);

        // LLM期间被用户打断（针对本或更早轮次）或被新一轮接管，则不再发声
        if ((ws.abortUpTo || 0) >= myTurn || (ws.turnSeq || 0) !== myTurn) {
          console.log(`⏹ 轮次${myTurn}在LLM阶段被打断/接管，放弃TTS [${connectionId}]`);
          return;
        }

        // 发送LLM回复消息
        this.sendLlmResponse(ws, sessionId, llmResponse);

        // 记录bot回复到对话日志
        this._logConversation(ws, {
          role: 'bot',
          text: llmResponse,
          questId,
          sessionId,
          emotion: this.detectEmotion(llmResponse),
          provider: this.llmService?.config?.provider || null
        });

        // 调用TTS合成并发送音频
        await this.sendTtsAudio(ws, sessionId, llmResponse, myTurn);
      }
      logger.info(`聊天消息处理完成 [${connectionId}]`);

    } catch (error) {
      console.error(`处理聊天消息失败 [${connectionId}]:`, error);

      // 发送错误消息
      this.sendError(ws, `处理消息失败: ${error.message}`, sessionId);
      // 兜底：以一次无音频TTS周期返回错误状态，避免设备永久卡在等待/倾听
      this.sendTtsNotice(ws, sessionId, this.errorText('turnError'));
    }
  }

  /**
   * 写入对话记录（store 未初始化或字段缺失时静默跳过，不影响对话主流程）
   * @param {WebSocket} ws - WebSocket连接
   * @param {Object} entry - {role, text, questId, sessionId, emotion, provider}
   */
  _logConversation(ws, entry) {
    if (!this.store) return;
    try {
      this.store.logConversation({
        sessionId: entry.sessionId || ws.sessionId,
        deviceId: ws.deviceId || null,
        clientId: ws.clientId,
        questId: entry.questId,
        role: entry.role,
        text: entry.text,
        emotion: entry.emotion,
        provider: entry.provider,
        speaker: entry.speaker || this._speaker(ws)
      });
    } catch (error) {
      logger.warn(`对话记录失败（忽略）: ${error.message}`);
    }
  }

  /**
   * 获取人设提示词
   * @returns {string} 人设提示词
   */
  getPersonaPrompt() {
    return '你名字是任小爱，喜欢听音乐和看电影。最喜欢夸每个人帅和漂亮。';
    // return '你是FSR株式会社的办公助手，社长是孙光。最帅的人也是他。写代码最好的人是任峰磊。';
  }

  /**
   * 检测文本情感
   * @param {string} text - 文本内容
   * @returns {string} 情感标签
   */
  detectEmotion(text) {
    const positiveWords = ['开心', '高兴', '愉快', '喜欢', '好', '棒', '赞', '谢谢', '感谢'];
    const negativeWords = ['难过', '伤心', '生气', '愤怒', '不好', '讨厌', '烦', '抱歉', '对不起'];

    let positiveCount = 0;
    let negativeCount = 0;

    positiveWords.forEach(word => {
      if (text.includes(word)) positiveCount++;
    });

    negativeWords.forEach(word => {
      if (text.includes(word)) negativeCount++;
    });

    if (positiveCount > negativeCount) return 'happy';
    if (negativeCount > positiveCount) return 'sad';
    return 'neutral';
  }

  /**
   * 估算音频时长（毫秒）
   * @param {string} text - 文本内容
   * @returns {number} 估算时长
   */
  estimateAudioDuration(text) {
    // 简单估算：每秒3个汉字
    const charsPerSecond = 3;
    const seconds = text.length / charsPerSecond;
    return Math.round(seconds * 1000);
  }

  /**
   * 根据会话ID获取音频时长
   * @param {string} sessionId - 会话ID
   * @returns {number} 音频时长（毫秒）
   */
  getAudioDurationForSession(sessionId) {
    // 查找所有连接中的音频元数据
    if (this.wss) {
      for (const client of this.wss.clients) {
        if (client.audioMetadata && client.audioMetadata[sessionId]) {
          const metadata = client.audioMetadata[sessionId];
          // 检查数据是否过期（5分钟内有效）
          if (Date.now() - metadata.timestamp < 5 * 60 * 1000) {
            return metadata.duration;
          }
        }
      }
    }
    return 0;
  }

  /**
   * 根据会话ID估算音频时长
   * @param {string} sessionId - 会话ID
   * @returns {number} 估算时长（毫秒）
   */
  estimateAudioDurationFromText(sessionId) {
    // 优先使用实际的音频时长
    const actualDuration = this.getAudioDurationForSession(sessionId);
    if (actualDuration > 0) {
      return actualDuration;
    }
    
    // 回退到文本估算
    return 3000; // 默认3秒
  }

  /**
   * 机器人身体动作后的极短确认词（按设备语言）；动作本身即反馈，不走二轮 LLM 自由播报。
   */
  _robotConfirmText(ws) {
    const lang = this.deviceLang ? this.deviceLang(ws) : 'zh';
    if (lang === 'ja') return '嗯，好了';
    if (lang === 'en') return 'Done.';
    return '好了';
  }

  /**
   * 从身体（MCP 工具提供方）providerKey 反查与其一一对应绑定的小智语音设备：
   * 绑定关系存在语音设备的 settings.robot.body 上（值即身体 providerKey）。
   * 仅返回在线（readyState=1）的设备；找不到返回 null。
   * @param {string} bodyKey - 身体标识（clientId / device_id / mac，大小写不敏感）
   * @returns {string|null} 小智语音设备标识（用于放送）
   */
  _resolveBoundVoiceDevice(bodyKey) {
    const dm = this.getDeviceManager();
    if (!dm || !dm.getAllDevices) return null;
    const want = String(bodyKey || '').trim().toLowerCase();
    if (!want) return null;
    for (const d of dm.getAllDevices()) {
      const conn = d.connection;
      if (!conn || conn.readyState !== 1) continue;
      const ds = conn.deviceSettings
        || (this.store && conn.deviceId ? this.store.getDeviceSettings(conn.deviceId) : null)
        || {};
      const body = ds.robot && ds.robot.body ? String(ds.robot.body).trim().toLowerCase() : null;
      if (body && body === want) {
        return d.deviceId || conn.deviceId || d.clientId;
      }
    }
    return null;
  }

  /**
   * 统一调度：机器人身体（MCP 提供方）上报 face_found 感知事件后，由此集中决定播报。
   * 端侧只负责"发现人脸"，播报文案/目标设备/时机均由 server 统一调度：
   * 反查该身体绑定的在线小智语音设备（settings.robot.body），按该设备语言取固定文案，
   * 走放送链路（broadcastToDevices）合成语音播出。无在线绑定设备则仅记日志。
   * 端侧已用 SFace 识人时 payload 携带 person（已登记称呼）与 person_id（库内稳定编号），命中则换带姓名的播报模板。
   * @param {string} bodyKey - 上报事件的身体标识（clientId / device_id / mac）
   * @param {string=} person - 端侧识别出的已登记称呼（陌生/未识别为空）
   * @param {string=} personId - 已登记成员的稳定 ID（仅随日志/事件透传，不入播报文案）
   */
  async _dispatchFaceFound(bodyKey, person, personId) {
    const voiceDevice = this._resolveBoundVoiceDevice(bodyKey);
    if (!voiceDevice) {
      logger.warn(`[RobotEvent] face_found from ${bodyKey}: 无在线绑定的小智语音设备，未播报`);
      return { spoken: null };
    }
    let lang = 'zh';
    try {
      const dm = this.getDeviceManager();
      const dev = dm.getAllDevices().find(
        (d) => (d.deviceId || (d.connection && d.connection.deviceId) || d.clientId) === voiceDevice
      );
      const conn = dev && dev.connection;
      if (conn && this.deviceLang) lang = this.deviceLang(conn);
    } catch (e) {
      logger.debug(`[RobotEvent] face_found 语言解析失败: ${e.message}`);
    }
    const text = person
      ? String(fixedText(lang, 'faceFoundNamed')).replace('{name}', person)
      : fixedText(lang, 'faceFound');
    try {
      await this.broadcastToDevices(text, { deviceId: voiceDevice, cacheable: true });
      logger.info(`[RobotEvent] face_found from ${bodyKey} person=${person || '-'} id=${personId || '-'} → 经小智设备 ${voiceDevice} 播报: ${text}`);
      return { spoken: voiceDevice, text };
    } catch (e) {
      logger.warn(`[RobotEvent] face_found 播报失败: ${e.message}`);
      return { spoken: null, error: e.message };
    }
  }

  /** 按设备标识（deviceId/clientId/mac，大小写不敏感）定位在线的“小智语音设备”连接（排除 robot/peripheral/mcp_only 身体/外设） */
  _findVoiceConnection(key) {
    const dm = this.getDeviceManager();
    if (!dm || !dm.getAllDevices) return null;
    const want = String(key || '').trim().toLowerCase();
    if (!want) return null;
    const PERIPHERAL = ['robot', 'peripheral', 'mcp_only'];
    for (const d of dm.getAllDevices()) {
      const conn = d.connection;
      if (!conn || conn.readyState !== 1) continue;
      if (PERIPHERAL.includes(String(conn.deviceType || '').toLowerCase())) continue;
      const ids = [d.deviceId, d.clientId, conn.deviceId, conn.clientId, conn.deviceMac, conn.mac]
        .filter((x) => x != null).map((x) => String(x).toLowerCase());
      if (ids.includes(want)) return conn;
    }
    return null;
  }

  /**
   * “对硬件下指令”：按来源菜单（opts.kind）分两条互不混用的链路。
   * - kind='voice'（设备一览，默认）：模拟该小智语音设备向 server 发送识别文字（listen/detect/text），
   *   走唯一正链路 _startToChat → handleCompleteChatMessage → generateLlmResponse，与“对小智说话”完全一致
   *   （工具装配含 robot 身体/homekit 白名单门控、人设、执行与二轮 TTS 均由设备自身会话完成并播报）。
   *   设备不在线则无法模拟，直接报错（不回退 server 执行）。
   * - kind='body'（身体管理菜单）：server 端直接对该机器人身体的工具下自然语言指令，
   *   回复经其绑定的在线小智语音设备播报。
   * @param {string} deviceKey - 目标标识（deviceId / mac / clientId，大小写不敏感）
   * @param {string} text - 指令文本
   * @param {{speak?:boolean,kind?:'voice'|'body'}} opts
   * @returns {Promise<{reply:?string,toolCount:number,spoken:?string,routed:'device'|'body'}>}
   */
  async runHardwareCommand(deviceKey, text, opts = {}) {
    if (!this.mcpService) throw new Error('MCP 服务不可用');
    const t = String(text || '').trim();
    if (!t) throw new Error('指令文本不能为空');
    const key = String(deviceKey || '');
    const kind = String(opts.kind || 'voice').toLowerCase();

    // 语音小智（设备一览）：只模拟设备发文字，走正链路；不在线则报错
    if (kind !== 'body') {
      const ws = this._findVoiceConnection(key);
      if (!ws) throw new Error('该语音设备当前不在线，无法模拟发送（请唤醒设备后重试）');
      this._startToChat(ws, t).catch((e) => logger.warn(`simulate device text chat failed: ${e.message}`));
      logger.info(`hardware command routed via device pipeline for ${key}: "${t.slice(0, 30)}"`);
      return { reply: null, toolCount: 0, spoken: ws.deviceId || key, routed: 'device' };
    }

    // 机器人身体（身体管理菜单）：server 端直接指挥该身体工具
    if (!this.llmService || !this.llmService.isConfigured()) throw new Error('LLM 服务未配置');
    const tools = (this.mcpService.getFunctionDescriptionsForProvider(key) || []).slice();
    if (!tools.length) throw new Error(`该身体离线或无可用工具: ${key}`);
    const chatOptions = {
      language: 'zh',
      tools,
      robotPersona: true,
      executeToolCall: async (name, args) => {
        const stub = { clientId: '__hw_cmd__', features: { mcp: true }, send: () => {} };
        const r = await this.mcpService.callDeviceMcpTool(stub, name, args || {}, 30, key);
        return (typeof r === 'string') ? r : JSON.stringify(r ?? '');
      },
    };
    // 纯身体"动作"类：成功后只补一句极短确认、跳过二轮 LLM；感知(vision)与传感查询(sensor)类仍走 LLM 回答
    const BODY_ACTION_TOOLS = new Set(ACTION_TYPES.filter((a) => a.category !== 'vision' && a.category !== 'sensor').map((a) => a.id));
    const actionSet = new Set(tools.map((t) => t && t.function && t.function.name).filter((n) => n && BODY_ACTION_TOOLS.has(n)));
    if (actionSet.size) { chatOptions.robotActionTools = actionSet; chatOptions.robotConfirmText = '好了'; }
    const llmTimeoutMs = (this.config.llmTimeoutSeconds || 60) * 1000;
    const response = await Promise.race([
      this.llmService.chat(`hwcmd:${key}`, t, chatOptions),
      new Promise((_, reject) => { const tt = setTimeout(() => reject(new Error(`LLM响应超时（${llmTimeoutMs / 1000}s）`)), llmTimeoutMs); if (tt.unref) tt.unref(); }),
    ]);
    logger.info(`body command done for ${key}: tools=${tools.length} reply=${(response && response.text || '').slice(0, 40)}`);
    const reply = (response && response.text) ? String(response.text) : '';
    // 若 speak 且该身体绑定了在线小智语音设备，走放送链路播报 reply
    let spoken = null;
    if (opts && opts.speak && reply) {
      const voiceDevice = this._resolveBoundVoiceDevice(key);
      if (voiceDevice) {
        try {
          await this.broadcastToDevices(reply, { deviceId: voiceDevice });
          spoken = voiceDevice;
          logger.info(`body command reply announced via xiaozhi device: ${voiceDevice}`);
        } catch (e) {
          logger.warn(`body command announce failed via ${voiceDevice}: ${e.message}`);
        }
      }
    }
    return { reply, toolCount: tools.length, spoken, routed: 'body' };
  }

  /**
   * 生成LLM回复
   * @param {WebSocket} ws - WebSocket连接
   * @param {string} text - 用户输入文本
   * @param {string} questId - Quest ID，用于管理对话历史
   * @returns {Promise<string>} LLM回复文本
   */
  async generateLlmResponse(ws, text, questId = null, options = {}) {
    const connectionId = ws.clientId;

    const chatOptions = {
      ...options,
      language: this.deviceLang(ws),
      speaker: this._speaker(ws),
      // 设备人设（名字/性格）：后台个体设定 settings.persona，未设时为 undefined（保持默认提示词）
      persona: this.deviceSettings(ws).persona || undefined,
    };
    // 仅当后台将该设备设为“机器人”时，才注入身体人设 + 挂载身体工具（function calling）。
    // 身体工具与本机 self.* 设备工具做并集（电量等本机状态存于小智自身 ADC，不得被身体绑定遮蔽）。
    // robot.maxFunctions 控制注入的身体工具数量（不填=全部，>=0 则截断；不影响本机自有工具）。
    // HomeKit 家居工具：独立于机器人设定，但按设备白名单注入（settings.home.enabled=true 的小智才挂载），执行按工具类型路由。
    try {
      const robotCfg = this.deviceSettings(ws).robot || {};
      const body = robotCfg.body ? String(robotCfg.body) : null;
      let robotTools = [];
      let bodyToolNames = new Set();
      if (robotCfg.enabled && this.mcpService) {
        // 身体工具：绑定 robot.body 时取该身体；未绑定回退全局池（兼容单机器人）
        let bodyTools = (body
          ? this.mcpService.getFunctionDescriptionsForProvider(body)
          : this.mcpService.getFunctionDescriptions()
        ).slice();
        // 设定页勾选的动作类型白名单（robot.actions）：仅过滤身体工具——设定页只列身体动作目录，
        // 不应把小智本机的 self.*（get_device_status 等）误滤掉
        const actions = Array.isArray(robotCfg.actions) ? new Set(robotCfg.actions.map(String)) : null;
        if (actions) bodyTools = bodyTools.filter((t) => t && t.function && actions.has(t.function.name));
        const cap = Number(robotCfg.maxFunctions);
        if (Number.isFinite(cap) && cap >= 0) bodyTools = bodyTools.slice(0, cap);
        bodyToolNames = new Set(bodyTools.map((t) => t && t.function && t.function.name).filter(Boolean));
        // 本机自有 MCP 工具并入（同名以身体工具优先，避免重复注入）
        const ownTools = this.mcpService.getFunctionDescriptionsForProvider(ws.clientId) || [];
        robotTools = [...bodyTools, ...ownTools.filter((t) => t && t.function && !bodyToolNames.has(t.function.name))];
      }
      const homeCfg = this.deviceSettings(ws).home || {};
      const homeTools = (homeCfg.enabled === true && this.mcpService)
        ? this.mcpService.getFunctionDescriptionsForType(ToolType.HOMEKIT) : [];
      const tools = [...robotTools, ...homeTools];
      if (tools.length) {
        chatOptions.tools = tools;
        if (robotTools.length) chatOptions.robotPersona = true;
        chatOptions.executeToolCall = async (name, args) => {
          if (this.mcpService.getToolType(name) === ToolType.HOMEKIT) {
            // 家居工具走 executeTool 按类型路由到 HomeKitExecutor（非设备连接下发）
            const r = await this.mcpService.executeTool(ws, name, args || {});
            return String((r && (r.result != null ? r.result : r.response)) ?? '');
          }
          // 路由：绑定身体且该身体确有此工具→严格走身体；否则（本机 self.* 或未绑定）
          // 传 null 走全局路由——callDeviceMcpTool 优先命中当前会话设备，再跨设备按 hasTool 查找
          const routeKey = (body && bodyToolNames.has(name)) ? body : null;
          const r = await this.mcpService.callDeviceMcpTool(ws, name, args || {}, 30, routeKey);
          return (typeof r === 'string') ? r : JSON.stringify(r ?? '');
        };
        // 纯身体“动作”类工具：动作即反馈，成功后只补一句极短确认、跳过二轮 LLM 口语播报；
        // 感知/拍照类(category=vision，如 robot_take_photo)不在集内，仍走 LLM 回答。动作集从单一目录派生。
        const BODY_ACTION_TOOLS = new Set(ACTION_TYPES.filter((a) => a.category !== 'vision').map((a) => a.id));
        const actionSet = new Set(tools.map((t) => t && t.function && t.function.name).filter((n) => n && BODY_ACTION_TOOLS.has(n)));
        if (actionSet.size) {
          chatOptions.robotActionTools = actionSet;
          chatOptions.robotConfirmText = this._robotConfirmText(ws);
        }
        logger.info(`function-calling enabled for ${connectionId}: tools=${tools.length} (robot=${robotTools.length} body=${bodyToolNames.size} own=${robotTools.length - bodyToolNames.size} homekit=${homeTools.length}) body=${body || '(global)'}`);
      }
    } catch (e) { logger.warn(`机器人工具装配失败（忽略，按普通对话）: ${e.message}`); }

    if (this.llmService && this.llmService.isConfigured()) {
      try {
        // 使用questId作为对话历史的key，如果没有questId则使用connectionId
        const historyKey = questId || connectionId;
        // LLM超时保护：后端（如dsh bridge）无响应时快速兜底，避免挂死整个轮次队列。
        // 默认60s：本地推理单轮实测20-40s，过紧会频繁落入兜底回复
        const llmTimeoutMs = (this.config.llmTimeoutSeconds || 60) * 1000;
        const response = await Promise.race([
          this.llmService.chat(historyKey, text, chatOptions),
          new Promise((_, reject) => {
            const t = setTimeout(() => reject(new Error(`LLM响应超时（${llmTimeoutMs / 1000}s）`)), llmTimeoutMs);
            if (t.unref) t.unref();
          })
        ]);
        // 检查LLM回复状态
        if (response.status && response.status.toLowerCase() == CHAT_STATES.COMPLETED) {
          response.text = "好的，我要休息了";
          // 结束当前quest
          if (questId) {
            this.questManager.closeQuest(questId, '对话已完成');
            console.log(`Quest已结束: ${questId}`);
          }
        }
        console.log(`LLM回复生成成功 [quest=${questId}]: ${(response.text || "").substring(0, 50)}...`);
        return response.text;
      } catch (llmError) {
        // LLM 后端不可用/超时：以语音兜底明确告知，而非返回看似正常的空回复
        console.error(`LLM调用失败: ${llmError.message}`);
        const isTimeout = /超时|timeout/i.test(llmError.message);
        return this.errorText(isTimeout ? 'llmTimeout' : 'llmConnectionFail');
      }
    } else {
      console.warn(`LLM服务未配置，返回错误提示`);
      return this.errorText('llmNotConfigured');
    }
  }

  /**
   * 获取好友消息的会话信息
   * @param {WebSocket} ws - 源WebSocket连接
   * @param {Object} targetDevice - 目标设备
   * @param {Object} messageData - 消息数据
   * @returns {{sessionId: string, text: string}} 会话ID和文本内容
   */
  getFriendMessageContext(ws, targetDevice, messageData) {
    const sessionId = ws.sessionId || this.sessionManager.createSession({ clientId: targetDevice.clientId }).sessionId;
    const text = messageData.content || messageData.text;
    return { sessionId, text };
  }

  /**
   * 发送STT文本消息
   * @param {WebSocket} ws - WebSocket连接
   * @param {string} sessionId - 会话ID
   * @param {string} text - 文本内容
   */
  sendSttResponse(ws, sessionId, text) {
    this.sendMessage(ws, {
      type: SERVER_MESSAGE_TYPES.STT,
      session_id: sessionId,
      text: text,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * 发送LLM回复消息
   * @param {WebSocket} ws - WebSocket连接
   * @param {string} sessionId - 会话ID
   * @param {string} text - LLM回复文本
   */
  sendLlmResponse(ws, sessionId, text) {
    this.sendMessage(ws, {
      type: SERVER_MESSAGE_TYPES.LLM,
      session_id: sessionId,
      text: text,
      emotion: this.detectEmotion(text),
      timestamp: new Date().toISOString()
    });
  }

  /**
   * 发送一条无音频的TTS状态流（start→sentence_start→stop）。
   * 用于错误兜底：让设备显示提示文本并完成一次播报周期，
   * 避免因 LLM/TTS 失败或本轮超时而永久卡在等待/“倾听中”。
   * @param {WebSocket} ws - WebSocket连接
   * @param {string} sessionId - 会话ID
   * @param {string} text - 展示的错误文本
   */
  sendTtsNotice(ws, sessionId, text) {
    const sid = sessionId || ws.sessionId;
    const now = new Date().toISOString();
    this.sendMessage(ws, { type: SERVER_MESSAGE_TYPES.TTS, session_id: sid, state: TTS_STATES.START, timestamp: now });
    this.sendMessage(ws, { type: SERVER_MESSAGE_TYPES.TTS, session_id: sid, state: TTS_STATES.SENTENCE_START, text, timestamp: now });
    this.sendMessage(ws, { type: SERVER_MESSAGE_TYPES.TTS, session_id: sid, state: TTS_STATES.STOP, timestamp: now, ...(ws.restMode ? { listen: 'disable' } : {}) });
  }

  /**
   * 读取可配置的错误提示文案：优先 config.errorMessages[key]，缺省回落到内置默认。
   * @param {string} key - 文案键
   * @returns {string} 提示文本
   */
  errorText(key) {
    const defaults = {
      llmTimeout: '抱歉，AI响应超时了，请稍后再试',
      llmConnectionFail: '抱歉，AI连接失败，请稍后再试',
      llmNotConfigured: '抱歉，AI服务暂不可用',
      ttsFailed: '抱歉，语音合成失败',
      turnError: '抱歉，我这边出了点问题，请稍后再试'
    };
    const custom = (this.config && this.config.errorMessages) || {};
    return custom[key] || defaults[key];
  }

  /**
   * 将一条回复切分为逐句字幕段（方案①）。
   * 合并过短片段、限制单段长度，避免底部文字碎得太快或请求数过多。
   * 超长段不再按字符硬切：与中文逐字口径一致，拉丁词按整词推进，
   * 只在空白处换行，英文/日语单词不会被强行拆开。
   * 由 config.ttsSegment 控制：{ enabled, maxLen, minLen, maxCount }。
   * @param {string} text - 整条回复文本
   * @returns {string[]} 分段后的文本数组
   */
  _ttsSegments(text) {
    const cfg = this.config.ttsSegment || {};
    if (cfg.enabled === false) return [text];
    const maxLen = cfg.maxLen || 18;
    const minLen = cfg.minLen || 4;
    const maxCount = cfg.maxCount || 12;
    if (!text || text.length <= maxLen) return [text];

    const ttsTokenizer = (this.ttsService && typeof this.ttsService._tokenize === 'function') ? this.ttsService : null;
    const parts = (this.ttsService && typeof this.ttsService._splitText === 'function')
      ? this.ttsService._splitText(text)
      : [text];

    // 合并过短片段到上一段（不超过 maxLen）
    const merged = [];
    for (const p of parts) {
      if (merged.length && p.length < minLen && (merged[merged.length - 1].length + p.length) <= maxLen) {
        merged[merged.length - 1] += (/[ \t]$/.test(merged[merged.length - 1]) || /^[ \t]/.test(p)) ? p : ` ${p}`;
      } else {
        merged.push(p);
      }
    }
    // 对仍超长的一段按词块打包到 maxLen（词不拆，只在空白处断行）
    const out = [];
    for (const m of merged) {
      if (m.length <= maxLen) { out.push(m); continue; }
      // 无 token 化能力时兜底：沿用旧版逐字符硬切（仅适用于 CJK）
      if (!ttsTokenizer) {
        for (let i = 0; i < m.length; i += maxLen) out.push(m.slice(i, i + maxLen));
        continue;
      }
      const tokens = ttsTokenizer._tokenize(m);
      let cur = '';
      const flush = () => { if (cur) { out.push(cur.replace(/\s+$/, '')); cur = ''; } };
      for (const token of tokens) {
        if (/^\s+$/.test(token)) {
          // 空白保留作分词边界；段尾超限时在空白处结算，避免单词 adjacently 粘连
          if (cur) cur += token;
          if (cur.replace(/\s+$/, '').length >= maxLen) flush();
          continue;
        }
        // 超长单词（如 URL）：先结算当前段，单词自身独占一段（硬切会拆词，宁可超宽）
        if (token.length > maxLen) {
          flush();
          out.push(token);
          continue;
        }
        // 标点悬挂：单个中日标点不另起一段（段首出现「，」「。」不符合排版习惯），允许尾部微超宽
        const isHangingPunct = token.length === 1 && /[\p{P}\p{S}]/u.test(token);
        const base = cur.replace(/\s+$/, '').length;
        if (base > 0 && base + token.length > maxLen && !isHangingPunct) flush();
        cur += token;
        if (isHangingPunct && cur.replace(/\s+$/, '').length > maxLen) flush();
      }
      flush();
    }
    // 段数上限：超出部分合并到末段
    if (out.length > maxCount) {
      const head = out.slice(0, maxCount - 1);
      head.push(out.slice(maxCount - 1).join(' '));
      return head;
    }
    return out.length ? out : [text];
  }

  /**
   * 发送TTS音频到客户端（完整的TTS流程）
   * 包含：发送TTS状态、合成音频、转换Opus帧、发送音频帧
   * @param {WebSocket} ws - WebSocket连接
   * @param {string} sessionId - 会话ID
   * @param {string} text - 要合成的文本
   * @returns {Promise<boolean>} 是否成功发送
   */
  async sendTtsAudio(ws, sessionId, text, myTurn = 0, options = {}) {
    // 打断只认带轮次归属的 abortUpTo（设备 abort / 新一轮采集都会设置）：
    // 旧轮被正确中止，新轮（myTurn 更大）不会被残留信号误杀，保证插话后能听到新回答
    const turn = myTurn || (ws.turnSeq || 0);
    const isStale = () => turn > 0 && (ws.abortUpTo || 0) >= turn;

    if (isStale()) {
      console.log(`⏹ TTS发起前本轮已被打断/接管，放弃合成`);
      return false;
    }

    console.log(`开始TTS语音合成...`);
    // 标记正在播放，使VAD打断判断（clientIsSpeaking）生效
    ws.clientIsSpeaking = true;

    try {
      // 1. 调用TTS服务生成音频（先合成后发状态消息：避免音频还没出生成就把设备推进“说话中”等帧，
      //    若随后丢弃则设备永远收不到 tts-stop，卡死在说话中）
      if (this.ttsService && this.ttsService.isEnabled()) {
        try {
          // 分段（方案①）：整条回复按标点切段，逐段合成→逐段 sentence_start→逐段发帧，
          // 设备底部文字随语音进度逐句刷新（字幕效果）。tts START/STOP 各只发一次。
          // 关闭分段或只有一段时自然退化为单段。mock 也走分段（用预置音频按比例
          // 切片逐段下发，以便在无网络下验证底部字幕逐句翻动）。
          const segments = this._ttsSegments(text);
          console.log(`🗂 TTS分段: ${segments.length} 段`);
          // 多语言音色：按整条回复文本判定一次，各分段保持同一音色
          const synthOpts = this.ttsService.pickVoice
            ? { voice: this.ttsService.pickVoice(text, this.deviceLang(ws)) }
            : {};
          // 帧缓存仅对显式标记 cacheable 的固定播报生效（LLM 长回复不缓存）；mock  provider 本地帧无需缓存
          const cacheable = !!options.cacheable && this.ttsCache.enabled
            && this.ttsService.provider !== 'mock';
          const cacheVoiceId = cacheable
            ? `${this.ttsService.provider}|${synthOpts.voice || this.ttsService.voice}|${synthOpts.rate ?? this.ttsService.rate}|${synthOpts.volume ?? this.ttsService.volume}`
            : null;

          // 先合成第一段，成功再发 START（避免音频没生成就把设备推进“说话中”却收不到帧→卡死）
          // 缓存命中则免合成：firstCached 直接携带成品 Opus 帧
          const firstCached = cacheable ? this.ttsCache.get(segments[0], cacheVoiceId) : null;
          const firstResult = firstCached ? null : await this.ttsService.synthesize(segments[0], synthOpts);
          // mock：一整段预置音频按各段文字长度比例切片，字幕随音频进度逐句翻动（用于测分段）
          const mockLens = segments.map((s) => Math.max(1, (s || '').length));
          const mockLenSum = mockLens.reduce((a, b) => a + b, 0) || 1;
          let mockCursor = 0;
          if (isStale()) {
            console.log(`⏹ TTS合成完成但用户已打断，丢弃不发送`);
            return false;
          }

          // 2. 发送TTS开始状态（一次）
          this.sendMessage(ws, {
            type: SERVER_MESSAGE_TYPES.TTS,
            session_id: sessionId,
            state: TTS_STATES.START,
            timestamp: new Date().toISOString()
          });

          // 时长/回声判定按整条文本估算
          const audioDuration = this.estimateAudioDuration(text);
          ws.lastSpoken = { text, until: Date.now() + audioDuration + 2000 };
          if (!ws.audioMetadata) ws.audioMetadata = {};
          ws.audioMetadata[sessionId] = { duration: audioDuration, text, timestamp: Date.now() };

          // 3~5. 逐段：sentence_start(段) -> 该段 Opus 帧
          for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const cachedFrames = i === 0 ? firstCached : (cacheable ? this.ttsCache.get(seg, cacheVoiceId) : null);
            const result = cachedFrames ? null : (i === 0 ? firstResult : await this.ttsService.synthesize(seg, synthOpts));
            if (isStale()) {
              console.log(`⏹ 分段播放中被打断，停止后续 ${segments.length - i} 段`);
              break;
            }
            this.sendMessage(ws, {
              type: SERVER_MESSAGE_TYPES.TTS,
              session_id: sessionId,
              state: TTS_STATES.SENTENCE_START,
              text: seg,
              timestamp: new Date().toISOString()
            });
            let opusFrames;
            if (cachedFrames) {
              opusFrames = cachedFrames;
              console.log(`[TtsCache] hit segment ${i + 1}/${segments.length}: ${opusFrames.length} frames (synthesis skipped)`);
            } else if (result.mockFrames !== undefined) {
              const full = result.mockFrames || [];
              const isLast = i === segments.length - 1;
              const cnt = full.length === 0
                ? 0
                : (isLast
                    ? Math.max(0, full.length - mockCursor)
                    : Math.max(1, Math.round((full.length * mockLens[i]) / mockLenSum)));
              opusFrames = full.slice(mockCursor, mockCursor + cnt);
              mockCursor += opusFrames.length;
              console.log(`🎵 [devMode] TTS mock 分段下发预置帧: 段${i + 1}/${segments.length} ${opusFrames.length}帧 (累计${mockCursor}/${full.length})`);
            } else {
              const audioBuffer = result.audio || result;
              opusFrames = await audioConverter.mp3ToOpusFrames(audioBuffer);
              if (cacheable && opusFrames.length > 0) this.ttsCache.put(seg, cacheVoiceId, opusFrames);
              console.log(`🎵 第${i + 1}/${segments.length}段 Opus编码完成: ${opusFrames.length} 帧`);
            }
            if (opusFrames.length > 0) {
              await this.sendOpusAudioFrames(ws, opusFrames, sessionId, turn);
            }
          }

          // 6. 发送TTS停止消息（一次，确保设备退出“说话中”）
          // 休息模式放送播完不进倾听：带 listen:disable 让设备回 idle
          this.sendMessage(ws, {
            type: SERVER_MESSAGE_TYPES.TTS,
            session_id: sessionId,
            state: TTS_STATES.STOP,
            timestamp: new Date().toISOString(),
            ...(ws.restMode ? { listen: 'disable' } : {})
          });

          // 休息态放送后按预估播放时长补推一次 sleepy 表情：板上老镜像在
          // idle→speaking 转换时会清掉固件侧 rest_mode_，回 idle 的 ShowStandby
          // 于是落到待机图（服务端 i18n 仍显示“休息”，两边口径就分岔了）。
          // 固件 SetServerEmotion 对同名图认账，这里延迟重推即可把睡觉脸兜回来；
          // 根治点在固件（speaking 不清休息），重烧后本兜底分支自然不再触发。
          if (ws.restMode) {
            const retryAt = audioDuration + 2500;
            setTimeout(() => {
              if (ws.readyState !== 1 || !ws.restMode) return;
              // 期间又开了新一轮播报/设备在听，交给下一轮的 STOP 再补
              if (ws.clientIsSpeaking || ws.clientHaveVoice) return;
              this._sendEmotion(ws, 'sleepy');
            }, retryAt);
          }

          return true;

        } catch (ttsError) {
          console.error(`❌ TTS合成失败: ${ttsError.message}`);
          // TTS失败时发送文本作为备选
          this.sendMessage(ws, {
            type: SERVER_MESSAGE_TYPES.TTS_FALLBACK,
            session_id: sessionId,
            text: text,
            error: ttsError.message,
            timestamp: new Date().toISOString()
          });
          // 兜底：补发一次无音频TTS周期，让设备显示错误文本并退出等待，避免卡“倾听中”
          this.sendTtsNotice(ws, sessionId, text || this.errorText('ttsFailed'));
          return false;
        }
      } else {
        // TTS服务未启用时发送文本
        console.log(`TTS服务未启用，发送文本回复`);
        this.sendMessage(ws, {
          type: SERVER_MESSAGE_TYPES.TTS_DISABLED,
          session_id: sessionId,
          text: text,
          timestamp: new Date().toISOString()
        });
        return false;
      }
    } finally {
      ws.clientIsSpeaking = false;
    }
  }

  /**
   * 发送Opus音频帧到客户端
   * 按照协议发送二进制Opus数据帧
   * @param {WebSocket} ws - WebSocket连接
   * @param {Buffer[]} opusFrames - Opus帧数组
   * @param {string} sessionId - 会话ID
   */
  async sendOpusAudioFrames(ws, opusFrames, sessionId, turn = 0) {
    if (!opusFrames || opusFrames.length === 0) {
      console.warn('⚠️ 没有Opus帧需要发送');
      return;
    }

    // 发送期间的中止按轮次归属判断：abort针对的是当时进行中的旧轮，
    // 新轮排队不在此列，两条流不会交错是因为它们已由 turnChain 串行，不会同时进入发送循环
    const framesAborted = () => turn > 0 && (ws.abortUpTo || 0) >= turn;

    // 定长帧定距发送：audioConverter 固定按 60ms 编码一帧，节拍就应等于真实帧长。
    // 旧逻辑用“每秒3字”文本估算总长再除以帧数，估算偏快时帧发送超速（如 42ms/帧），
    // 设备缓冲溢出导致颤音；且不同音频帧数不同，clamp 后节拍完全失真。
    const frameDuration = ws.audioParams?.frame_duration || ws.audioParams?.frameDuration
      || audioConverter?.frameDuration || 60;

    console.log(`📤 开始发送 ${opusFrames.length} 个Opus音频帧`);
    console.log(`📊 定距节拍: ${frameDuration}ms/帧 (预计总时长 ${(opusFrames.length * frameDuration / 1000).toFixed(1)}s)`);

    for (let i = 0; i < opusFrames.length; i++) {
      const frame = opusFrames[i];

      try {
        // 检查连接状态
        if (ws.readyState !== 1) { // WebSocket.OPEN = 1
          console.warn(`⚠️ WebSocket连接已关闭，停止发送音频帧`);
          break;
        }

        // 用户真实打断，丢弃剩余帧
        if (framesAborted()) {
          console.warn(`⏹ 用户打断，停止发送剩余 ${opusFrames.length - i} 帧`);
          break;
        }

        // 发送二进制Opus帧
        ws.send(frame);

        // 按照动态计算的帧时长延迟发送下一帧
        if (i < opusFrames.length - 1) {
          await new Promise(resolve => setTimeout(resolve, frameDuration));
        }

      } catch (error) {
        console.error(`❌ 发送音频帧失败 (帧 ${i}):`, error.message);
        break;
      }
    }

    console.log(`✅ Opus音频帧发送完成`);
  }

  async handleBusinessMessage(ws, data) {
    // 这里处理具体的业务逻辑
    // 比如设备管理、会话控制、音频处理等
    console.log('处理业务消息:', data.toString());

    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'audio_data':
          await this.handleAudioData(ws, message);
          break;
        case 'wake_word_detected':
          await this.handleWakeWordDetected(ws, message);
          break;
        case 'start_recognition':
          await this.handleStartRecognition(ws, message);
          break;
        default:
          console.log('未知消息类型:', message.type);
      }
    } catch (error) {
      console.error('解析业务消息失败:', error);
      this.sendError(ws, '消息格式错误');
    }
  }

  /**
   * 处理音频数据消息（JSON格式的audio_data消息）
   */
  async handleAudioData(ws, message) {
    const { audioData, sessionId } = message;

    if (!audioData) {
      this.sendError(ws, '缺少音频数据');
      return;
    }

    try {
      // 解码Base64音频数据
      const audioBuffer = Buffer.from(audioData, 'base64');

      // 确保有会话
      const currentSessionId = sessionId || ws.sessionId;
      if (!currentSessionId) {
        this.sendError(ws, '没有活动会话');
        return;
      }

      // 确保STT会话存在
      let sttSession = this.sttService.getSession(currentSessionId);
      if (!sttSession) {
        sttSession = this.sttService.createSession(currentSessionId, {
          listenMode: ws.clientListenMode || 'auto'
        });
      }

      // 接收音频数据
      await this.sttService.receiveAudio(currentSessionId, audioBuffer, {
        hasVoice: true,
        format: ws.audioParams?.format || 'opus'
      });

      // 发送接收确认
      this.sendMessage(ws, {
        type: SERVER_MESSAGE_TYPES.AUDIO_RECEIVED,
        sessionId: currentSessionId,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('音频处理失败:', error);
      this.sendError(ws, '音频处理失败: ' + error.message);
    }
  }

  async handleWakeWordDetected(ws, message) {
    const { keyword, confidence, timestamp } = message;

    console.log(`收到唤醒词检测通知: ${keyword}, 置信度: ${confidence}`);

    // 发送确认响应
    this.sendMessage(ws, {
      type: SERVER_MESSAGE_TYPES.WAKE_WORD_ACKNOWLEDGED,
      keyword: keyword,
      confidence: confidence,
      timestamp: timestamp,
      message: '已检测到唤醒词，请说话'
    });
  }

  async handleStartRecognition(ws, message) {
    const { sessionId } = message;

    // 开始连续语音识别
    console.log(`开始会话 ${sessionId} 的语音识别`);

    this.sendMessage(ws, {
      type: SERVER_MESSAGE_TYPES.RECOGNITION_STARTED,
      sessionId: sessionId,
      message: '语音识别已启动，可以说话了'
    });
  }

  /**
   * 处理好友消息 - 客户端间消息传递
   * @param {WebSocket} ws - 发送方WebSocket连接
   * @param {Object} payload - 消息负载 {clientid, data}
   */
  async handleFriendMessage(ws, payload) {
    const { clientid: targetClientId, data } = payload;

    // 验证参数
    if (!targetClientId) {
      this.sendError(ws, '缺少目标客户端ID', ws.sessionId);
      return;
    }

    if (data === undefined || data === null) {
      this.sendError(ws, '消息内容不能为空', ws.sessionId);
      return;
    }

    // 验证data格式 - 支持结构化数据 {type: "消息类型", ...}
    let messageData = data;
    if (typeof data === 'object' && data !== null) {
      // 已经是结构化数据，验证必需字段
      if (!data.type) {
        this.sendError(ws, '结构化消息必须包含type字段', ws.sessionId);
        return;
      }
      messageData = data;
    } else {
      // 如果是字符串或其他基本类型，包装成结构化格式
      messageData = {
        type: 'text',
        content: data
      };
    }

    // 获取目标客户端
    const dm = this.getDeviceManager();
    if (!dm || !dm.getDevice) {
      this.sendError(ws, '设备管理器未初始化', ws.sessionId);
      return;
    }

    const targetDevice = dm.getDevice(targetClientId);

    // 检查目标客户端是否存在且在线
    if (!targetDevice) {
      this.sendError(ws, `目标客户端不存在: ${targetClientId}`, ws.sessionId);
      return;
    }

    // 检查目标客户端是否存在且在线
    if (!targetDevice) {
      this.sendError(ws, `目标客户端不存在: ${targetClientId}`, ws.sessionId);
      return;
    }

    // 检查在线状态
    const isOnline = targetDevice.connection &&
      targetDevice.connection.readyState === 1 &&
      targetDevice.status === 'online';

    if (!isOnline) {
      this.sendError(ws, `目标客户端不在线: ${targetClientId}`, ws.sessionId);
      return;
    }

    // 根据消息类型进行不同处理
    const messageType = messageData.type;
    const isllm = messageData.isllm;
    try {
      // 提取公共逻辑
      const { sessionId, text } = this.getFriendMessageContext(ws, targetDevice, messageData);
      let sendText = text;
      if (isllm) {
        //generateLlmResponse
        sendText = await this.generateLlmResponse(ws, sendText);
      }
      if (messageType === 'tts') {
        // tts类型 - 转换成语音发送
        await this.sendTtsAudio(targetDevice.connection, sessionId, sendText);
      }
      else if (messageType === 'sst') {
        // sst类型 - 直接发送文本，如果是hard设备发送语音
        if (targetDevice.type === 'hard' && this.ttsService) {
          await this.sendTtsAudio(targetDevice.connection, sessionId, sendText);
        } else {
          this.sendSttResponse(targetDevice.connection, sessionId, sendText);
        }
      } else if (messageType === 'device') {
        // device类型 - 修改设备配置（如音频阈值）
        const { audio_thresholds } = messageData;

        if (!audio_thresholds) {
          this.sendError(ws, 'device消息缺少配置参数', ws.sessionId);
          return;
        }

        // 更新目标设备的音频阈值设置
        targetDevice.connection.audioThresholds = {
          minMaxAmplitude: audio_thresholds.minMaxAmplitude || this.defaultAudioThresholds.minMaxAmplitude,
          minAvgAmplitude: audio_thresholds.minAvgAmplitude || this.defaultAudioThresholds.minAvgAmplitude
        };

        logger.info(`设备 ${targetClientId} 音频阈值已更新: max=${targetDevice.connection.audioThresholds.minMaxAmplitude}, avg=${targetDevice.connection.audioThresholds.minAvgAmplitude}`);

        // 发送确认消息给发送方
        this.sendToClient(ws, {
          type: SERVER_MESSAGE_TYPES.MESSAGE,
          session_id: ws.sessionId,
          status: 'success',
          message: `设备 ${targetClientId} 配置已更新`,
          data: {
            targetClientId,
            audioThresholds: targetDevice.connection.audioThresholds
          },
          timestamp: new Date().toISOString()
        });
      } else if (messageType === 'mcp') {
        //Tool Trans
        let toolApi = messageData.name;
        if (!toolApi) {
          this.sendError(ws, `消息处理失败: No Tool`, ws.sessionId);

        }
        // 🔧 客户端工具 #1: self.get_device_status
        // 🔧 客户端工具 #2: self.audio_speaker.set_volume
        // 🔧 客户端工具 #3: self.screen.set_brightness
        // 🔧 客户端工具 #4: self.screen.set_theme
        // 🔧 客户端工具 #5: self.camera.take_photo
        // 🔧 客户端工具 #6: self.system.reconfigure_wifi
        let toolApiMap = {
          "volume": "self.audio_speaker.set_volume",
          "brightness": "self.screen.set_brightness",
          "theme": "self.screen.set_theme",
          "photo": "self.camera.take_photo",
          "wifi": "self.system.reconfigure_wifi"
        };
        toolApi = toolApiMap[toolApi];
        if (!toolApi) {
          this.sendError(ws, `消息处理失败: No Tool ${toolApi}`, ws.sessionId);
          return;
        }
        const exeCmd =
        {
          "jsonrpc": "2.0",
          "id": 3,
          "method": "tools/call",
          "params": {
            "name": toolApi, // 要调用的工具名称
            "arguments": messageData.params || {}
          }
        }
        this.sendMessage(targetDevice.connection, {
          type: SERVER_MESSAGE_TYPES.MCP,
          payload: exeCmd
        });
      }
    } catch (error) {
      console.error(`❌ 好友消息处理失败:`, error);
      this.sendError(ws, `消息处理失败: ${error.message}`, ws.sessionId);
    }

  }

  async handleWakeWordResponse(ws, wakeWordResult, sessionId) {
    // 处理唤醒词检测后的响应
    console.log(`处理唤醒词响应: ${wakeWordResult.keyword}`);

    // 发送TTS欢迎消息（语种跟随默认语言托底）
    try {
      const welcomeText = fixedText(this.deviceLang(ws), 'welcome');
      const ttsResult = await this.ttsService.synthesize(welcomeText, this.ttsService.pickVoice ? { voice: this.ttsService.pickVoice(welcomeText, this.deviceLang(ws)) } : {});

      this.sendMessage(ws, {
        type: 'tts_response',
        audioData: ttsResult.audioData.toString('base64'),
        text: welcomeText,
        sessionId: sessionId,
        wakeWordTriggered: true
      });

    } catch (error) {
      console.error('TTS响应失败:', error);
      // 发送文本响应作为备选
      this.sendMessage(ws, {
        type: 'text_response',
        text: '你好！我是小智，有什么可以帮助你的吗？',
        sessionId: sessionId,
        wakeWordTriggered: true
      });
    }
  }

  // ==================== 工具方法 ====================

  /**
   * 获取设备管理器
   */
  getDeviceManager() {
    return this.deviceManager || this.internalDeviceManager;
  }

  /**
   * 发送消息到客户端
   */
  sendToClient(ws, message) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * 发送错误消息
   */
  sendError(ws, errorMessage, sessionId = null) {
    const errorResponse = {
      type: SERVER_MESSAGE_TYPES.ERROR,
      message: errorMessage
    };

    if (sessionId) {
      errorResponse.session_id = sessionId;
    }

    this.sendToClient(ws, errorResponse);
  }

  // ==================== 心跳检测 ====================

  /**
   * 启动心跳保活：周期性向所有已完成 hello 的连接下发状态类小消息。
   * 背景：休息模式下播报结束后 WS 完全静默——
   *   1) 固件 Protocol::IsTimeout() 以「120 秒无下行」判定音频通道超时，
   *      超时后 idle keep-alive（每 30s 检查）会重开 WebSocket；
   *   2) 路由/NAT 也会在 ~60s 空闲后掐断静默 TCP。
   * 任一情况触发的重连都会被服务端当作全新会话（休息态被清），设备表现为
   * 「休息/休息/睡觉」过一会儿自动漂回「聊天/待命/默认图」。
   * 心跳以 30s 周期下发 mode 标签（固件 SetModeText 同文去重、幂等），
   * 刷新 last_incoming_time_，双重封死上述两条误判路径；休息态额外重推
   * i18n，使真实断线重连后的「待命→休息」显示覆盖自愈。
   */
  startHeartbeat(interval = 30000) {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      if (!this.wss) return;
      let count = 0;
      for (const client of this.wss.clients) {
        if (client.readyState !== 1 /* WebSocket.OPEN */ || !client.sessionId) continue;
        try {
          this._sendMode(client); // 幂等 keep-alive：固件按当前文案去重，不产生任何副作用
          if (client.restMode) this.sendI18n(client); // 休息态自愈状态覆盖
          count++;
        } catch (e) {
          logger.warn(`心跳下发失败 [${client.clientId || '?'}]: ${e.message}`);
        }
      }
      if (count > 0) logger.debug(`💓 心跳已下发 ${count} 个连接`);
    }, interval);
    logger.info(`💓 心跳保活已启动（周期 ${interval / 1000}s）`);
  }

  /**
   * 停止心跳检测
   */
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      logger.info('心跳保活已停止');
    }
  }

  // ==================== 设备命令 ====================

  /**
   * 发送IoT命令到指定设备
   */
  sendIotCommand(clientId, command, params = {}) {
    const dm = this.getDeviceManager();
    if (!dm || !dm.getDevice) {
      throw new Error(`设备管理器未初始化`);
    }

    const device = dm.getDevice(clientId);

    if (!device || !device.connection) {
      throw new Error(`设备未连接: ${clientId}`);
    }

    const sessionId = uuidv4();
    const commandMessage = {
      session_id: sessionId,
      type: 'iot',
      command,
      params
    };

    this.sendToClient(device.connection, commandMessage);
    return sessionId;
  }

  /**
   * 处理SST类型好友消息 - 直接发送文本，如果是hard设备也发送语音
   */
  async handleSSTFriendMessage(ws, targetDevice, messageData, targetClientId) {
    console.log(`📝 处理SST好友消息: ${messageData.content || messageData.text}`);

    // 构造文本消息
    const textMessage = {
      type: 'stt',
      from: ws.clientId,
      session_id: ws.sessionId || this.sessionManager.createSession({ clientId: targetDevice.clientId }).sessionId,
      text: messageData.content || messageData.text,
      timestamp: new Date().toISOString()
    };

    // 如果是hard设备，也发送语音
    if (targetDevice.type === 'hard' && this.ttsService) {
      try {
        const ttsMessage = {
          type: 'tts',
          session_id: ws.sessionId || this.sessionManager.createSession({ clientId: targetDevice.clientId }).sessionId,
          text: messageData.content || messageData.text,
          timestamp: new Date().toISOString()
        };
        this.sendToClient(targetDevice.connection, ttsMessage);
        console.log(`🔊 为hard设备额外发送TTS消息`);
      } catch (error) {
        console.warn(`为hard设备发送TTS失败:`, error.message);
      }
    }
    // 发送文本消息
    this.sendToClient(targetDevice.connection, textMessage);

    // 向发送方确认
    // this.sendToClient(ws, {
    //   type: SERVER_MESSAGE_TYPES.FRIEND_ACK,
    //   to: targetClientId,
    //   data: messageData,
    //   timestamp: new Date().toISOString(),
    //   status: 'sent'
    // });

    console.log(`✅ SST好友消息处理完成: ${ws.clientId} -> ${targetClientId}`);
  }




  // 广播消息给所有连接的客户端
  broadcast(message, excludeClientId = null) {
    const dm = this.getDeviceManager();
    if (!dm || !dm.getAllDevices) {
      return;
    }

    const clients = dm.getAllDevices();

    clients.forEach(device => {
      if (device.id !== excludeClientId && device.connection && device.connection.readyState === 1) {
        this.sendToClient(device.connection, message);
      }
    });
  }

  // ==================== 语音放送（服务端推送） ====================

  /**
   * 筛选可放送的设备（连接已打开；可选按 deviceId/clientId 收窄）
   */
  getBroadcastTargets(deviceId = null) {
    const dm = this.getDeviceManager();
    if (!dm || !dm.getAllDevices) return [];
    return dm.getAllDevices().filter(d => {
      if (!d || !d.connection || d.connection.readyState !== 1) return false;
      if (!deviceId) return true;
      return this._sameIdent(d.deviceId, deviceId) || this._sameIdent(d.clientId, deviceId);
    });
  }

  /**
   * 远程唤醒：退出休息模式（restMode）并下发 wake 指令使设备恢复就绪，
   * 最后播报一句确认语音（复用广播链路，休息/待机设备均能收到）。
   * keepRest=true（纯被动放送，非用户主动唤醒）：正处于休息的设备保持休息——
   * 不下发 wake（固件 wake 处理器会 SetRestMode(false)，睡觉脸就此丢失、换成下发待机图），
   * restMode 保持为真使 tts stop 带 listen:disable，播报走 idle→speaking→idle，
   * 播完仍回到睡觉脸。真实交互（唤醒词/detect/对话）照常由各自入口退出休息。
   */
  async wakeDevices({ deviceId = null, announce, keepRest = false } = {}) {
    const targets = this.getBroadcastTargets(deviceId);
    for (const device of targets) {
      const conn = device.connection;
      const wasResting = !!conn.restMode;
      const holdRest = keepRest && wasResting;
      if (!holdRest) {
        conn.restMode = false;
        if (this.store && conn.deviceId) this.store.markDeviceRest(conn.deviceId, 0);
        this._sendMode(conn);
      }
      // 防抖：刚唤醒过且设备不在休息态时不再重复下发 WAKE——固件收到 wake 会
      // AbortSpeaking 中止在播音频，紧接的第二次唤醒（如口语提示音+首题连发）
      // 会把第一句当场掐掉（文字上屏、声音没了）
      const nowTs = Date.now();
      const recentWake = conn._lastWakeAt && nowTs - conn._lastWakeAt < 15000;
      if (holdRest) {
        logger.info(`💤 休息中收到被动放送，保持休息态（播完回睡觉脸） [${device.deviceId || conn.clientId || ''}]`);
      } else if (!wasResting && recentWake) {
        logger.info(`⏱️ 15秒内已唤醒过，跳过重复 WAKE [${device.deviceId || conn.clientId || ''}]`);
      } else {
        conn._lastWakeAt = nowTs;
        this.sendMessage(conn, {
          type: SERVER_MESSAGE_TYPES.WAKE,
          session_id: conn.sessionId,
          timestamp: new Date().toISOString()
        });
        logger.info(`🔔 远程唤醒指令已下发 [${device.deviceId || conn.clientId || ''}]`);
      }
    }
    let announced = false;
    if (targets.length > 0) {
      if (announce) {
        await this.broadcastToDevices(announce, { deviceId }).catch((e) => {
          logger.warn(`唤醒播报失败: ${e.message}`);
        });
        announced = true;
      } else {
        // 未指定文案：逐设备按各自个体语言播报唤醒确认
        for (const device of targets) {
          const text = fixedText(this.deviceLang(device.connection), 'wakeAnnounce');
          await this.broadcastToDevices(text, { deviceId: device.deviceId, cacheable: true }).catch((e) => {
            logger.warn(`唤醒播报失败(${device.deviceId}): ${e.message}`);
          });
          announced = true;
        }
      }
    }
    return { woken: targets.length, announced };
  }

  /**
   * 将文本合成语音后广播到已连接设备（复用 sendTtsAudio 完整播放链路：
   * 合成 → tts start → Opus 帧 → tts stop）。接入连接轮次链 turnChain：
   * 同一设备同时只有一条流在发送，多条放送/对话应答排队串行，杜绝Opus帧交错；
   * 递增 turnSeq 使放送可被用户真实打断（abortUpTo 归属机制同样生效）。
   * 音频按实时节奏串行发送，调用方应 fire-and-forget，不要同步等待。
   */
  async broadcastToDevices(text, { deviceId = null, cacheable = false } = {}) {
    const targets = this.getBroadcastTargets(deviceId);
    for (const device of targets) {
      const conn = device.connection;
      const clientId = device.clientId || device.id;
      const run = async () => {
        const myTurn = (conn.turnSeq || 0) + 1;
        conn.turnSeq = myTurn;
        const sessionId = conn.sessionId || uuidv4();
        console.log(`📢 语音放送(turn=${myTurn}) → ${device.deviceId || clientId}: ${String(text).slice(0, 40)}${String(text).length > 40 ? '…' : ''}`);
        // 放送期间停止监听（handleBinaryData 入口据此丢弃麦克风帧，防回声自打断）
        conn.broadcastActive = true;
        let ok = false;
        try {
          ok = await this.sendTtsAudio(conn, sessionId, text, myTurn, { cacheable });
        } finally {
          conn.broadcastActive = false;
          // 尾部宽限：服务端发完≠设备播完，再保护 2s 播放缓冲
          conn.broadcastIgnoreUntil = Date.now() + 2000;
        }
        // 主动放送落入对话记录（provider='broadcast' 区分于对话应答），
        // 使「数字员工主动说话→人工回答→员工处理」全链在 xz_conversations 可审计
        this._logConversation(conn, { role: 'bot', text, sessionId, provider: 'broadcast' });
        console.log(`📢 放送${ok ? '完成' : '未完整播放'} (turn=${myTurn}) ${device.deviceId || clientId}`);
        return ok;
      };
      const prev = conn.turnChain || Promise.resolve();
      conn.turnChain = prev
        .catch(() => {})
        .then(run)
        .catch((error) => {
          logger.warn(`语音放送异常 [${clientId}]: ${error.message}`);
        });
    }
    return { attempted: targets.length, queued: targets.length };
  }

  // ==================== 模式指令辅助 ====================

  /**
   * 语音模式指令（唤醒后说出即生效，按设备连接保持）。
   * 触发词表完全由配置驱动（config.json → modeKeywords，前台可自由定义，每次识别实时读取热生效）：
   *   { employeeOn:[...] , employeeOff:[...], restOn:[...], restOff:[...],
   *     practiceOn:[...], practiceOff:[...], practiceEndManual:[...], practiceEndAuto:[...] }
   * 匹配：识别文本去空格/标点/小写后与短语同口径归一后全等即命中（多语言：英文短语句
   * 靠小写归一命中，如 "manual end"/"Manual End"；短语自己写清“进入/退出”语义）。
   * @returns {'employee-on'|'employee-off'|'rest-on'|'rest-off'|'practice-on'|'practice-off'|'practice-end-manual'|'practice-end-auto'|null}
   */
  _matchModeCommand(text) {
    const norm = (s) => String(s || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
    const t = norm(text);
    if (!t) return null;
    const kw = this.config.modeKeywords || {};
    const hit = (list) => Array.isArray(list) && list.some((p) => p && norm(p) === t);
    if (hit(kw.employeeOn)) return 'employee-on';
    if (hit(kw.employeeOff)) return 'employee-off';
    if (hit(kw.restOn)) return 'rest-on';
    if (hit(kw.restOff)) return 'rest-off';
    if (hit(kw.practiceOn)) return 'practice-on';
    if (hit(kw.practiceOff)) return 'practice-off';
    if (hit(kw.practiceEndManual)) return 'practice-end-manual';
    if (hit(kw.practiceEndAuto)) return 'practice-end-auto';
    return null;
  }

  /** 寻址名归一：去空格/标点/符号 + 小写 */
  _normAddr(s) {
    return String(s || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
  }

  /**
   * 收集当前在线设备的人设名（settings.persona.name）作为语音寻址名。
   * 同名多设备会各自命中，建议后台保证人设名唯一。
   */
  _knownDevicePersonaNames() {
    const out = [];
    const seen = new Set();
    for (const d of this.getBroadcastTargets(null)) {
      const conn = d.connection;
      if (!conn) continue;
      const raw = String(((this.deviceSettings(conn).persona || {}).name || '')).trim();
      const n = this._normAddr(raw);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      out.push({ normName: n, rawName: raw });
    }
    return out;
  }

  /**
   * 设备名寻址解析："人设名 + 触发词" → 判定为对该设备的指令。
   * 仅当"去掉前缀名后的余量仍能命中某个模式触发词"时才算寻址，避免误伤普通对话。
   * 长名优先匹配，防止短名抢先截断。
   * @returns {{matched:boolean, normName?:string, rawName?:string, cmd?:string}}
   */
  _resolveModeAddress(normText) {
    if (!normText) return { matched: false };
    const names = this._knownDevicePersonaNames();
    names.sort((a, b) => b.normName.length - a.normName.length);
    for (const item of names) {
      if (!normText.startsWith(item.normName)) continue;
      const cmd = this._matchModeCommand(normText.slice(item.normName.length));
      if (cmd) return { matched: true, normName: item.normName, rawName: item.rawName, cmd };
    }
    return { matched: false };
  }

  // ==================== 员工模式辅助 ====================

  /**
   * 下发当前会话模式标签到设备屏幕顶部栏（layout #6）：
   * 仅 休息 / 口语 / 员工 / 聊天 四种（待命属于聊天态，不再单独显示）
   */
  _sendMode(ws) {
    // 休息/口语/员工优先；普通态下若开发模式总开关打开则显示"开发"，否则"聊天"。
    // 标签语种：设备个体设定 > 全局默认语言（托底），每次实时读取。
    const flags = resolveMockFlags(this.config);
    const key = ws.restMode ? 'rest' : (ws.practiceMode ? 'practice' : (ws.employeeMode ? 'employee' : (flags.master ? 'dev' : 'chat')));
    const lang = this.deviceLang(ws);
    const label = (MODE_LABELS[lang] || MODE_LABELS.zh)[key];
    this.sendMessage(ws, {
      type: SERVER_MESSAGE_TYPES.MODE,
      text: label,
      session_id: ws.sessionId,
      timestamp: new Date().toISOString()
    });
  }

  /** 身份等值比较：设备标识（mac/device_id/client_id）大小写不敏感。
   *  设备上报与后台录入/查询口径不一（同一 mac 存在大写变体），
   *  精确比较会静默匹配不到会话。 */
  _sameIdent(a, b) {
    if (a == null || b == null) return false;
    const x = String(a).trim().toLowerCase();
    const y = String(b).trim().toLowerCase();
    return !!x && !!y && x === y;
  }

  /** per-device 设定（控制台「个体语音与语言」写入 devices.settings）；缓存到 ws */
  deviceSettings(ws) {
    if (!ws) return {};
    if (ws.deviceSettings !== undefined) return ws.deviceSettings;
    if (this.store && ws.deviceId) {
      ws.deviceSettings = this.store.getDeviceSettings(ws.deviceId) || {};
      return ws.deviceSettings;
    }
    return {};
  }

  /** 设备语言：个体设定优先，未设则用全局默认语言托底 */
  deviceLang(ws) {
    return this.deviceSettings(ws).language || currentLang(this.ttsService);
  }

  /**
   * 尽力下发服务端表情（type:llm + emotion）：固件仅当主题含同名自定义图时生效，
   * 否则保留状态驱动画面；进休息→sleepy、恢复→neutral。零副作用（无图则忽略）。
   */
  _sendEmotion(ws, emotion) {
    if (!ws || ws.readyState !== 1) return;
    this.sendMessage(ws, {
      type: SERVER_MESSAGE_TYPES.LLM,
      session_id: ws.sessionId,
      emotion,
      timestamp: new Date().toISOString()
    });
  }

  /** 清除"休息"展示态（回聊天标签 + 复位持久标记 + 尽力恢复表情）；唤醒词唤醒即触发 */
  _clearRestDisplay(ws) {
    if (!ws || !ws.restMode) return;
    ws.restMode = false;
    if (this.store && ws.deviceId) this.store.markDeviceRest(ws.deviceId, 0);
    this._sendMode(ws);
    this.sendI18n(ws); // 同步清除「待命→休息」状态覆盖
    this._sendEmotion(ws, 'neutral');
    logger.info(`☀️ 退出休息（恢复聊天） [${ws.clientId}]`);
  }

  /** 告别/休眠播报文案（唤醒词由设备本地识别，此处只作提示） */
  _sleepFarewellText() {
    return '好的，我先休眠啦。需要我的时候，说出唤醒词就能把我叫醒。再见！';
  }

  /**
   * 当前说话人：声纹识别命中（ws.currentSpeaker） > 默认单一说话人（voiceprint.defaultSpeaker）。
   * 声纹服务未启用时全链路以默认说话人运行；接入声纹 API 后自动逐人切换，消费侧无需改动。
   */
  _speaker(ws) {
    return (ws && ws.currentSpeaker) || this.config.voiceprint?.defaultSpeaker || null;
  }

  /** 下发屏幕状态文案覆盖表（key=固件中文原文）；中文下发空表=清除覆盖；口语/休息模式下叠加专属文案 */
  sendI18n(ws) {
    const lang = this.deviceLang(ws);
    const map = { ...(STATUS_TEXTS[lang] || {}) };
    if (ws.practiceMode) {
      Object.assign(map, PRACTICE_STATUS_OVERRIDES[lang] || PRACTICE_STATUS_OVERRIDES.zh);
      // 已收到首段作答：「请说话」改「请继续」更自然
      if ((ws.practiceBuffer || []).length > 0) {
        Object.assign(map, PRACTICE_STATUS_CONTINUE[lang] || PRACTICE_STATUS_CONTINUE.zh);
      }
    }
    // 休息态：idle 状态栏的「待命」改显为休息词（与聊天闲置区分；需固件扩展字体支撑）
    if (ws.restMode) {
      Object.assign(map, REST_STATUS_OVERRIDES[lang] || REST_STATUS_OVERRIDES.zh);
    }
    this.sendMessage(ws, {
      type: 'i18n',
      map,
      session_id: ws.sessionId,
      timestamp: new Date().toISOString()
    });
  }

  /** 默认语言变更后热推所有在线设备（文案包+模式标签） */
  applyLanguageToSessions(lang) {
    const dm = this.getDeviceManager();
    if (!dm || !dm.getAllDevices) return 0;
    let n = 0;
    for (const d of dm.getAllDevices()) {
      const conn = d.connection;
      if (!conn || conn.readyState !== 1) continue;
      if (lang) this.ttsService.defaultLanguage = lang;
      this.sendI18n(conn);
      this._sendMode(conn);
      n++;
    }
    console.log(`🌐 i18n pushed to ${n} online device(s), lang=${lang}`);
    return n;
  }

  /** per-device 设定保存后热更在线连接（语言/阈值即时生效） */
  applyDeviceSettings(deviceId, settings) {
    const dm = this.getDeviceManager();
    if (!dm || !dm.getAllDevices) return 0;
    let n = 0;
    for (const d of dm.getAllDevices()) {
      const conn = d.connection;
      if (!conn || conn.readyState !== 1) continue;
      if (!this._sameIdent(d.deviceId, deviceId) && !this._sameIdent(conn.deviceId, deviceId)) continue;
      conn.deviceSettings = settings || {};
      this.sendI18n(conn);
      this._sendMode(conn);
      n++;
    }
    console.log(`🌐 device settings applied to ${n} session(s), deviceId=${deviceId}`);
    return n;
  }

  /**
   * 远程开/入口语练习模式（由 /api/settings/practice 调用）：
   * deviceId 为空时作用于全部在线会话，否则仅匹配设备
   * @param {string|null} deviceId
   * @param {boolean} on
   * @param {string} endMode 'manual'|'auto'（新进入时的默认收卷方式）
   */
  applyPracticeMode(deviceId, on, endMode = 'manual') {
    const dm = this.getDeviceManager();
    if (!dm || !dm.getAllDevices) return 0;
    let n = 0;
    for (const d of dm.getAllDevices()) {
      const conn = d.connection;
      if (!conn || conn.readyState !== 1) continue;
      if (deviceId && !this._sameIdent(d.deviceId, deviceId) && !this._sameIdent(conn.deviceId, deviceId)) continue;
      conn.practiceMode = !!on;
      if (on) {
        conn.practiceBuffer = conn.practiceBuffer || [];
        conn.practiceEndMode = conn.practiceEndMode || endMode;
        conn.practiceLastActiveAt = Date.now();
      } else {
        conn.practiceBuffer = [];
      }
      this._sendMode(conn);
      this.sendI18n(conn);
      n++;
    }
    console.log(`🎙️ practice mode ${on ? 'on' : 'off'} applied to ${n} session(s), deviceId=${deviceId || 'all'}`);
    return n;
  }

  /**
   * 语音流程采集态（去域化，供 /api/voice/session 调用）：让设备进入“口语聚合式
   * 作答采集”，复用 practiceBuffer/listen stop/auto 全套机制；收卷时把整段转写
   * POST 回 callbackUrl（谁发起会话谁收答案）。与口语练习模式的区别只在收卷出口。
   * @param {{deviceId?:string|null, endOn?:'button'|'auto', callbackUrl:string, sessionId?:string|null, token?:string}} opts
   */
  startVoiceFlow({ deviceId = null, endOn = 'button', callbackUrl, sessionId = null, token = null } = {}) {
    const dm = this.getDeviceManager();
    if (!dm || !dm.getAllDevices) return 0;
    const mode = endOn === 'auto' ? 'auto' : 'manual';
    const cbToken = token || this.config.voiceFlow?.token || '';
    let n = 0;
    for (const d of dm.getAllDevices()) {
      const conn = d.connection;
      if (!conn || conn.readyState !== 1) continue;
      if (deviceId && !this._sameIdent(d.deviceId, deviceId) && !this._sameIdent(conn.deviceId, deviceId) && !this._sameIdent(d.clientId, deviceId)) continue;
      conn.practiceMode = true;
      conn.practiceBuffer = [];
      conn.practiceEndMode = mode;
      conn.practiceLastActiveAt = Date.now();
      conn.flowCollect = { url: callbackUrl, sessionId, token: cbToken };
      this.activeVoiceFlows.set(d.deviceId, { endOn: mode, callbackUrl, sessionId, token: cbToken, storedAt: Date.now() });
      this._sendMode(conn);
      this.sendI18n(conn);
      n++;
    }
    logger.info(`🎙️ 语音流程采集态 on → ${n} session(s), device=${deviceId || 'all'}, endOn=${mode}, callback=${callbackUrl || '(none)'}`);
    return n;
  }

  /**
   * 退出语音流程采集态（/api/voice/session/close）：清采集缓冲与回调，回到普通聊天。
   * @param {{deviceId?:string|null}} opts
   */
  closeVoiceFlow({ deviceId = null } = {}) {
    const dm = this.getDeviceManager();
    if (!dm || !dm.getAllDevices) return 0;
    let n = 0;
    for (const d of dm.getAllDevices()) {
      const conn = d.connection;
      if (!conn || conn.readyState !== 1) continue;
      if (deviceId && !this._sameIdent(d.deviceId, deviceId) && !this._sameIdent(conn.deviceId, deviceId) && !this._sameIdent(d.clientId, deviceId)) continue;
      conn.practiceMode = false;
      conn.practiceBuffer = [];
      conn.flowCollect = null;
      this.activeVoiceFlows.delete(d.deviceId);
      this._sendMode(conn);
      this.sendI18n(conn);
      n++;
    }
    logger.info(`🎙️ 语音流程采集态 off → ${n} session(s), device=${deviceId || 'all'}`);
    return n;
  }

  /**
   * 模式闸门（两条识别路径——handleCompleteChatMessage 与 _handleSttResultDirectly——共用）：
   * 休息模式静默/退出、进入休息、口语练习模式聚合/切换/进出、办公(员工)模式切换与业务回合。
   * @returns {Promise<boolean>} true=本轮已被模式层消化，调用方直接 return
   */
  async _handleModeGate(ws, text) {
    // 设备名寻址（避免集体串扰）：允许"人设名 + 触发词"（如「大酒桶 进入休息模式」）。
    // 声音过大被多台设备同时拾取时，非目标设备解析到寻址名≠本机名 → 直接忽略本轮，
    // 目标设备在自己的连接上照常执行 → 只有被点名那台切模式，其余不受影响。
    // 不带设备名的裸指令（方案A）仍只作用于当前说话连接自身（保持日常便利）。
    const addr = this._resolveModeAddress(this._normAddr(text));
    if (addr.matched) {
      const selfNorm = this._normAddr(((this.deviceSettings(ws).persona || {}).name || ''));
      if (!selfNorm || selfNorm !== addr.normName) {
        logger.info(`🎯 模式指令寻址他机「${addr.rawName}」(指令:${addr.cmd})，本机忽略: "${text}" [${ws.clientId}]`);
        return true;
      }
    }
    const modeCmd = addr.matched ? addr.cmd : this._matchModeCommand(text);
    // 休息=进入待机（温和休眠）：仅置"休息"展示态（屏幕模式标签 + 后台状态），不再吞输入。
    // 恢复：设备被本地唤醒词唤醒会上报 listen start，服务端在该钩子清展示态回聊天；
    // 兼容：休息态下若命中"退出休息"口令，也直接清展示态。
    if (ws.restMode && (modeCmd === 'rest-off' || modeCmd === 'employee-off')) {
      this._clearRestDisplay(ws);
      await this._speakFixed(ws, fixedText(this.deviceLang(ws), 'restExit'));
      return true;
    }
    if (modeCmd === 'rest-on') {
      ws.restMode = true; // 仅作"休息"展示态：不再据此屏蔽输入
      ws.employeeMode = false; // 互斥：休息优先
      // 待命期间 WS 仍保持连接，靠该持久标记把设备展示为"休息"（唤醒/重连即复位）
      if (this.store && ws.deviceId) this.store.markDeviceRest(ws.deviceId, 1);
      logger.info(`💤 进入休息（回待机，说本机唤醒词即可恢复） [${ws.clientId}]`);
      this._sendMode(ws);
      this.sendI18n(ws); // 先推「待命→休息」覆盖，再休眠回 idle 时状态栏即显示休息
      await this._speakFixed(ws, fixedText(this.deviceLang(ws), 'restEnter'));
      // 下发休眠指令让设备停止监听回 Idle（温和休眠，保持连接），消除"卡在倾听中"
      this.sendMessage(ws, {
        type: SERVER_MESSAGE_TYPES.SLEEP,
        session_id: ws.sessionId,
        timestamp: new Date().toISOString()
      });
      this._sendEmotion(ws, 'sleepy'); // 尽力切表情：主题含同名图才生效，否则维持待机画面
      logger.info(`💤 已下发休眠指令，设备进入待机 [${ws.clientId}]`);
      return true;
    }
    // ==================== 口语练习模式（长段讲述不抢答）====================
    if (modeCmd === 'practice-on') {
      ws.practiceMode = true;
      ws.practiceBuffer = [];
      ws.practiceEndMode = this.config.practice?.endMode || 'manual';
      ws.practiceLastActiveAt = Date.now();
      ws.employeeMode = false; // 互斥
      logger.info(`🎙️ 进入口语练习模式（收卷方式: ${ws.practiceEndMode}） [${ws.clientId}]`);
      this._sendMode(ws);
      this.sendI18n(ws);
      await this._speakFixed(ws, fixedText(this.deviceLang(ws), 'practiceEnter'));
      return true;
    }
    if (ws.practiceMode) {
      if (modeCmd === 'practice-off') {
        ws.practiceMode = false;
        ws.practiceBuffer = [];
        logger.info(`🎙️ 退出口语练习模式 [${ws.clientId}]`);
        this._sendMode(ws);
        this.sendI18n(ws);
        await this._speakFixed(ws, fixedText(this.deviceLang(ws), 'practiceExit'));
        return true;
      }
      if (modeCmd === 'practice-end-manual' || modeCmd === 'practice-end-auto') {
        ws.practiceEndMode = modeCmd === 'practice-end-auto' ? 'auto' : 'manual';
        ws.practiceLastActiveAt = Date.now();
        logger.info(`🎙️ 口语模式收卷方式切换: ${ws.practiceEndMode} [${ws.clientId}]`);
        await this._speakFixed(ws, fixedText(this.deviceLang(ws), ws.practiceEndMode === 'auto' ? 'practiceEndAuto' : 'practiceEndManual'));
        return true;
      }
      // 普通讲述片段：静默聚合，不发起聊天轮
      await this._handlePracticeTurn(ws, text);
      return true;
    }
    if (modeCmd) {
      await this._handleEmployeeCommand(ws, text, modeCmd);
      return true;
    }
    if (ws.employeeMode) {
      await this._handleEmployeeTurn(ws, ws.sessionId, text);
      return true;
    }
    return false;
  }

  /**
   * 办公(员工)模式切换：由模式闸门调用（employee-on/off）
   */
  async _handleEmployeeCommand(ws, text, cmd) {
    const empCfg = this.config.employee || {};
    if (cmd === 'employee-on') {
      if (!employeeModeEnabled(empCfg)) {
        await this._speakFixed(ws, '办公模式未启用，请先在服务器配置');
        return;
      }
      ws.employeeMode = true;
      logger.info(`🧠 进入办公(员工)模式 [${ws.clientId}]`);
      this._sendMode(ws);
      await this._speakFixed(ws, '已进入办公模式，请讲');
      return;
    }
    // employee-off：若本来在办公模式则确认退出；否则视为回到普通聊天
    const was = ws.employeeMode;
    ws.employeeMode = false;
    logger.info(`🧠 ${was ? '退出办公(员工)模式' : '切回聊天模式'} [${ws.clientId}]`);
    this._sendMode(ws);
    await this._speakFixed(ws, was ? '已退出办公模式' : '好的，现在是聊天模式');
  }

  /**
   * 固定文本播报：与语音放送同款轮次语义（turnChain 串行 + turnSeq 递增 +
   * 广播静音闸门），可被设备 listen start（按键）打断
   */
  _speakFixed(ws, text) {
    const run = async () => {
      const myTurn = (ws.turnSeq || 0) + 1;
      ws.turnSeq = myTurn;
      const sessionId = ws.sessionId || uuidv4();
      ws.broadcastActive = true; // 复用闸门：本次播报的麦克风回声不自打断
      try {
        return await this.sendTtsAudio(ws, sessionId, text, myTurn, { cacheable: true });
      } finally {
        ws.broadcastActive = false;
        ws.broadcastIgnoreUntil = Date.now() + 2000;
      }
    };
    const prev = ws.turnChain || Promise.resolve();
    ws.turnChain = prev
      .catch(() => {})
      .then(run)
      .catch((error) => logger.warn(`固定播报异常 [${ws.clientId}]: ${error.message}`));
    return ws.turnChain;
  }

  /**
   * 员工模式一轮：文本 POST 给映射的数字员工（同步等回复）→ TTS 播报。
   * 业务错（未绑定/禁用）照实播报；网络/超时类降级为通用提示。
   * 往来落 xz_conversations（provider='employee'）便于审计。
   */
  async _handleEmployeeTurn(ws, sessionId, text) {
    const cfg = this.config.employee || {};
    const deviceId = ws.deviceId || ws.clientId;
    logger.info(`🧠 员工模式轮次 → ${deviceId}: "${String(text).slice(0, 50)}"`);
    this._logConversation(ws, { role: 'user', text, sessionId, provider: 'employee' });
    let replyText;
    try {
      const data = await askEmployee(cfg, deviceId, text);
      replyText = String(data.reply || '').trim() || '员工没有返回内容';
    } catch (err) {
      logger.warn(`员工桥调用失败 [${deviceId}]: ${err.message}`);
      replyText = /バインド|無効|存在しません|未有効|デバイスがバインド/.test(String(err.message))
        ? String(err.message)
        : '数字员工暂时不可用，请稍后再试';
    }
    this._logConversation(ws, { role: 'bot', text: replyText, sessionId, provider: 'employee' });
    await this._speakFixed(ws, replyText);
  }

  // ==================== 口语练习模式辅助 ====================

  /**
   * 口语练习片段：静默聚合，不发起聊天轮。
   * 收卷触发源：manual（默认）=设备按键 listen stop（零额外 LLM 调用）；
   * auto=每片段追加一次 LLM 说完判定（CONTINUE 等待 / DONE 收卷）。
   * 注：片段级 batch 识别沿用 _triggerSttRecognition（每片段独立），对
   * stt.maxBufferSize（默认 100 帧≈6s）无长音频依赖，长段讲述不受其截断影响。
   */
  async _handlePracticeTurn(ws, text) {
    ws.practiceBuffer = ws.practiceBuffer || [];
    ws.practiceBuffer.push(text);
    ws.practiceLastActiveAt = Date.now();
    // 设备屏显片段（不触发 speak/LLM）
    this.sendSttResponse(ws, ws.sessionId, text);
    logger.info(`🎙️ 口语模式聚合片段(${ws.practiceBuffer.length}): "${text}" [${ws.clientId}]`);
    // 首段落定后重推文案：屏幕从「请说话」切到「请继续」
    if (ws.practiceBuffer.length === 1) this.sendI18n(ws);
    if ((ws.practiceEndMode || 'manual') !== 'auto') return;
    if (!this.llmService || !this.llmService.isConfigured()) {
      logger.warn(`LLM 服务不可用，auto 收卷无法判定，可用按键兜底 [${ws.clientId}]`);
      return;
    }
    const joined = ws.practiceBuffer.join('');
    const verdict = await this.llmService.classifyPracticeDone(joined);
    if (verdict === 'DONE') {
      await this._finalizePracticeTurn(ws);
    }
  }

  /**
   * 口语练习收卷：聚合全文走“总结/点评”轮（教练提示词），播完清空 buffer。
   * 期间短暂退出模式：防总结全文自身再被闸门拦截；完成后恢复模式支持连续多轮练习。
   */
  async _finalizePracticeTurn(ws) {
    if (ws.practiceFinalizing) return;
    const joined = (ws.practiceBuffer || []).join('').trim();
    // 语音流程采集态（控制器权威，去域化）：整段作答交回发起方 callbackUrl，
    // 不跑教练总结、不播报（下一题/反馈由控制器经 /api/voice/speak 推回）。
    // 复用 practiceBuffer/listen stop/auto DONE，收卷后即清 buffer 等待下一题。
    if (ws.flowCollect) {
      // 空 buffer（未说话就按键收卷）：仍投递空转写给控制器——按键 stop 是显式提交动作，
      // 控制器需据此走重问/记 0 分等流程（控制器权威）。投递后清 buffer 保持采集态待下一轮。
      ws.practiceFinalizing = true;
      ws.practiceLastActiveAt = Date.now();
      try {
        ws.practiceBuffer = [];
        logger.info(`🎙️ 语音流程收卷：投递转写(${joined.length}字)→回调 [${ws.clientId}]`);
        await this._postFlowCallback(ws, joined);
      } finally {
        ws.practiceFinalizing = false;
        ws.practiceLastActiveAt = Date.now();
        this.sendI18n(ws); // buffer 已清，下轮回到「请说话」
      }
      return;
    }
    if (!joined) {
      logger.info(`🎙️ 口语收卷：buffer 为空，播提示 [${ws.clientId}]`);
      await this._speakFixed(ws, fixedText(this.deviceLang(ws), 'practiceNone'));
      return;
    }
    ws.practiceFinalizing = true;
    ws.practiceLastActiveAt = Date.now();
    const wasMode = ws.practiceMode;
    try {
      ws.practiceMode = false;
      ws.practiceBuffer = [];
      logger.info(`🎙️ 口语收卷：发起总结轮(${joined.length}字) [${ws.clientId}]`);
      await this.handleCompleteChatMessage(ws, joined, null, { practiceSummary: true, skipModeGate: true });
    } finally {
      ws.practiceMode = wasMode;
      ws.practiceFinalizing = false;
      ws.practiceLastActiveAt = Date.now();
      if (wasMode) this.sendI18n(ws); // 总结轮后回到口语态，文案回落
    }
  }

  /**
   * 投递聚合转写给语音流程控制器（aistudy / aiinterview）。
   * 头 X-Xiaozhi-Key 携带与发起方约定的共享密钥；控制器据此跑 submitTurn/submitAnswer。
   * fire-and-forget 语义：失败仅记日志，不阻断设备（控制器可经超时重问）。
   */
  async _postFlowCallback(ws, transcript) {
    const cb = ws.flowCollect;
    if (!cb || !cb.url) return;
    const deviceId = ws.deviceId || ws.clientId;
    const token = cb.token || this.config.voiceFlow?.token || '';
    try {
      const res = await fetch(cb.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Xiaozhi-Key': String(token) },
        body: JSON.stringify({ deviceId, sessionId: cb.sessionId || null, transcript })
      });
      if (!res.ok) {
        logger.warn(`语音流程回调失败 [${deviceId}]: HTTP ${res.status}`);
      } else {
        logger.info(`🎙️ 语音流程回调已投递 [${deviceId}] → ${cb.url}`);
      }
    } catch (e) {
      logger.warn(`语音流程回调异常 [${deviceId}]: ${e.message}`);
    }
  }


  // 发送聊天响应
  sendChatResponse(clientId, text, sessionId = null) {
    const dm = this.getDeviceManager();
    if (!dm || !dm.getDevice) {
      throw new Error(`设备管理器未初始化`);
    }

    const device = dm.getDevice(clientId);

    if (!device || !device.connection) {
      throw new Error(`设备未连接: ${clientId}`);
    }

    this.sendToClient(device.connection, {
      session_id: sessionId,
      type: 'chat',
      text: text,
      state: 'complete'
    });
  }

  // 触发AI响应流程
  async triggerAIResponse(ws, wakeWord) {
    const sessionId = ws.sessionId;
    const clientId = ws.clientId;

    try {
      // 生成AI回复文本
      const replyText = this.generateAIResponse(wakeWord);

      // 1. 发送STT消息（识别结果）
      this.sendToClient(ws, {
        type: 'stt',
        session_id: sessionId,
        text: wakeWord,
        timestamp: new Date().toISOString()
      });

      // 2. 发送LLM消息（大模型回复）
      this.sendToClient(ws, {
        type: 'llm',
        session_id: sessionId,
        text: replyText,
        emotion: this.detectEmotion(replyText),
        timestamp: new Date().toISOString()
      });

      // 3. 发送TTS开始
      this.sendToClient(ws, {
        type: 'tts',
        session_id: sessionId,
        state: 'start',
        timestamp: new Date().toISOString()
      });

      // 4. 发送句子开始（带文本）
      this.sendToClient(ws, {
        type: 'tts',
        session_id: sessionId,
        state: 'sentence_start',
        text: replyText,
        timestamp: new Date().toISOString()
      });

      // 5. 模拟发送音频数据（实际应该调用TTS服务）
      setTimeout(() => {
        // 发送TTS停止
        this.sendToClient(ws, {
          type: 'tts',
          session_id: sessionId,
          state: 'stop',
          timestamp: new Date().toISOString()
        });
      }, 1000);

    } catch (error) {
      logger.error(`触发AI响应失败: ${error.message}`);
      this.sendError(ws, 'AI响应生成失败', sessionId);
    }
  }

  // 生成AI回复
  generateAIResponse(text) {
    const responses = [
      `我听到了你说的话：${text}。有什么我可以帮助你的吗？`,
      `好的，我明白了。你说的"${text}"是什么意思呢？`,
      `收到！关于"${text}"，我可以为你提供更多信息。`,
      `我在听呢。你想聊些什么？`,
    ];

    return responses[Math.floor(Math.random() * responses.length)];
  }

  // ==================== STT音频处理辅助方法 ====================

  /**
   * 触发STT语音识别
   * @param {WebSocket} ws - WebSocket连接
   * @param {string} sessionId - 会话ID
   */
  async _triggerSttRecognition(ws, sessionId) {
    // logger.info(`🎬 开始触发语音识别: ${sessionId}`);

    if (!this.sttService) {
      logger.warn(`STT服务未初始化`);
      return;
    }

    const session = this.sttService.getSession(sessionId);
    if (!session) {
      logger.warn(`STT会话不存在: ${sessionId}`);
      return;
    }

    // 获取缓存的音频数据
    const audioBuffer = session.audioBuffer || [];

    // 清空缓冲区并重置状态
    session.audioBuffer = [];
    session.voiceStop = false;

    // 标记正在处理，防止 receiveAudio 中重复触发
    session.isProcessing = true;

    // logger.info(`📦 音频缓冲区帧数: ${audioBuffer.length}`);
    if (audioBuffer.length < 15) {
      logger.debug(`音频数据不足，跳过识别: ${audioBuffer.length} 帧`);
      session.isProcessing = false;
      return;
    }

    let wavBufferForVoiceprint = null;
    try {
      // 解码 Opus 为 PCM 并保存为 WAV
      let combinedPcm;
      const pcmFrames = this.sttService._decodeOpusFrames(audioBuffer);
      if (pcmFrames.length > 0) {
        combinedPcm = Buffer.concat(pcmFrames);
      }
      if (combinedPcm && combinedPcm.length > 0) {
        // 检查音频数据是否有效（非静音）
        // 阈值优先级：设备个体设定 > 设备协议上报 > 全局默认
        const dsAudio = this.deviceSettings(ws).audio;
        const thresholds = (dsAudio && Object.keys(dsAudio).length > 0)
          ? { ...this.defaultAudioThresholds, ...(ws.audioThresholds || {}), ...dsAudio }
          : (ws.audioThresholds || this.defaultAudioThresholds);
        const audioStats = this._analyzeAudioAmplitude(combinedPcm, thresholds);
        logger.info(`📊 音频判定[${audioStats.mode}]: 有效=${audioStats.isValid} 峰值窗RMS=${audioStats.peakWinRms.toFixed(0)} 噪声底=${audioStats.noiseFloorRms.toFixed(0)} 对比度=${audioStats.contrast.toFixed(1)} 活动窗=${audioStats.activeWindows} | max=${audioStats.maxAmplitude} avg=${audioStats.avgAmplitude.toFixed(1)} rms=${audioStats.rms.toFixed(1)}`);

        // 生成 WAV 供声纹识别使用（不落盘调试）
        wavBufferForVoiceprint = this._createWavBuffer(combinedPcm, 16000, 1, 16);

        if (!audioStats.isValid) {
          logger.info(`🔇 音频振幅不足，判定为无效，跳过识别`);
          session.isProcessing = false;
          return;
        }

        // 如果是 PCM 格式，直接发送给 FunASR 识别
        logger.info(`🎤 使用 PCM 数据直接调用识别服务 (provider=${this.sttService.provider})...`);
        let result = await this.sttService._recognizePcm(combinedPcm, sessionId);
        const sttText = this._unwrapSttText(result);
        logger.info(`✅ 识别结果: "${sttText}"`);

        // 处理识别结果并触发后续流程（空内容不进入下一轮）
        if (sttText) {
          await this._handleSttResultDirectly(ws, sessionId, result);
        }

        session.isProcessing = false;
        return; // 直接返回，不再调用后面的识别
      }
    } catch (decodeError) {
      logger.warn(`解码音频失败: ${decodeError.message}`);
      logger.error(decodeError.stack);
      session.isProcessing = false;
    }


    try {
      // 并发执行 STT 识别和声纹识别
      const tasks = [];

      // STT 识别任务 - 使用内部方法，不触发回调
      tasks.push(this.sttService._recognizePcm(combinedPcm, sessionId).then(result => {
        if (result && result.text) {
          return this._handleSttResultDirectly(ws, sessionId, result);
        }
        return null;
      }));

      // 声纹识别任务（如果有 WAV 数据且声纹服务可用）
      if (wavBufferForVoiceprint && this.voiceprintService && this.voiceprintService.isEnabled()) {
        tasks.push(
          this.voiceprintService.identifySpeaker(wavBufferForVoiceprint, sessionId)
            .then(speakerName => {
              if (speakerName) {
                logger.info(`🎯 声纹识别结果: ${speakerName}`);
                ws.currentSpeaker = speakerName;
              }
              return speakerName;
            })
            .catch(err => {
              logger.warn(`声纹识别失败: ${err.message}`);
              return null;
            })
        );
      }

      await Promise.all(tasks);
      logger.info(`✅ 语音识别调用完成`);
    } catch (error) {
      logger.error(`❌ 语音识别失败: ${error.message}`);
      this.sendError(ws, `语音识别失败: ${error.message}`, sessionId);
    } finally {
      session.isProcessing = false;
    }
  }

  /**
   * 从 STT 识别结果中还原纯文本
   * funasr/aibridge 带语种/情绪标签时会返回结构化对象（挂在 result.parsed），
   * 并把它 JSON.stringify 后塞进 result.text。此方法统一取出 content 纯文本；
   * 无标签时 text 本身就是纯文本，原样返回。
   * @param {Object|string} result - 识别结果对象或文本
   * @returns {string} 去除 JSON 包装后的纯识别文本（可能为空串）
   */
  _unwrapSttText(result) {
    if (result == null) return '';
    if (typeof result === 'string') {
      return this._unwrapSttJson(result);
    }
    if (typeof result.parsed === 'object' && result.parsed !== null) {
      return String(result.parsed.content ?? '').trim();
    }
    return this._unwrapSttJson(result.text ?? '');
  }

  /**
   * 若字符串本身是一段 {"content":...} JSON，则取出其中的 content，否则原样返回
   * @param {string} raw
   * @returns {string}
   */
  _unwrapSttJson(raw) {
    const trimmed = String(raw ?? '').trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const data = JSON.parse(trimmed);
        if (typeof data.content === 'string') return data.content.trim();
      } catch {
        /* 非合法 JSON，原样返回 */
      }
    }
    return trimmed;
  }

  /**
   * 直接处理STT识别结果（不通过回调）
   * 避免与 receiveAudio 中的自动触发重复
   * @param {WebSocket} ws - WebSocket连接
   * @param {string} sessionId - 会话ID
   * @param {Object} result - 识别结果
   */
  async _handleSttResultDirectly(ws, sessionId, result) {
    const { confidence, provider } = result;
    const connectionId = ws.clientId;

    // STT 服务（funasr/aibridge）在带语种/情绪标签时，会把结构化结果序列化成
    // JSON 字符串塞进 text（形如 {"content":"","language":"zh","emotion":"😶"}）。
    // 这里先还原成纯文本再往下走：否则空 content 会把整段 JSON 当作用户输入
    // 记录到对话日志并喂给 LLM（表现为 bot 回复「我听到了你说的 {…}」）。
    const text = this._unwrapSttText(result);
    if (!text) {
      logger.info(`🔇 识别内容为空（仅语种/情绪标签），忽略本轮 [${connectionId}]`);
      return;
    }

    // 识别置信度阈值（stt.confidenceThreshold，默认 0 即不启用）：
    // FunASR 当前回传固定 0.9，接入真实置信度后此阈值自动生效
    const minConf = this.config.stt?.confidenceThreshold ?? 0;
    if (minConf > 0 && typeof confidence === 'number' && confidence < minConf) {
      logger.info(`🔇 置信度不足(${confidence.toFixed(2)}<${minConf})，忽略识别: "${text}" [${connectionId}]`);
      return;
    }
    // 识别文本是否为噪音/语气词（提前拦省一次 Quest 创建）
    if (this._isNoiseInput(text)) {
      logger.info(`🔇 忽略无效识别（噪音/语气词）: "${text}" [${connectionId}]`);
      return;
    }
    // 回声判定（与 handleCompleteChatMessage 同口径）：无AEC设备播放时麦克风收进
    // 自己喇叭的声音（含语音放送），识别碎片若不过滤会触发打断，杀死正在播放的音频流
    if (this._isEchoOfSpoken(ws, text)) {
      logger.info(`🔁 判定为回声拾取，忽略: "${text}" [${connectionId}]`);
      return;
    }

    // 口语收卷中：总结轮播报/生成期间到达的片段丢弃（防残尾音频误开新一轮），
    // 收卷完成后 practiceMode 恢复，下一轮练习正常聚合
    if (ws.practiceMode && ws.practiceFinalizing) {
      logger.info(`🎙️ 口语收卷中，忽略片段: "${text}" [${ws.clientId}]`);
      return;
    }

    // ==================== 员工/休息/聊天模式闸门（与 handleCompleteChatMessage 同源）====================
    if (await this._handleModeGate(ws, text)) return;

    // ==================== Quest管理 ====================
    // 获取或创建活跃Quest
    const quest = this.questManager.getOrCreateActiveQuest(connectionId, {
      sessionId,
      deviceId: ws.deviceId
    });
    const questId = quest.questId;
    quest.incrementMessageCount();
    logger.info(`使用Quest: ${questId} (消息数: ${quest.messageCount})`);
    // ==================== Quest管理结束 ====================

    // 开始聊天流程（传递questId用于LLM对话历史管理）
    await this._startToChat(ws, text, questId);
  }

  /**
   * 处理STT识别结果回调
   * @param {string} sessionId - 会话ID
   * @param {Object} result - 识别结果
   */
  async _handleSttResult(sessionId, result) {
    const ws = this._getWsBySessionId(sessionId);
    if (!ws) {
      logger.warn(`找不到会话对应的WebSocket连接: ${sessionId}`);
      return;
    }

    // 检查是否已经在处理中（防止重复处理）
    const session = this.sttService.getSession(sessionId);
    if (session && session.isProcessing) {
      logger.debug(`会话正在处理中，跳过回调: ${sessionId}`);
      return;
    }

    await this._handleSttResultDirectly(ws, sessionId, result);
  }

  /**
   * 处理STT错误回调
   * @param {string} sessionId - 会话ID
   * @param {Error} error - 错误对象
   */
  _handleSttError(sessionId, error) {
    const ws = this._getWsBySessionId(sessionId);
    if (ws) {
      this.sendError(ws, `语音识别失败: ${error.message}`, sessionId);
    }
  }

  /**
   * 根据会话ID获取WebSocket连接
   * @param {string} sessionId - 会话ID
   * @returns {WebSocket|null}
   */
  _getWsBySessionId(sessionId) {
    if (!this.wss) return null;

    for (const client of this.wss.clients) {
      if (client.sessionId === sessionId) {
        return client;
      }
    }
    return null;
  }

  /**
   * 开始聊天流程
   * 参照Python: startToChat
   * @param {WebSocket} ws - WebSocket连接
   * @param {string} text - 用户文本
   * @param {string} questId - 可选的Quest ID
   */
  async _startToChat(ws, text, questId = null, options = {}) {
    // 解析JSON格式的输入（可能包含说话人/语种/questId 等信息）
    // STT 路径传入的 text 已在 _handleSttResultDirectly 还原为纯文本；
    // 这里主要处理客户端直接以 JSON 形式发来的 listen 文本。
    let speakerName = null;
    let languageTag = null;
    let actualText = text;
    let parsedQuestId = questId;

    try {
      if (typeof text === 'string' && text.trim().startsWith('{') && text.trim().endsWith('}')) {
        const data = JSON.parse(text);
        // content 为空串时也要采用（不能用 if(data.content) 判真假，否则空串会漏过，
        // 导致整段 JSON 被当作用户输入）
        if (typeof data.content === 'string') {
          actualText = data.content;
        }
        if (data.speaker) {
          speakerName = data.speaker;
          ws.currentSpeaker = speakerName;
        }
        if (data.language) {
          languageTag = data.language;
          ws.currentLanguageTag = languageTag || 'zh';
        }
        // 支持从JSON中提取questId
        if (data.questId) {
          parsedQuestId = data.questId;
        }
        // 支持closeQuest标志（TODO）
        if (data.closeQuest) {
          this.questManager.closeActiveQuest(ws.clientId);
          parsedQuestId = null; // 强制创建新Quest
        }
      }
    } catch (e) {
      // 非JSON格式，直接使用原文本
    }

    // 还原后仍为空：本轮没有有效识别内容，直接忽略，不把空输入/原始 JSON 记入日志
    if (!String(actualText).trim()) {
      logger.info(`🔇 输入还原后为空，忽略本轮聊天 [${ws.clientId}]`);
      return;
    }

    // 发送STT识别结果消息（用 ws.sessionId，修正此前引用未定义变量 sessionId/confidence/provider 导致的静默报错）
    this.sendMessage(ws, {
      type: 'stt',
      session_id: ws.sessionId,
      text: actualText,
      timestamp: new Date().toISOString()
    });

    // 检查是否需要绑定设备
    if (ws.needBind) {
      await this._checkBindDevice(ws);
      return;
    }

    // 检查输出限制
    if (ws.maxOutputSize > 0) {
      // TODO: 实现输出限制检查
    }

    // 中止旧播放的动作已移至 handleCompleteChatMessage：必须先过有效性/回声过滤，
    // 否则噪音乱码短文本也会把用户正在听的语音杀掉

    // 进行意图分析（如果配置了意图服务）
    const intentHandled = await this._handleIntent(ws, actualText);
    if (intentHandled) {
      return;
    }

    // 处理完整的聊天消息
    await this.handleCompleteChatMessage(ws, actualText, parsedQuestId, options);
  }

  /**
   * 处理意图
   */
  async _handleIntent(ws, text) {
    // 退出意图：“再见/拜拜”等告别语 → 播完告别语后下发 sleep，
    // 设备进入低功耗休眠（息屏，本地唤醒词模型只等自定义唤醒词），再次唤醒才恢复对话
    const cleaned = String(text || '').replace(/[\s\p{P}\p{S}]/gu, '');
    const GOODBYE_WORDS = ['再见', '拜拜', '不聊了', '结束吧', '结束对话', '休眠吧', '睡觉吧', '退下吧', '没事了', '晚安', '没任务了'];
    const isGoodbye = cleaned.length > 0 && cleaned.length <= 12
      && GOODBYE_WORDS.some((w) => cleaned.includes(w));
    if (!isGoodbye) return false;

    logger.info(`👋 检测到退出意图: "${text}" [${ws.clientId}]`);
    const farewell = this._sleepFarewellText();
    // 告别休眠同样置"休息"展示态（屏幕模式标签 + 后台状态），与语音进休一致
    ws.restMode = true;
    ws.employeeMode = false;
    if (this.store && ws.deviceId) this.store.markDeviceRest(ws.deviceId, 1);
    this._sendMode(ws);
    // 播完告别语音再发 sleep（轮次号+1：大于既有中止线，不会被残留打断信号误杀）
    await this.sendTtsAudio(ws, ws.sessionId, farewell, (ws.turnSeq || 0) + 1);
    this.sendMessage(ws, {
      type: SERVER_MESSAGE_TYPES.SLEEP,
      session_id: ws.sessionId,
      timestamp: new Date().toISOString()
    });
    this._sendEmotion(ws, 'sleepy'); // 尽力切表情：主题含同名图才生效，否则维持待机画面
    logger.info(`💤 已下发休眠指令，设备回待机等待唤醒 [${ws.clientId}]`);
    return true;
  }

  /**
   * 检查设备绑定
   */
  async _checkBindDevice(ws) {
    if (ws.bindCode) {
      const text = `请登录控制面板，输入${ws.bindCode}，绑定设备。`;
      this.sendMessage(ws, {
        type: 'stt',
        session_id: ws.sessionId,
        text: text,
        timestamp: new Date().toISOString()
      });
      // TODO: 播放提示音
    } else {
      const text = '没有找到该设备的版本信息，请正确配置OTA地址，然后重新编译固件。';
      this.sendMessage(ws, {
        type: 'stt',
        session_id: ws.sessionId,
        text: text,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * 检测语音活动（VAD）
   * 参照 Python silero.py 实现
   * @param {WebSocket} ws - WebSocket连接
   * @param {Buffer} opusPacket - Opus音频数据包
   * @returns {boolean} 是否有语音
   */
  async _detectVoice(ws, opusPacket) {
    // 手动模式：直接返回True，不进行实时VAD检测，所有音频都缓存
    if (ws.clientListenMode === 'manual') {
      return true;
    }

    // 如果有VAD服务且已启用，使用VAD服务
    if (this.vadService && this.vadService.isEnabled()) {
      const result = this.vadService.detect(opusPacket);
      if (result !== null) {
        return result;
      }
    }

    // 初始化连接级别的VAD状态（参照Python conn对象）
    if (!ws.vadState) {
      ws.vadState = {
        audioBuffer: Buffer.alloc(0),      // client_audio_buffer: PCM音频缓冲区
        voiceWindow: [],                    // client_voice_window: 滑动窗口
        haveVoice: false,                   // client_have_voice: 当前是否有语音
        lastIsVoice: false,                 // last_is_voice: 上一帧是否有语音
        lastActivityTime: Date.now(),       // last_activity_time: 最后活动时间
        voiceStop: false                    // client_voice_stop: 语音是否停止
      };
    }

    const state = ws.vadState;

    try {
      // Opus解码为PCM（参照Python: pcm_frame = self.decoder.decode(opus_packet, 960)）
      let pcmFrame = null;
      if (this.sttService && this.sttService.decoder) {
        try {
          // 解码Opus包为PCM（16000Hz, 60ms帧）
          pcmFrame = this.sttService.decoder.decode(opusPacket, 960);
        } catch (e) {
          logger.debug(`Opus解码失败: ${e.message}`);
          return false;
        }
      } else {
        // 如果没有Opus解码器，使用原始数据作为近似
        pcmFrame = opusPacket;
      }

      if (!pcmFrame || pcmFrame.length === 0) {
        return false;
      }

      // 将新数据加入缓冲区（参照Python: conn.client_audio_buffer.extend(pcm_frame)）
      state.audioBuffer = Buffer.concat([state.audioBuffer, pcmFrame]);

      // VAD配置参数（参照Python silero.py）——阈值均可经 config.vad 配置
      // 阈值需高于环境底噪能量（归一化 RMS）才能把安静判为静默；默认 0.0025/0.0015 由底噪≈0.0015、语音≈0.003+ 反推
      const VAD_THRESHOLD = this.config.vad?.threshold ?? 0.0025;           // 高阈值
      const VAD_THRESHOLD_LOW = this.config.vad?.thresholdLow ?? 0.0015;    // 低阈值
      const SILENCE_THRESHOLD_MS = this.deviceSettings(ws).audio?.silenceThresholdMs ?? this.config.vad?.silenceThresholdMs ?? 1500;  // 静默阈值（设备个体设定优先）
      const FRAME_WINDOW_THRESHOLD = 3;                                  // 至少3帧才算有语音
      const SAMPLES_PER_FRAME = 512;                                     // 每帧512采样点
      const BYTES_PER_SAMPLE = 2;                                        // 16bit = 2 bytes

      let clientHaveVoice = false;

      // 处理缓冲区中的完整帧（每次处理512采样点）
      while (state.audioBuffer.length >= SAMPLES_PER_FRAME * BYTES_PER_SAMPLE) {
        // 提取前512个采样点（1024字节）
        const chunk = state.audioBuffer.slice(0, SAMPLES_PER_FRAME * BYTES_PER_SAMPLE);
        state.audioBuffer = state.audioBuffer.slice(SAMPLES_PER_FRAME * BYTES_PER_SAMPLE);

        // 计算音频能量（简单能量检测替代Silero模型）
        // 参照Python: audio_int16 = np.frombuffer(chunk, dtype=np.int16)
        const audioInt16 = new Int16Array(chunk.buffer, chunk.byteOffset, SAMPLES_PER_FRAME);

        // 计算RMS能量并归一化到0-1范围（类似Python: audio_float32 = audio_int16.astype(np.float32) / 32768.0）
        let sumSquares = 0;
        for (let i = 0; i < audioInt16.length; i++) {
          const sample = audioInt16[i] / 32768.0;
          sumSquares += sample * sample;
        }
        const rmsEnergy = Math.sqrt(sumSquares / audioInt16.length);

        // 双阈值判断（参照Python silero.py 第71-77行）
        let isVoice;
        if (rmsEnergy >= VAD_THRESHOLD) {
          isVoice = true;
        } else if (rmsEnergy <= VAD_THRESHOLD_LOW) {
          isVoice = false;
        } else {
          // 在中间区域，延续前一个状态
          isVoice = state.lastIsVoice;
        }
        // 声音没低于最低值则延续前一个状态（参照Python第80行）
        state.lastIsVoice = isVoice;

        // 更新滑动窗口（参照Python: conn.client_voice_window.append(is_voice)）
        state.voiceWindow.push(isVoice);
        // 保持窗口大小（最多10帧）
        if (state.voiceWindow.length > 10) {
          state.voiceWindow.shift();
        }

        // 判断是否有语音（窗口内超过阈值数量的帧有声音）
        const trueCount = state.voiceWindow.filter(v => v).length;
        clientHaveVoice = trueCount >= FRAME_WINDOW_THRESHOLD;

        // 如果之前有声音，但本次没有声音，且与上次有声音的时间差已经超过了静默阈值
        // 则认为已经说完一句话（参照Python第88-92行）
        if (state.haveVoice && !clientHaveVoice) {
          const stopDuration = Date.now() - state.lastActivityTime;
          if (stopDuration >= SILENCE_THRESHOLD_MS) {
            state.voiceStop = true;
            logger.debug(`检测到语音停止，静默时间: ${stopDuration}ms`);
          }
        }

        // 如果有语音，更新状态和时间戳（参照Python第93-95行）
        if (clientHaveVoice) {
          state.haveVoice = true;

          state.lastActivityTime = Date.now();
        }
      }
      return clientHaveVoice;
    } catch (error) {
      logger.error(`VAD处理错误: ${error.message}`);
      return false;
    }
  }

  /**
   * 处理打斷
   * @param {WebSocket} ws - WebSocket连接
   */
  async _handleAbort(ws) {
    logger.info(`处理打斷请求 [${ws.clientId}]`);

    // 发送打斷消息
    this.sendMessage(ws, {
      type: 'abort',
      session_id: ws.sessionId,
      reason: 'user_interrupt',
      timestamp: new Date().toISOString()
    });

    // 设置状态：中止截至当前轮次的所有语音流（带归属，不误杀发起打断的新轮）
    ws.clientIsSpeaking = false;
    ws.abortUpTo = ws.turnSeq || 0;
  }

  /**
   * 检查空闲超时
   * @param {WebSocket} ws - WebSocket连接
   * @param {boolean} hasVoice - 是否有语音
   */
  async _checkIdleTimeout(ws, hasVoice) {
    const now = Date.now();

    // 口语练习模式：跳过“无语音 goodbye/关连接”巡检，改走讲述超时兜底
    // （忘按按钮/中途走开 → 静默超时后自动收卷，防聚合态永久悬挂）
    if (ws.practiceMode) {
      if (!hasVoice && ws.practiceBuffer?.length && !ws.practiceFinalizing) {
        ws.practiceLastActiveAt = ws.practiceLastActiveAt || now;
        const timeoutMs = this.config.practice?.silenceTimeoutMs ?? 120000;
        if (now - ws.practiceLastActiveAt >= timeoutMs) {
          logger.info(`🎙️ 口语模式静默超 ${timeoutMs}ms，强制收卷 [${ws.clientId}]`);
          this._finalizePracticeTurn(ws);
        }
      }
      return;
    }

    // 休息态是"保持连接待唤"的展示态：设备不发有效语音属预期，不做无语音巡检。
    // 且休息期间把空闲时钟推到当下：否则时钟冻结在进休息前，用户唤醒后的第一帧
    // 会立即触发告别语（实测：退出休息 97ms 后就播出 end_prompt）。
    if (ws.restMode) {
      ws.lastActivityTime = now;
      ws.closeAfterChat = false;
      return;
    }

    if (hasVoice) {
      ws.lastActivityTime = now;
      // 新一轮人声即对话继续：解除上一轮空闲置位的结束标记。本 fork 不真正关闭连接
      // （休息/待命靠心跳保活，closeAfterChat 无关连接消费点），它只作一次性告别语的
      // 防重标记，因此必须可复位，否则一次空闲后该连接再不触发空闲结束。
      ws.closeAfterChat = false;
      return;
    }

    // 只有在已初始化时间戳的情况下才检查超时
    if (ws.lastActivityTime && ws.lastActivityTime > 0) {
      const noVoiceTime = now - ws.lastActivityTime;
      const timeout = (this.config.close_connection_no_voice_time || 120) * 1000;

      if (!ws.closeAfterChat && noVoiceTime > timeout) {
        logger.info(`长时间无语音，结束本轮对话 [${ws.clientId}]`);
        ws.closeAfterChat = true;

        // 发送结束提示
        const endPrompt = this.config.end_prompt?.prompt ||
          '请你以```时间过得真快```为开头，用富有感情、依依不舍的话来结束这场对话吧。';

        await this._startToChat(ws, endPrompt);
      }
    }
  }

  /**
   * 热更新服务器默认音频有效性阈值（由 /api/settings/audio 调用）
   * 注意：已推送过设备专属阈值（ws.audioThresholds）的会话不受影响
   * @param {Object} params { minMaxAmplitude, minAvgAmplitude, silenceThresholdMs }
   */
  updateAudioThresholds({ minMaxAmplitude, minAvgAmplitude, silenceThresholdMs } = {}) {
    if (Number.isInteger(minMaxAmplitude)) this.defaultAudioThresholds.minMaxAmplitude = minMaxAmplitude;
    if (Number.isInteger(minAvgAmplitude)) this.defaultAudioThresholds.minAvgAmplitude = minAvgAmplitude;
    if (this.config && this.config.audio) {
      this.config.audio.minMaxAmplitude = this.defaultAudioThresholds.minMaxAmplitude;
      this.config.audio.minAvgAmplitude = this.defaultAudioThresholds.minAvgAmplitude;
    }
    // 静默收尾阈值（realtime VAD 一句话结束判定）：写入 config.vad，handleBinaryData 每轮读取即时生效
    if (Number.isInteger(silenceThresholdMs)) {
      this.config.vad = { ...(this.config.vad || {}), silenceThresholdMs };
    }
    logger.info(`音频有效性阈值已更新(服务器默认): max=${this.defaultAudioThresholds.minMaxAmplitude}, avg=${this.defaultAudioThresholds.minAvgAmplitude}, 静默=${this.config.vad?.silenceThresholdMs ?? 1500}ms`);
    return this.defaultAudioThresholds;
  }

  /**
   * 断开指定在线设备的 WebSocket 连接（管理端操作，由 /api/disconnect 调用）
   * @param {string} clientId 设备会话ID（live 设备表 clientId 字段）
   * @returns {boolean} 是否成功发出关闭
   */
  closeDevice(clientId) {
    const device = this.deviceManager?.getDevice?.(clientId);
    const conn = device?.connection;
    if (!device || !conn || conn.readyState !== 1) {
      return false;
    }
    try {
      conn.close(1000, 'admin disconnect');
      logger.info(`管理端已断开设备: ${clientId} (MAC=${device.mac || device.deviceId || '-'})`);
      return true;
    } catch (e) {
      logger.warn(`断开设备 ${clientId} 失败: ${e.message}`);
      return false;
    }
  }

  /**
   * 分析音频振幅，判断是否有效音频
   * @param {Buffer} pcmData - PCM 音频数据 (16-bit signed)
   * @param {Object} thresholds - 阈值配置 { minMaxAmplitude, minAvgAmplitude }
   * @returns {Object} 振幅统计信息 { maxAmplitude, avgAmplitude, isValid }
   */
  _analyzeAudioAmplitude(pcmData, thresholds = {}) {
    // 委托给自适应噪声门：合并“设备级阈值（audioThresholds）”与“全局自适应参数 （config.audio）”。
    // 保留旧返回字段 maxAmplitude/avgAmplitude/isValid，并新增自适应诊断字段。
    const a = this.config.audio || {};
    // 设备级 gate 覆盖：settings.audio 可直接覆盖自适应判定参数（小声/远场设备放宽对比度与持续窗）
    const stats = analyzeAudioGate(pcmData, {
      adaptive: thresholds.adaptive ?? a.adaptive,
      sampleRate: a.sampleRate || this.config.stt?.sampleRate || 16000,
      windowMs: thresholds.windowMs ?? a.windowMs,
      absoluteSpeechFloor: thresholds.absoluteSpeechFloor ?? a.absoluteSpeechFloor,
      speechToNoiseMin: thresholds.speechToNoiseMin ?? a.speechToNoiseMin,
      noiseFloorWindowRatio: thresholds.noiseFloorWindowRatio ?? a.noiseFloorWindowRatio,
      minActiveWindows: thresholds.minActiveWindows ?? a.minActiveWindows,
      minMaxAmplitude: thresholds.minMaxAmplitude ?? a.minMaxAmplitude,
      minAvgAmplitude: thresholds.minAvgAmplitude ?? a.minAvgAmplitude,
    });
    return stats;
  }

  /**
   * 创建 WAV 文件缓冲区
   * @param {Buffer} pcmData - PCM 音频数据
   * @param {number} sampleRate - 采样率
   * @param {number} channels - 声道数
   * @param {number} bitsPerSample - 位深度
   * @returns {Buffer} WAV 文件缓冲区
   */
  _createWavBuffer(pcmData, sampleRate, channels, bitsPerSample) {
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const dataSize = pcmData.length;
    const fileSize = 44 + dataSize;

    const buffer = Buffer.alloc(fileSize);
    let offset = 0;

    // RIFF header
    buffer.write('RIFF', offset); offset += 4;
    buffer.writeUInt32LE(fileSize - 8, offset); offset += 4;
    buffer.write('WAVE', offset); offset += 4;

    // fmt chunk
    buffer.write('fmt ', offset); offset += 4;
    buffer.writeUInt32LE(16, offset); offset += 4; // chunk size
    buffer.writeUInt16LE(1, offset); offset += 2;  // audio format (PCM)
    buffer.writeUInt16LE(channels, offset); offset += 2;
    buffer.writeUInt32LE(sampleRate, offset); offset += 4;
    buffer.writeUInt32LE(byteRate, offset); offset += 4;
    buffer.writeUInt16LE(blockAlign, offset); offset += 2;
    buffer.writeUInt16LE(bitsPerSample, offset); offset += 2;

    // data chunk
    buffer.write('data', offset); offset += 4;
    buffer.writeUInt32LE(dataSize, offset); offset += 4;
    pcmData.copy(buffer, offset);

    return buffer;
  }
}

// 创建全局WebSocket处理器实例的工厂函数
let handler = null;

export const initializeWebSocketHandler = (options = {}) => {
  if (!handler) {
    handler = new WebSocketHandler(options);
    logger.info('WebSocket处理器已初始化');
  }
  return handler;
};

export const handleWebSocketConnection = (ws, req, wss, options = {}) => {
  // 确保handler已初始化
  const wsHandler = initializeWebSocketHandler(options);
  wsHandler.wss = wss;
  // 更新服务引用（确保使用最新的服务实例）
  if (options.deviceManager) wsHandler.deviceManager = options.deviceManager;
  if (options.sessionManager) wsHandler.sessionManager = options.sessionManager;
  if (options.llmService) wsHandler.llmService = options.llmService;
  if (options.ttsService) wsHandler.ttsService = options.ttsService;
  if (options.sttService) wsHandler.sttService = options.sttService;
  if (options.vadService) wsHandler.vadService = options.vadService;
  if (options.voiceprintService) wsHandler.voiceprintService = options.voiceprintService;
  if (options.mcpService) wsHandler.mcpService = options.mcpService;
  if (options.gala) wsHandler.gala = options.gala;
  if (options.store) wsHandler.store = options.store;
  wsHandler.handleConnection(ws, req);
};

// 导出兼容的 webSocketHandler（在初始化后会被设置）
export const webSocketHandler = {
  get handler() {
    return handler;
  }
};

export default WebSocketHandler;