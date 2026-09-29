/**
 * Xiaozhi Channel - 小智物联网语音交互频道
 * 集成xiaozhi项目的WebSocket语音交互功能
 */

import { EventEmitter } from 'events';
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { channelLogger } from './utils/logger.js';
import { getConfig, getServerConfig, getSttConfig, getTtsConfig, getLlmConfig, getChannelInfo } from './config/loader.js';

// 导入 xiaozhi 核心组件
import { initializeWebSocketHandler, handleWebSocketConnection } from './core/handlers/websocket.js';
import DeviceManager from './core/managers/device.js';
import SessionManager from './core/managers/session.js';
import XiaozhiStore from './core/managers/store.js';
import OTAHandler from './core/handlers/ota.js';
import LlmService from './core/services/llm.js';
import TtsService from './core/services/tts.js';
import SttService from './core/services/stt.js';
import VadService from './core/services/vad.js';
import VoiceprintService from './core/services/voiceprint.js';
import McpService from './core/services/mcp.js';

// standalone：不再依赖 gala 主进程与消息总线；LLM 走 bridge（config.llm.provider=openai/dsh）

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 从配置文件获取频道信息
const channelConfig = getConfig();
const CHANNEL_ID = channelConfig.id || 'xiaozhi';
const serverConfig = getServerConfig();
const DEFAULT_PORT = serverConfig.port;

/**
 * Xiaozhi Channel Class
 * 实现gala频道接口的xiaozhi语音交互频道
 */
export class XiaozhiChannel extends EventEmitter {
  constructor(config, bus) {
    super();
    this.config = config || {};
    this.bus = bus;
    this.name = CHANNEL_ID;
    this._running = false;

    // 记录频道初始化
    channelLogger.logModuleInit({
      channelId: CHANNEL_ID,
      port: this.config.port || DEFAULT_PORT,
      host: this.config.host || serverConfig.host
    }, { component: 'xiaozhi_channel' });

    // 服务器组件
    this.app = null;
    this.server = null;
    this.wss = null;

    // xiaozhi 核心服务
    this.deviceManager = null;
    this.sessionManager = null;
    this.otaHandler = null;
    this.store = null;  // 设备注册表/对话记录持久化
    this.gala = null;  // gala 实例

    // WebSocket 处理器
    this.webSocketHandler = null;

    // 端口配置
    this.port = this.config.port || DEFAULT_PORT;
    this.host = this.config.host || serverConfig.host;

    // 绑定方法上下文
    this.handleIncomingMessage = this.handleIncomingMessage.bind(this);
    this.handleOutgoingMessage = this.handleOutgoingMessage.bind(this);
  }

  /**
   * 启动xiaozhi频道
   */
  async start() {
    if (this._running) {
      channelLogger.warn('频道已在运行中', { component: 'xiaozhi_channel' });
      console.log(`[${CHANNEL_ID}] Channel already running`);
      return;
    }

    try {
      channelLogger.logModuleStart({ component: 'xiaozhi_channel' });
      console.log(`[${CHANNEL_ID}] Starting Xiaozhi channel...`);

      // 初始化核心服务
      await this.initializeServices();

      // 初始化WebSocket处理器
      this.initializeWebSocketHandler();

      // 创建Express应用和HTTP服务器
      this.setupExpressServer();

      // 启动服务器
      await this.startServer();

      // 注册到消息总线
      this.registerWithBus();

      this._running = true;
      channelLogger.logOperation('频道启动成功', {
        port: this.port,
        host: this.host
      }, 'success', null, { component: 'xiaozhi_channel' });

      console.log(`[${CHANNEL_ID}] Channel started successfully on port ${this.port}`);

    } catch (error) {
      channelLogger.logModuleError(error, '频道启动失败', { component: 'xiaozhi_channel' });
      console.error(`[${CHANNEL_ID}] Failed to start channel:`, error);
      throw error;
    }
  }

  /**
   * 停止xiaozhi频道
   */
  async stop() {
    if (!this._running) {
      return;
    }

    try {
      console.log(`[${CHANNEL_ID}] Stopping channel...`);

      // 从消息总线注销
      this.unregisterFromBus();

      // 停止WebSocket服务器
      if (this.wss) {
        this.wss.close();
      }

      // 停止HTTP服务器
      if (this.server) {
        await new Promise((resolve) => {
          this.server.close(() => {
            console.log(`[${CHANNEL_ID}] HTTP server stopped`);
            resolve();
          });
        });
      }

      // 清理服务
      this.cleanupServices();

      this._running = false;
      console.log(`[${CHANNEL_ID}] Channel stopped successfully`);

    } catch (error) {
      console.error(`[${CHANNEL_ID}] Error stopping channel:`, error);
    }
  }

