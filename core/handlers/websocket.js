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
import McpService from '../services/mcp.js';
import { getQuestManager } from '../managers/quest.js';
import { audioConverter } from '../utils/audioConverter.js';
import { analyzeAudioGate } from '../utils/audioGate.js';
import { resolveMockFlags } from '../utils/devMode.js';
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
    ws.clientIp = clientIp;
    ws.connectedAt = new Date();
    ws.isAlive = true;
    ws.isAuthenticated = false;
    ws.sessionId = null;
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
    const dm = this.getDeviceManager();
    if (dm && dm.removeDevice) {
      dm.removeDevice(ws.clientId);
    }

    // 持久化设备表标记离线
    if (this.store && ws.deviceId) {
      this.store.markDeviceOffline(ws.deviceId);
    }

    // 处理MCP客户端断开
    if (this.mcpService) {
      this.mcpService.handleDeviceDisconnect(ws.clientId);
    }

    if (ws.sessionId) {
      logger.info(`会话结束: ${ws.sessionId} (${ws.clientId})`);
    }
  }

  /**
   * 处理MCP消息
   */
  async handleMcpMessage(ws, payload) {
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
      // 静默阈值可配置（config.vad.silenceThresholdMs，经 /api/settings/audio 热更新），默认 1500ms
      const SILENCE_THRESHOLD_MS = this.config.vad?.silenceThresholdMs ?? 1500;
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
        const { version, transport, audio_params, device_id, device_name, device_mac, token, features } = payload;

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

        // 握手携带的设备元信息补登注册表（名称/MAC）
        if (this.store && ws.deviceId) {
          this.store.recordDevice({
            deviceId: ws.deviceId,
            clientId: ws.clientId,
            name: device_name,
            mac: device_mac,
            ip: ws.clientIp,
            source: 'ws',
            online: 1
          });
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
        // 同步当前会话模式标签到设备屏幕
        this._sendMode(ws);

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
          // 开始监听，清除音频状态
          // 设备开始新一轮采集，中止截至当前轮次的旧TTS音频流（带轮次归属，后面新轮不受影响）
          if (ws.clientIsSpeaking && ws.clientListenMode !== 'manual') {
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
  async handleCompleteChatMessage(ws, text, questId = null) {
    // 所有触发路径（STT回调 / listen文本 / chat消息）的总收敛过滤：
    // 噪音/语气词/空标点不进入对话轮，避免误触发挤掉用户正在等的真实回复
    if (this._isNoiseInput(text)) {
      logger.info(`🔇 忽略无效输入: "${text}" [${ws.clientId}]`);
      return;
    }

    // 模式闸门（休息/办公/聊天）：与 _handleSttResultDirectly 共用同一实现
    if (await this._handleModeGate(ws, text)) return;

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
        this._runChatTurn(ws, text, questId, myTurn),
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
   */
  _isEchoOfSpoken(ws, text) {
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
  async _runChatTurn(ws, text, questId = null, myTurn = 0) {
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
        const llmResponse = await this.generateLlmResponse(ws, text, questId);

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
        provider: entry.provider
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
   * 生成LLM回复
   * @param {WebSocket} ws - WebSocket连接
   * @param {string} text - 用户输入文本
   * @param {string} questId - Quest ID，用于管理对话历史
   * @returns {Promise<string>} LLM回复文本
   */
  async generateLlmResponse(ws, text, questId = null) {
    const connectionId = ws.clientId;

    if (this.llmService && this.llmService.isConfigured()) {
      try {
        // 使用questId作为对话历史的key，如果没有questId则使用connectionId
        const historyKey = questId || connectionId;
        // LLM超时保护：后端（如dsh bridge）无响应时快速兜底，避免挂死整个轮次队列。
        // 默认60s：本地推理单轮实测20-40s，过紧会频繁落入兜底回复
        const llmTimeoutMs = (this.config.llmTimeoutSeconds || 60) * 1000;
        const response = await Promise.race([
          this.llmService.chat(historyKey, text),
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
    this.sendMessage(ws, { type: SERVER_MESSAGE_TYPES.TTS, session_id: sid, state: TTS_STATES.STOP, timestamp: now });
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

    const parts = (this.ttsService && typeof this.ttsService._splitText === 'function')
      ? this.ttsService._splitText(text)
      : [text];

    // 合并过短片段到上一段（不超过 maxLen）
    const merged = [];
    for (const p of parts) {
      if (merged.length && p.length < minLen && (merged[merged.length - 1].length + p.length) <= maxLen) {
        merged[merged.length - 1] += p;
      } else {
        merged.push(p);
      }
    }
    // 对仍超长的一段按 maxLen 硬切
    const out = [];
    for (const m of merged) {
      if (m.length <= maxLen) { out.push(m); continue; }
      for (let i = 0; i < m.length; i += maxLen) out.push(m.slice(i, i + maxLen));
    }
    // 段数上限：超出部分合并到末段
    if (out.length > maxCount) {
      const head = out.slice(0, maxCount - 1);
      head.push(out.slice(maxCount - 1).join(''));
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
  async sendTtsAudio(ws, sessionId, text, myTurn = 0) {
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

          // 先合成第一段，成功再发 START（避免音频没生成就把设备推进“说话中”却收不到帧→卡死）
          const firstResult = await this.ttsService.synthesize(segments[0]);
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
            const result = i === 0 ? firstResult : await this.ttsService.synthesize(seg);
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
            if (result.mockFrames !== undefined) {
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
              console.log(`🎵 第${i + 1}/${segments.length}段 Opus编码完成: ${opusFrames.length} 帧`);
            }
            if (opusFrames.length > 0) {
              await this.sendOpusAudioFrames(ws, opusFrames, sessionId, turn);
            }
          }

          // 6. 发送TTS停止消息（一次，确保设备退出“说话中”）
          this.sendMessage(ws, {
            type: SERVER_MESSAGE_TYPES.TTS,
            session_id: sessionId,
            state: TTS_STATES.STOP,
            timestamp: new Date().toISOString()
          });

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

    // 发送TTS欢迎消息
    try {
      const welcomeText = `你好！我是小智，有什么可以帮助你的吗？`;
      const ttsResult = await this.ttsService.synthesize(welcomeText);

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
   * 启动心跳检测
   */
  startHeartbeat(interval = 30000) {
    // TODO: 待实现心跳检测逻辑
  }

  /**
   * 停止心跳检测
   */
  stopHeartbeat() {
    // TODO: 待实现心跳停止逻辑
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
      return d.deviceId === deviceId || d.clientId === deviceId;
    });
  }

  /**
   * 将文本合成语音后广播到已连接设备（复用 sendTtsAudio 完整播放链路：
   * 合成 → tts start → Opus 帧 → tts stop）。接入连接轮次链 turnChain：
   * 同一设备同时只有一条流在发送，多条放送/对话应答排队串行，杜绝Opus帧交错；
   * 递增 turnSeq 使放送可被用户真实打断（abortUpTo 归属机制同样生效）。
   * 音频按实时节奏串行发送，调用方应 fire-and-forget，不要同步等待。
   */
  async broadcastToDevices(text, { deviceId = null } = {}) {
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
          ok = await this.sendTtsAudio(conn, sessionId, text, myTurn);
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
   *   { employeeOn:[...] , employeeOff:[...], restOn:[...], restOff:[...] }
   * 匹配：识别文本去空格/标点后与短语全等即命中（短语自己写清“进入/退出”语义）。
   * @returns {'employee-on'|'employee-off'|'rest-on'|'rest-off'|null}
   */
  _matchModeCommand(text) {
    const norm = (s) => String(s || '').replace(/[\s\p{P}\p{S}]/gu, '');
    const t = norm(text);
    if (!t) return null;
    const kw = this.config.modeKeywords || {};
    const hit = (list) => Array.isArray(list) && list.some((p) => p && norm(p) === t);
    if (hit(kw.employeeOn)) return 'employee-on';
    if (hit(kw.employeeOff)) return 'employee-off';
    if (hit(kw.restOn)) return 'rest-on';
    if (hit(kw.restOff)) return 'rest-off';
    return null;
  }

  // ==================== 员工模式辅助 ====================

  /**
   * 下发当前会话模式标签到设备屏幕顶部栏（layout #6）：
   * 仅 休息 / 员工 / 聊天 三种（待命属于聊天态，不再单独显示）
   */
  _sendMode(ws) {
    // 休息/员工优先；普通态下若开发模式总开关打开则显示"开发"，否则"聊天"。
    // 后端仍可随时改这些标签（本方法每次实时读取）。
    const flags = resolveMockFlags(this.config);
    const label = ws.restMode ? '休息' : (ws.employeeMode ? '员工' : (flags.master ? '开发' : '聊天'));
    this.sendMessage(ws, {
      type: SERVER_MESSAGE_TYPES.MODE,
      text: label,
      session_id: ws.sessionId,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * 模式闸门（两条识别路径——handleCompleteChatMessage 与 _handleSttResultDirectly——共用）：
   * 休息模式静默/退出、进入休息、办公(员工)模式切换与业务回合。
   * @returns {Promise<boolean>} true=本轮已被模式层消化，调用方直接 return
   */
  async _handleModeGate(ws, text) {
    const modeCmd = this._matchModeCommand(text);
    if (ws.restMode) {
      if (modeCmd === 'rest-off' || modeCmd === 'employee-off') {
        ws.restMode = false;
        logger.info(`☀️ 退出休息模式，恢复聊天 [${ws.clientId}]`);
        this._sendMode(ws);
        await this._speakFixed(ws, '好的，我回来啦，有事随时叫我');
      } else {
        logger.info(`💤 休息模式中，静默忽略输入: "${text}"${modeCmd ? ` (指令:${modeCmd})` : ''} [${ws.clientId}]`);
      }
      return true;
    }
    if (modeCmd === 'rest-on') {
      ws.restMode = true;
      ws.employeeMode = false; // 互斥：休息优先
      logger.info(`💤 进入休息模式（不再应答，直到退出休息） [${ws.clientId}]`);
      this._sendMode(ws);
      await this._speakFixed(ws, '好的，我休息了。需要我的时候说「你好小智」，再讲「退出休息」');
      // 关键：下发休眠指令让设备真正停止监听（息屏低功耗），消除“卡在倾听中”
      this.sendMessage(ws, {
        type: SERVER_MESSAGE_TYPES.SLEEP,
        session_id: ws.sessionId,
        timestamp: new Date().toISOString()
      });
      logger.info(`💤 已下发休眠指令，设备停止监听 [${ws.clientId}]`);
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
        return await this.sendTtsAudio(ws, sessionId, text, myTurn);
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
        // 使用设备特定阈值或默认阈值
        const thresholds = ws.audioThresholds || this.defaultAudioThresholds;
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
  async _startToChat(ws, text, questId = null) {
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
    await this.handleCompleteChatMessage(ws, actualText, parsedQuestId);
  }

  /**
   * 处理意图
   */
  async _handleIntent(ws, text) {
    // 退出意图：“再见/拜拜”等告别语 → 播完告别语后下发 sleep，
    // 设备进入低功耗休眠（息屏，本地唤醒词模型只等“你好小智”），再次唤醒才恢复对话
    const cleaned = String(text || '').replace(/[\s\p{P}\p{S}]/gu, '');
    const GOODBYE_WORDS = ['再见', '拜拜', '不聊了', '结束吧', '结束对话', '休眠吧', '睡觉吧', '退下吧', '没事了', '晚安', '没任务了'];
    const isGoodbye = cleaned.length > 0 && cleaned.length <= 12
      && GOODBYE_WORDS.some((w) => cleaned.includes(w));
    if (!isGoodbye) return false;

    logger.info(`👋 检测到退出意图: "${text}" [${ws.clientId}]`);
    const farewell = '好的，我先休眠啦。需要我的时候，说「你好小智」就能把我叫醒。再见！';
    // 播完告别语音再发 sleep（轮次号+1：大于既有中止线，不会被残留打断信号误杀）
    await this.sendTtsAudio(ws, ws.sessionId, farewell, (ws.turnSeq || 0) + 1);
    this.sendMessage(ws, {
      type: SERVER_MESSAGE_TYPES.SLEEP,
      session_id: ws.sessionId,
      timestamp: new Date().toISOString()
    });
    logger.info(`💤 已下发休眠指令，设备进入低功耗等待唤醒 [${ws.clientId}]`);
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
      const SILENCE_THRESHOLD_MS = this.config.vad?.silenceThresholdMs ?? 1500;  // 静默阈值
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

    if (hasVoice) {
      ws.lastActivityTime = now;
      return;
    }

    // 只有在已初始化时间戳的情况下才检查超时
    if (ws.lastActivityTime && ws.lastActivityTime > 0) {
      const noVoiceTime = now - ws.lastActivityTime;
      const timeout = (this.config.close_connection_no_voice_time || 120) * 1000;

      if (!ws.closeAfterChat && noVoiceTime > timeout) {
        logger.info(`长时间无语音，准备关闭连接 [${ws.clientId}]`);
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
    // 委托给自适应噪声门：合并“设备级阈值（audioThresholds）”与“全局自适应参数（config.audio）”。
    // 保留旧返回字段 maxAmplitude/avgAmplitude/isValid，并新增自适应诊断字段。
    const a = this.config.audio || {};
    const stats = analyzeAudioGate(pcmData, {
      adaptive: a.adaptive,
      sampleRate: a.sampleRate || this.config.stt?.sampleRate || 16000,
      windowMs: a.windowMs,
      absoluteSpeechFloor: a.absoluteSpeechFloor,
      speechToNoiseMin: a.speechToNoiseMin,
      noiseFloorWindowRatio: a.noiseFloorWindowRatio,
      minActiveWindows: a.minActiveWindows,
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