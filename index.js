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
import { resolveMockFlags } from './core/utils/devMode.js';
import { resolveSharedToken } from './core/utils/sharedToken.js';
import { compileExternalSystems } from './core/utils/externalSystems.js';

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
import HomeKitService from './core/services/homekit.js';
import { registerApiRoutes } from './core/routes/index.js';

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
    // Canonical config file for interface hot-reload (same anchor as setupRoutes ctx).
    this.configPath = path.join(__dirname, 'config.json');
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
   * 热重载外界接口配置（sharedToken / externalSystems / voiceFlow）。
   * 由 Firmware Studio 「接口管理」页在写回 config.json 后调用：重新读取文件、
   * 就地解析 $shared 并编译注册表，再把影响接口的段合并回运行中的 this.config（
   * 原地改字段、不换对象引用，以免下游持引的模块看到旧 config）。
   * @returns {{systems:string[], employee:boolean, voiceFlowToken:boolean}}
   */
  reloadInterfaces() {
    const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    resolveSharedToken(raw);
    compileExternalSystems(raw, channelLogger);
    // Merge only the interface-affecting sections; leave all other runtime config untouched.
    this.config.sharedToken = raw.sharedToken;
    this.config.externalSystems = raw.externalSystems;
    this.config.voiceFlow = raw.voiceFlow;
    if (raw.employee !== undefined) this.config.employee = raw.employee;
    else delete this.config.employee;
    const summary = {
      systems: Object.keys(raw.externalSystems || {}),
      employee: !!(this.config.employee && this.config.employee.enabled),
      voiceFlowToken: !!this.config.voiceFlow?.token
    };
    channelLogger.info(`[interfaces] reloaded: systems=${summary.systems.join(',') || '(none)'}, employee=${summary.employee}, voiceFlow.token=${summary.voiceFlowToken ? 'set' : 'unset'}`);
    return summary;
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

      // Resolve "$shared" / "env:" token references from the top-level sharedToken
      // BEFORE services/handlers read config.employee & config.voiceFlow.
      resolveSharedToken(this.config);
      // Compile the externalSystems registry into the runtime employee/voiceFlow
      // views (same flat shape; registry is source, legacy sections override on conflict).
      compileExternalSystems(this.config);

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

      // 停止心跳保活
      if (this.webSocketHandler) {
        this.webSocketHandler.stopHeartbeat();
      }

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
      // 进程新起时尚无任何连接，复位上一进程残留的陈旧 online=1 标记（在线状态以实时连接为准）
      try {
        const n = this.store.markAllOffline();
        if (n) logger.info(`[Store] 复位陈旧在线标记: ${n} 台 → 离线`);
      } catch (e) { /* 忽略 */ }
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
      // Development mode: when mock is active for a segment, force that segment's
      // provider to 'mock' (and attach the devMode payload) BEFORE constructing the
      // service, so it takes the mock branch. this.config is the same reference the
      // WebSocket handler reads (config: this.config), so the handler sees the override.
      this.mockFlags = resolveMockFlags(this.config);
      this._applyMockProviders(this.mockFlags);

      const defaultLang = this.config.language?.default || 'zh';
      this.llmService = new LlmService({ ...(this.config.llm || getLlmConfig()), defaultLanguage: defaultLang, practice: this.config.practice || {}, timezoneOffset: this.config.server?.timezone_offset });
      this.ttsService = new TtsService({ ...(this.config.tts || getTtsConfig()), defaultLanguage: defaultLang });
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

      // HomeKit 控制器（方案A）：启动发现/配对并将灯具注入 MCP 工具池。不阻断启动。
      this.homekitService = new HomeKitService(this.config.homekit || {});
      try {
        await this.homekitService.start();
      } catch (e) {
        channelLogger.warn(`[xiaozhi] HomeKit startup skipped: ${e.message}`);
      }
      this.mcpService.setHomeKitService(this.homekitService);

      // standalone：无 gala 实例；总线为空实现
      this.gala = null;

    } catch (error) {
      console.error(`[${CHANNEL_ID}] Service initialization failed:`, error);
      throw error;
    }
  }


  /**
   * Force a segment to the 'mock' provider when dev-mode mock is active for it.
   * No-op for segments that stay real.
   */
  _applyMockProviders(flags) {
    if (!flags || !flags.master) {
      // master off: providers may already literally be 'mock' in config.json; nothing to rewrite
      return;
    }
    const mock = this.config.devMode || {};
    const map = { llm: flags.llm, tts: flags.tts, stt: flags.stt };
    for (const [seg, on] of Object.entries(map)) {
      if (on) {
        this.config[seg] = this.config[seg] || {};
        this.config[seg].provider = 'mock';
        this.config[seg].mock = mock;
      }
    }
    console.log(`[devMode] MOCK ACTIVE -> stt:${flags.stt} llm:${flags.llm} tts:${flags.tts} (no external ASR/LLM/TTS traffic)`);
  }

  /**
   * 获取服务配置（简化版，因为不再需要初始化本地服务）
   */
  getServiceConfig() {
    return {
      server: {
        ...(this.config.server || {}),
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
      config: this.config,
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
    // Keep-alive heartbeat: prevents firmware 120s incoming-timeout and NAT
    // idle-drop from silently reconnecting devices (loses rest-mode display).
    this.webSocketHandler.startHeartbeat();
  }

  /**
   * 设置Express服务器
   */
  setupExpressServer() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });

    // Unify local/cloud access paths: strip the /xiaozhi prefix for page and
    // management API requests so the same URLs work behind the cloud nginx
    // (which proxies /xiaozhi/* verbatim). Device protocol endpoints
    // (/xiaozhi/ota/, /xiaozhi/v1/) are registered natively and untouched.
    this.app.use((req, res, next) => {
      if (req.url === '/xiaozhi') {
        req.url = '/';
      } else if (
        req.url.startsWith('/xiaozhi/') &&
        !req.url.startsWith('/xiaozhi/ota') &&
        !req.url.startsWith('/xiaozhi/v1')
      ) {
        req.url = req.url.slice('/xiaozhi'.length);
      }
      next();
    });

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
        // devices = 在线连接数：deviceManager.devices 是 Map，Object.keys(Map) 恒为 []
        devices: this.deviceManager ? this.deviceManager.getOnlineDevices().length : 0,
        uptime: process.uptime()
      });
    });

    // Feature API routes live in core/routes/* (extracted from this closure).
    // ctx exposes live service references via getters (services are hot-replaced
    // after start), never snapshots. /health stays above; OTA + WS protocol below.
    const self = this;
    const ctx = {
      configPath: path.join(__dirname, 'config.json'),
      get config() { return self.config; },
      get deviceManager() { return self.deviceManager; },
      get sessionManager() { return self.sessionManager; },
      get webSocketHandler() { return self.webSocketHandler; },
      get mcpService() { return self.mcpService; },
      get homekitService() { return self.homekitService; },
      get otaHandler() { return self.otaHandler; },
      get llmService() { return self.llmService; },
      get ttsService() { return self.ttsService; },
      get store() { return self.store; },
      get host() { return self.host; },
      get port() { return self.port; },
      ensureStore: () => self.ensureStore()
    };
    registerApiRoutes(this.app, ctx);

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
      // devices/sessions 均为 Map，Object.keys(Map) 恒为 []，统一取在线/总数口径
      devices: this.deviceManager ? this.deviceManager.getOnlineDevices().length : 0,
      sessions: this.sessionManager ? (this.sessionManager.sessions?.size || 0) : 0
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