  /**
   * 惰性初始化持久化 Store（管理接口在未启动频道时也可查询）
   */
  ensureStore() {
    if (!this.store) {
      this.store = new XiaozhiStore();
    }
    return this.store;
  }

  /**
   * 初始化xiaozhi核心服务
   */
  async initializeServices() {
    console.log(`[${CHANNEL_ID}] Initializing core services...`);

    try {
      // 初始化管理器
      this.sessionManager = new SessionManager();
      this.deviceManager = new DeviceManager();
      this.otaHandler = new OTAHandler(this.getServiceConfig());

      // 初始化持久化 Store，并把 OTA 设备上报接入注册表
      this.ensureStore();
      this.otaHandler.onDeviceReport = (info) => this.store.recordDevice(info);

      // 初始化服务
      this.llmService = new LlmService(this.config.llm || getLlmConfig());
      this.ttsService = new TtsService(this.config.tts || getTtsConfig());
      this.sttService = new SttService(this.config.stt || getSttConfig());
      this.vadService = new VadService();
      this.voiceprintService = new VoiceprintService();
      this.mcpService = new McpService();

      // 初始化服务
      await this.llmService.initialize();
      await this.ttsService.initialize();
      await this.sttService.initialize();
      await this.vadService.initialize();
      await this.voiceprintService.initialize();
      await this.mcpService.initialize();

      // standalone：无 gala 实例；总线为空实现
      this.gala = null;

    } catch (error) {
      console.error(`[${CHANNEL_ID}] Service initialization failed:`, error);
      throw error;
    }
  }


  /**
   * 获取服务配置（简化版，因为不再需要初始化本地服务）
   */
  getServiceConfig() {
    return {
      server: {
        port: this.port,
        host: this.host,
        environment: process.env.NODE_ENV || 'development'
      }
    };
  }

  /**
   * 初始化WebSocket处理器
   */
  initializeWebSocketHandler() {
    // 传递所有服务到WebSocket处理器
    this.webSocketHandler = initializeWebSocketHandler({
      deviceManager: this.deviceManager,
      sessionManager: this.sessionManager,
      llmService: this.llmService,
      ttsService: this.ttsService,
      sttService: this.sttService,
      vadService: this.vadService,
      voiceprintService: this.voiceprintService,
      mcpService: this.mcpService,
      store: this.store,
      gala: this.gala  // standalone 恒为 null
    });
  }

  /**
   * 设置Express服务器
   */
  setupExpressServer() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });

    // 中间件配置
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(express.static(path.join(__dirname, 'public')));

    // API路由
    this.setupRoutes();

    // WebSocket连接处理 - 传递所有服务
    this.wss.on('connection', (ws, req) => {
      handleWebSocketConnection(ws, req, this.wss, {
        deviceManager: this.deviceManager,
        sessionManager: this.sessionManager,
        llmService: this.llmService,
        ttsService: this.ttsService,
        sttService: this.sttService,
        vadService: this.vadService,
        voiceprintService: this.voiceprintService,
        mcpService: this.mcpService,
        store: this.store,
        gala: this.gala
      });
    });
  }

  /**
   * 设置API路由
   */
  setupRoutes() {
    // 健康检查
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        channel: CHANNEL_ID,
        devices: this.deviceManager ? Object.keys(this.deviceManager.devices || {}).length : 0,
        uptime: process.uptime()
      });
    });

    // 音频有效性(VAD振幅)阈值配置：读取 + 热更新 + 持久化 config.json
    this.app.get('/api/settings/audio', (req, res) => {
      const audio = this.config?.audio || {};
      const vad = this.config?.vad || {};
      res.json({
        ok: true,
        thresholds: {
          minMaxAmplitude: audio.minMaxAmplitude ?? 500,
          minAvgAmplitude: audio.minAvgAmplitude ?? 50,
          silenceThresholdMs: vad.silenceThresholdMs ?? 1500
        }
      });
    });

    this.app.post('/api/settings/audio', (req, res) => {
      const max = Number.parseInt(req.body?.minMaxAmplitude, 10);
      const avg = Number.parseInt(req.body?.minAvgAmplitude, 10);
      const silence = Number.parseInt(req.body?.silenceThresholdMs, 10);
      if (!Number.isInteger(max) || !Number.isInteger(avg) || max < 0 || max > 10000 || avg < 0 || avg > 10000) {
        return res.status(400).json({ ok: false, error: '振幅阈值须为 0~10000 的整数' });
      }
      if (!Number.isInteger(silence) || silence < 300 || silence > 5000) {
        return res.status(400).json({ ok: false, error: '静默阈值须为 300~5000ms 的整数' });
      }
      // 热更新运行时处理器默认阈值（对未设置设备专属阈值的会话立即可效）
      const handler = initializeWebSocketHandler();
      handler.updateAudioThresholds({ minMaxAmplitude: max, minAvgAmplitude: avg, silenceThresholdMs: silence });
      this.config.audio = { ...(this.config.audio || {}), minMaxAmplitude: max, minAvgAmplitude: avg };
      this.config.vad = { ...(this.config.vad || {}), silenceThresholdMs: silence };
      // 持久化 config.json
      let persisted = false;
      try {
        const cfgPath = path.join(__dirname, 'config.json');
        const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        raw.audio = { ...(raw.audio || {}), minMaxAmplitude: max, minAvgAmplitude: avg };
        raw.vad = { ...(raw.vad || {}), silenceThresholdMs: silence };
        fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2));
        persisted = true;
      } catch (e) {
        channelLogger.warn(`config.json 持久化失败: ${e.message}`);
      }
      res.json({
        ok: true,
        thresholds: { ...handler.defaultAudioThresholds, silenceThresholdMs: this.config.vad.silenceThresholdMs },
        persisted
      });
    });

    // 断开指定在线设备的 WebSocket 连接（管理操作，自旧 manage 页合并并真实实现）
    this.app.post('/api/disconnect', (req, res) => {
      const clientId = String(req.body?.clientId || '').trim();
      if (!clientId) {
        return res.status(400).json({ success: false, error: '缺少 clientId' });
      }
      const handler = this.webSocketHandler || initializeWebSocketHandler();
      const closed = handler.closeDevice(clientId);
      res.json({ success: closed, ...(closed ? {} : { error: '设备不在线或未找到' }) });
    });

    // 设备管理API（当前在线设备，Map 需转数组才能正确序列化）
    this.app.get('/api/devices', (req, res) => {
      if (this.deviceManager) {
        res.json(this.deviceManager.getAllDevices().map(d => d.toJSON()));
      } else {
        res.status(500).json({ error: 'Device manager not initialized' });
      }
    });

    // 已知设备列表（含离线，来自持久化设备注册表）
    this.app.get('/api/devices/known', (req, res) => {
      const store = this.ensureStore();
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const offset = parseInt(req.query.offset, 10) || 0;
      res.json(store.listDevices({ limit, offset }));
    });

    // 设备/对话统计
    this.app.get('/api/devices/stats', (req, res) => {
      const store = this.ensureStore();
      res.json({
        live: this.deviceManager ? this.deviceManager.getStats() : null,
        registered: store.getStats()
      });
    });

    // 对话记录查询（支持 deviceId / role / limit / offset 过滤）
    this.app.get('/api/conversations', (req, res) => {
      const store = this.ensureStore();
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const offset = parseInt(req.query.offset, 10) || 0;
      const { deviceId, role } = req.query;
      res.json(store.listConversations({
        deviceId: deviceId || null,
        role: (role === 'user' || role === 'bot') ? role : null,
        limit,
        offset
      }));
    });

    // 会话管理API
    this.app.get('/api/sessions', (req, res) => {
      if (this.sessionManager) {
        res.json(this.sessionManager.sessions || {});
      } else {
        res.status(500).json({ error: 'Session manager not initialized' });
      }
    });

    // 语音放送 API（由 Gala Web /api/channels/xiaozhi/broadcast 代理调用，
    // 也供局域网内直接推送）。合成+推流耗时，先验设备再受理后异步发送。
    this.app.post('/api/broadcast', (req, res) => {
      const text = String(req.body?.text || '').trim();
      if (!text) {
        return res.status(400).json({ success: false, error: 'text 不能为空' });
      }
      if (!this.webSocketHandler) {
        return res.status(500).json({ success: false, error: 'WebSocket handler 未初始化' });
      }
      const deviceId = req.body?.deviceId || null;
      const targets = this.webSocketHandler.getBroadcastTargets(deviceId);
      if (targets.length === 0) {
        return res.status(404).json({ success: false, error: '没有在线的小智设备' });
      }
      this.webSocketHandler.broadcastToDevices(text, { deviceId })
        .then(r => console.log(`[xiaozhi] broadcast done: ${JSON.stringify(r)}`))
        .catch(e => console.error('[xiaozhi] broadcast failed:', e.message));
      res.json({ success: true, accepted: true, devices: targets.length, message: 'broadcast queued' });
    });

    // WebSocket URL 信息 API - 提供 WS 和 WSS 两种协议
    this.app.get('/api/websocket/urls', (req, res) => {
      const useHttps = process.env.USE_HTTPS === 'true' || false;
      const protocol = useHttps ? 'wss' : 'ws';

      res.json({
        message: 'WebSocket连接信息',
        urls: {
          ws: `ws://${this.host}:${this.port}/xiaozhi/v1/`,
          wss: `wss://${this.host}:${this.port}/xiaozhi/v1/`
        },
        current: `${protocol}://${this.host}:${this.port}/xiaozhi/v1/`,
        use_https: useHttps,
        port: this.port,
        host: this.host
      });
    });

    // OTA 路由（保持与原始 xiaozhi 项目兼容）
    this.app.get('/xiaozhi/ota/', (req, res) => {
      if (!this.otaHandler) {
        return res.status(500).json({ error: 'OTA handler not initialized' });
      }
      const result = this.otaHandler.handleGet();
      res.json(result);
    });

    this.app.post('/xiaozhi/ota/', async (req, res) => {
      if (!this.otaHandler) {
        return res.status(500).json({ success: false, error: 'OTA handler not initialized' });
      }
      try {
        const result = await this.otaHandler.handlePost(req);
        res.json(result);
      } catch (error) {
        console.error(`[${CHANNEL_ID}] OTA POST 处理失败:`, error);
        res.status(500).json({ success: false, message: 'request error' });
      }
    });

    // OTA 固件下载地址（与 ota.js handlePost 中下发的 firmware.url 配套）
    this.app.get('/xiaozhi/ota/download/:filename', async (req, res) => {
      if (!this.otaHandler) {
        return res.status(500).json({ error: 'OTA handler not initialized' });
      }
      try {
        const result = await this.otaHandler.handleDownload(req.params.filename);
        if (result.error) {
          return res.status(result.status || 500).json({ error: result.error });
        }
        // 设备端 OTA 升级使用 HTTP GET 下载 merged bin
        res.download(result.filePath, result.filename, (err) => {
          if (err && !res.headersSent) {
            res.status(500).json({ error: 'download failed' });
          }
        });
      } catch (error) {
        console.error(`[${CHANNEL_ID}] OTA 固件下载失败:`, error);
        res.status(500).json({ error: 'download error' });
      }
    });
  }

  /**
   * 启动服务器
   */
  async startServer() {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, this.host, () => {
        const useHttps = process.env.USE_HTTPS === 'true' || false;
        console.log(`[${CHANNEL_ID}] Server listening on ${this.host}:${this.port}`);
        console.log(`[${CHANNEL_ID}] WebSocket endpoints:`);
        console.log(`  WS:  ws://${this.host}:${this.port}/xiaozhi/v1/`);
        console.log(`  WSS: wss://${this.host}:${this.port}/xiaozhi/v1/`);
        console.log(`  Current: ${(useHttps ? 'wss' : 'ws')}://${this.host}:${this.port}/xiaozhi/v1/`);
        console.log(`[${CHANNEL_ID}] API endpoint: http://${this.host}:${this.port}/api/websocket/urls`);
        resolve();
      });

      this.server.on('error', (error) => {
        console.error(`[${CHANNEL_ID}] Server error:`, error);
        reject(error);
      });
    });
  }

  /**
   * 注册到消息总线
   */
  registerWithBus() {
    if (this.bus) {
      // 监听来自其他频道的消息
      this.bus.on('outbound', this.handleOutgoingMessage);
      console.log(`[${CHANNEL_ID}] Registered with message bus`);
    }
  }

  /**
   * 从消息总线注销
   */
  unregisterFromBus() {
    if (this.bus) {
      this.bus.removeListener('outbound', this.handleOutgoingMessage);
      console.log(`[${CHANNEL_ID}] Unregistered from message bus`);
    }
  }

  /**
   * 处理来自其他频道的消息（转发到xiaozhi设备）
   */
  async handleOutgoingMessage(message) {
    // 这里可以实现将gala其他频道的消息转发给xiaozhi设备
    console.log(`[${CHANNEL_ID}] Received outgoing message:`, message);
  }

  /**
   * 处理来自xiaozhi设备的消息（转发到gala消息总线）
   */
  async handleIncomingMessage(deviceId, message) {
    // 这里可以实现将xiaozhi设备的消息转发到gala消息总线
    console.log(`[${CHANNEL_ID}] Received message from device ${deviceId}:`, message);

    if (this.bus) {
      // 转发到消息总线
      await this.bus.publish({
        channel: CHANNEL_ID,
        sender: deviceId,
        content: message,
        timestamp: Date.now()
      });
    }
  }

  /**
   * 清理服务资源
   */
  cleanupServices() {
    // 清理各个服务
    // 注意：有些服务可能没有cleanup方法，需要安全处理
    try {
      if (this.sessionManager && typeof this.sessionManager.cleanup === 'function') {
        this.sessionManager.cleanup();
      }
      if (this.deviceManager && typeof this.deviceManager.cleanup === 'function') {
        this.deviceManager.cleanup();
      }
      if (this.store) {
        this.store.close();
        this.store = null;
      }
    } catch (error) {
      console.warn(`[${CHANNEL_ID}] Service cleanup warning:`, error.message);
    }
  }

  /**
   * 检查频道是否正在运行
   */
  get isRunning() {
    return this._running;
  }

  /**
   * 获取频道状态信息
   */
  getStatus() {
    return {
      name: this.name,
      running: this._running,
      port: this.port,
      host: this.host,
      devices: this.deviceManager ? Object.keys(this.deviceManager.devices || {}).length : 0,
      sessions: this.sessionManager ? Object.keys(this.sessionManager.sessions || {}).length : 0
    };
  }
}

// ==================== 插件配置部分 ====================

// 从配置文件动态获取插件元数据
const pluginChannelInfo = getChannelInfo();
const pluginServerConfig = getServerConfig();
const pluginSttConfig = getSttConfig();
const pluginTtsConfig = getTtsConfig();
const pluginLlmConfig = getLlmConfig();

// 插件元数据
export const pluginMetadata = {
  id: pluginChannelInfo.id,
  name: pluginChannelInfo.name,
  description: pluginChannelInfo.desc,
  version: '1.0.0',
  author: 'Gala Team',
  type: 'channel',
  category: 'iot'
};

// 插件配置schema（基于实际配置值）
export const pluginConfigSchema = {
  type: 'object',
  properties: {
    port: {
      type: 'integer',
      minimum: 1,
      maximum: 65535,
      default: pluginServerConfig.port,
      description: 'WebSocket服务器端口'
    },
    host: {
      type: 'string',
      default: pluginServerConfig.host,
      description: '服务器监听地址'
    },
    llm: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          default: pluginLlmConfig.provider,
          description: 'LLM提供商'
        },
        model: {
          type: 'string',
          default: pluginLlmConfig.model,
          description: 'LLM模型'
        },
        apiKey: {
          type: 'string',
          description: 'LLM API密钥'
        }
      }
    },
    tts: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          default: pluginTtsConfig.provider,
          description: 'TTS提供商'
        },
        voice: {
          type: 'string',
          default: pluginTtsConfig.voice,
          description: 'TTS语音'
        }
      }
    },
    stt: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          default: pluginSttConfig.provider,
          description: 'STT提供商'
        },
        language: {
          type: 'string',
          default: pluginSttConfig.language,
          description: 'STT语言'
        }
      }
    }
  }
};

// 插件工厂函数
export function createPlugin(config, bus) {
  // 合并传入的配置和从文件读取的配置
  const mergedConfig = { ...getChannelInfo(), ...config };
  return new XiaozhiChannel(mergedConfig, bus);
}

// 默认导出（包含插件配置）
export default {
  metadata: pluginMetadata,
  configSchema: pluginConfigSchema,
  factory: createPlugin,
  // 保留原有的频道类导出
  Channel: XiaozhiChannel
};