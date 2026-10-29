import os from 'os';
import BaseService from './base.js';
import { getConfig } from '../../config/loader.js';
import { noteToolResult as ikJogNoteToolResult } from './ikJog.js';

/**
 * MCP工具定义
 */
class ToolDefinition {
  constructor(name, description, toolType) {
    this.name = name;
    this.description = description;
    this.toolType = toolType;
  }
}

/**
 * 工具执行器基类
 */
class ToolExecutor {
  async execute(connection, toolName, args) {
    throw new Error('execute method must be implemented');
  }

  getTools() {
    return {};
  }

  hasTool(toolName) {
    return false;
  }
}

/**
 * 工具类型枚举
 */
const ToolType = {
  SERVER_PLUGIN: 'server_plugin',
  SERVER_MCP: 'server_mcp',
  DEVICE_IOT: 'device_iot',
  DEVICE_MCP: 'device_mcp',
  MCP_ENDPOINT: 'mcp_endpoint',
  HOMEKIT: 'homekit'
};

/**
 * 动作类型
 */
const Action = {
  NONE: 'NONE',
  RESPONSE: 'RESPONSE',
  REQLLM: 'REQLLM',
  ERROR: 'ERROR',
  NOTFOUND: 'NOTFOUND'
};

/**
 * 动作响应
 */
class ActionResponse {
  constructor(action, response = '', result = null, content = null) {
    this.action = action;
    this.response = response;
    this.result = result;
    this.content = content;
  }
}

/**
 * 设备端MCP客户端
 */
class DeviceMCPClient {
  constructor() {
    this.tools = new Map(); // sanitized_name -> tool_data
    this.nameMapping = new Map();
    this.ready = false;
    this.callResults = new Map(); // id -> Promise
    this.nextId = 1;
    this.lock = false;
  }

  hasTool(name) {
    return this.tools.has(name);
  }

  getAvailableTools() {
    const result = [];
    for (const [toolName, toolData] of this.tools) {
      const functionDef = {
        name: toolName,
        description: toolData.description,
        parameters: {
          type: toolData.inputSchema?.type || 'object',
          properties: toolData.inputSchema?.properties || {},
          required: toolData.inputSchema?.required || []
        }
      };
      result.push({ type: 'function', function: functionDef });
    }
    return result;
  }

  isReady() {
    return this.ready;
  }

  setReady(status) {
    this.ready = status;
  }

  async addTool(toolData) {
    const sanitizedName = this.sanitizeToolName(toolData.name);
    this.tools.set(sanitizedName, toolData);
    this.nameMapping.set(sanitizedName, toolData.name);
  }

  sanitizeToolName(name) {
    return name.replace(/[^a-zA-Z0-9_]/g, '_');
  }

  getNextId() {
    return this.nextId++;
  }

  registerCallResultFuture(id, promise) {
    this.callResults.set(id, promise);
  }

  resolveCallResult(id, result) {
    const promise = this.callResults.get(id);
    if (promise) {
      this.callResults.delete(id);
      promise.resolve(result);
    }
  }

  rejectCallResult(id, error) {
    const promise = this.callResults.get(id);
    if (promise) {
      this.callResults.delete(id);
      promise.reject(error);
    }
  }

  cleanupCallResult(id) {
    this.callResults.delete(id);
  }
}

/**
 * MCP服务类
 */
class McpService extends BaseService {
  constructor(config = {}) {
    super('MCP', config);
    this.deviceClients = new Map(); // clientId -> DeviceMCPClient
    this.executors = new Map();
    this.toolCache = null;
    this.functionDescriptionsCache = null;

    // 注册执行器
    this.registerExecutor(ToolType.DEVICE_MCP, new DeviceMCPExecutor(this));
    this.registerExecutor(ToolType.MCP_ENDPOINT, new MCPEndpointExecutor(this));

    console.log('✅ MCP服务构造完成');
  }

  async _initialize() {
    console.log('✅ MCP服务初始化完成');
  }

  async _healthCheck() {
    return {
      message: 'MCP服务运行正常',
      deviceClients: this.deviceClients.size,
      executors: this.executors.size
    };
  }

  /**
   * 注册工具执行器
   */
  registerExecutor(toolType, executor) {
    this.executors.set(toolType, executor);
    this.invalidateCache();
    console.log(`✅ 注册工具执行器: ${toolType}`);
  }

  /**
   * 接入 HomeKit 控制器服务（方案A）：注册执行器并把已发现的灯具注入工具池。
   * 由启动流程在 HomeKitService.start() 之后调用；灯具变化后可再次调用刷新。
   */
  setHomeKitService(homekitService) {
    if (!homekitService) return;
    this.registerExecutor(ToolType.HOMEKIT, new HomeKitExecutor(homekitService));
    this.refreshTools();
  }

  /**
   * 注入 peer link（家云实例互联）。branch 侧据此读取由 long-poll 回灌的
   * 云端 provider 工具快照，实现「语音/控制台在本实例、身体注册在云端」的跨实例调用。
   */
  setPeerLink(peerLink) {
    this.peerLink = peerLink;
  }

  /** 云端回灌的机器人 provider 快照（branch 侧）；无则空数组 */
  _remoteProviders() {
    return (this.peerLink && typeof this.peerLink.getRemoteProviders === 'function')
      ? (this.peerLink.getRemoteProviders() || [])
      : [];
  }

  /** 按稳定标识（deviceId/mac/clientId，大小写不敏感）在远端快照里定位身体条目 */
  _remoteProviderEntry(key) {
    if (!key) return null;
    const k = String(key).toLowerCase();
    return this._remoteProviders().find((p) =>
      [p.deviceId, p.mac, p.clientId].some((v) => v && String(v).toLowerCase() === k)) || null;
  }

  /** 本实例是否存在该 provider 的活连接（ready）——本地优先/跨实例路由判断 */
  hasLocalProvider(key) {
    const mc = this._findDeviceClient(key);
    return !!(mc && mc.isReady());
  }

  /** 该 provider 是否可达：本实例 ready 或云端快照在线（跨实例） */
  hasProviderAnywhere(key) {
    return this.hasLocalProvider(key) || !!this._remoteProviderEntry(key);
  }

  /**
   * 使缓存失效
   */
  invalidateCache() {
    this.toolCache = null;
    this.functionDescriptionsCache = null;
  }

  /**
   * 机器人硬件（device-MCP 工具提供方）在线状态：供管理平台展示“硬件是否在线 / 可用工具数”。
   * ready 且工具就绪的 provider 代表中能真正接指令的身体；totalTools 为当前可注入 function 池大小。
   * 仅 device_type 为 robot/peripheral/mcp_only 的才是“机器人身体”；小智语音设备自带的 device-MCP 工具
   * 不属身体（robot=false），供管理平台按身体列表过滤展示。
   */
  getDeviceProviderStatus() {
    const providers = [];
    for (const [clientId, mc] of this.deviceClients) {
      const deviceType = (mc.connection && mc.connection.deviceType) || null;
      const isRobot = ['robot', 'peripheral', 'mcp_only'].includes(String(deviceType || '').toLowerCase());
      providers.push({
        clientId,
        deviceId: (mc.connection && mc.connection.deviceId) || null,
        mac: (mc.connection && mc.connection.deviceMac) || null,
        name: (mc.serverInfo && mc.serverInfo.name)
          || (mc.connection && mc.connection.deviceName)
          || (mc.connection && mc.connection.deviceId)
          || '未知设备',
        version: (mc.serverInfo && mc.serverInfo.version) || '',
        ready: mc.isReady(),
        toolCount: mc.tools.size,
        deviceType,
        robot: isRobot
      });
    }
    // 按稳定标识归一（mac 优先，其次 deviceId，再 clientId），同标识只保留最新一条：
    // 断线重连会在 deviceClients 留下僵尸旧条目，Map 插入顺序即时间序，后写覆盖=取最新活连接。
    const byKey = new Map();
    for (const p of providers) {
      const key = (p.mac && String(p.mac).toLowerCase())
        || (p.deviceId && String(p.deviceId).toLowerCase())
        || String(p.clientId).toLowerCase();
      byKey.set(key, p);
    }
    const deduped = Array.from(byKey.values());
    const bodies = deduped.filter((p) => p.robot);
    return {
      providers: deduped,
      readyProviders: deduped.filter((p) => p.ready).length,
      totalTools: this.getFunctionDescriptions().length,
      robotReadyProviders: bodies.filter((p) => p.ready).length,
      robotTotalTools: bodies.reduce((n, p) => n + (p.ready ? p.toolCount : 0), 0)
    };
  }

  /**
   * 获取所有工具定义
   */
  getAllTools() {
    if (this.toolCache) {
      return this.toolCache;
    }

    const allTools = new Map();
    for (const [toolType, executor] of this.executors) {
      try {
        const tools = executor.getTools();
        for (const [name, definition] of Object.entries(tools)) {
          if (allTools.has(name)) {
            console.warn(`⚠️ 工具名称冲突: ${name}`);
          }
          allTools.set(name, definition);
        }
      } catch (error) {
        console.error(`❌ 获取${toolType}工具时出错:`, error);
      }
    }

    this.toolCache = Object.fromEntries(allTools);
    return this.toolCache;
  }

  getFunctionDescriptionsForProvider(providerKey) {
    // 本地优先：本实例有该 provider 的活连接则用本地工具；否则回退到云端回灌的
    // 远端快照（branch 侧身体注册在云端时，语音/工具目录仍可注入 LLM）。
    const mc = this._findDeviceClient(providerKey);
    if (mc && mc.isReady()) return mc.getAvailableTools();
    const remote = this._remoteProviderEntry(providerKey);
    return remote && Array.isArray(remote.tools) ? remote.tools : [];
  }

  /** 按工具类型取函数描述（OpenAI 格式），如 homekit 家居工具独立于机器人身体注入 */
  getFunctionDescriptionsForType(toolType) {
    const tools = this.getAllTools();
    return Object.values(tools)
      .filter((t) => t && t.toolType === toolType)
      .map((t) => t.description);
  }

  /** 按稳定标识（hello device_id / mac / clientId，大小写不敏感）定位某个工具提供方连接 */
  _findDeviceClient(key) {
    if (!key) return null;
    const k = String(key).toLowerCase();
    let found = null;
    for (const [clientId, mc] of this.deviceClients) {
      const devId = String((mc.connection && mc.connection.deviceId) || '').toLowerCase();
      const mac = String((mc.connection && mc.connection.deviceMac) || '').toLowerCase();
      // 取最新匹配：同一设备的断线重连会留下旧条目，僵尸先注册，必须总拿最后一条活连接
      if (String(clientId).toLowerCase() === k || (devId && devId === k) || (mac && mac === k)) found = mc;
    }
    return found;
  }

  /**
   * 获取所有工具的函数描述（OpenAI格式）
   */
  getFunctionDescriptions() {
    if (this.functionDescriptionsCache) {
      return this.functionDescriptionsCache;
    }

    const descriptions = [];
    const tools = this.getAllTools();
    for (const toolDefinition of Object.values(tools)) {
      descriptions.push(toolDefinition.description);
    }

    this.functionDescriptionsCache = descriptions;
    return descriptions;
  }

  /**
   * 检查是否存在指定工具
   */
  hasTool(toolName) {
    const tools = this.getAllTools();
    return toolName in tools;
  }

  /**
   * 获取工具类型
   */
  getToolType(toolName) {
    const tools = this.getAllTools();
    const toolDef = tools[toolName];
    return toolDef ? toolDef.toolType : null;
  }

  /**
   * 执行工具调用
   */
  async executeTool(connection, toolName, args) {
    try {
      // 查找工具类型
      const toolType = this.getToolType(toolName);
      if (!toolType) {
        return new ActionResponse(
          Action.NOTFOUND,
          `工具 ${toolName} 不存在`
        );
      }

      // 获取对应的执行器
      const executor = this.executors.get(toolType);
      if (!executor) {
        return new ActionResponse(
          Action.ERROR,
          `工具类型 ${toolType} 的执行器未注册`
        );
      }

      // 执行工具
      console.log(`🔧 执行工具: ${toolName}，参数:`, arguments);
      const result = await executor.execute(connection, toolName, args);
      console.log(`✅ 工具执行结果:`, result);
      return result;

    } catch (error) {
      console.error(`❌ 执行工具 ${toolName} 时出错:`, error);
      return new ActionResponse(Action.ERROR, error.message);
    }
  }

  /**
   * 获取所有支持的工具名称
   */
  getSupportedToolNames() {
    const tools = this.getAllTools();
    return Object.keys(tools);
  }

  /**
   * 刷新工具缓存
   */
  refreshTools() {
    this.invalidateCache();
    console.log('🔄 工具缓存已刷新');
  }

  /**
   * 获取工具统计信息
   */
  getToolStatistics() {
    const stats = {};
    for (const [toolType, executor] of this.executors) {
      try {
        const tools = executor.getTools();
        stats[toolType] = Object.keys(tools).length;
      } catch (error) {
        console.error(`❌ 获取${toolType}工具统计时出错:`, error);
        stats[toolType] = 0;
      }
    }
    return stats;
  }

  /**
   * 处理MCP消息
   */
  async handleMcpMessage(connection, rtn) {
    let payload = rtn.payload;
    if (!payload || typeof payload !== 'object') {
      console.error('❌ MCP消息格式错误');
      return;
    }

    const clientId = connection.clientId;

    // 确保设备有MCP客户端
    if (!this.deviceClients.has(clientId)) {
      this.deviceClients.set(clientId, new DeviceMCPClient());
    }

    const mcpClient = this.deviceClients.get(clientId);
    // 保存设备当前活连接，供跨设备工具路由（见 callDeviceMcpTool）使用
    mcpClient.connection = connection;

    // 处理结果
    if ('result' in payload) {
      const result = payload.result;
      const msgId = parseInt(payload.id || 0);

      // 检查工具调用响应
      if (mcpClient.callResults.has(msgId)) {
        console.log(`✅ 收到工具调用响应，ID: ${msgId}`);
        mcpClient.resolveCallResult(msgId, result);
        return;
      }

      if (msgId === 1) { // 初始化响应
        console.log('✅ 收到MCP初始化响应');
        const serverInfo = result?.serverInfo;
        if (serverInfo && typeof serverInfo === 'object') {
          mcpClient.serverInfo = serverInfo;
          console.log(`🖥️ 客户端MCP服务器信息: name=${serverInfo.name}, version=${serverInfo.version}`);
        }

        // 请求工具列表
        setTimeout(() => {
          this.sendMcpToolsListRequest(connection);
        }, 1000);

      } else if (msgId === 2) { // 工具列表响应
        // console.log('✅ 收到MCP工具列表响应');
        if (result && typeof result === 'object' && Array.isArray(result.tools)) {
          const toolsData = result.tools;
          // console.log(`📊 客户端设备支持的工具数量: ${toolsData.length}`);

          for (let i = 0; i < toolsData.length; i++) {
            const tool = toolsData[i];
            if (typeof tool === 'object') {
              const name = tool.name || '';
              const description = tool.description || '';
              const inputSchema = {
                type: 'object',
                properties: tool.inputSchema?.properties || {},
                required: Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : []
              };

              const newTool = {
                name: name,
                description: description,
                inputSchema: inputSchema
              };

              await mcpClient.addTool(newTool);
              console.log(`🔧 客户端工具 #${i + 1}: ${name}`);
            }
          }

          const nextCursor = result.nextCursor;
          if (nextCursor) {
            console.log(`⏭️ 有更多工具，nextCursor: ${nextCursor}`);
            this.sendMcpToolsListContinueRequest(connection, nextCursor);
          } else {
            mcpClient.setReady(true);
            console.log('✅ 所有工具已获取，MCP客户端准备就绪');

            // 刷新工具缓存
            this.refreshTools();
            console.log('📋 当前支持的工具:', this.getSupportedToolNames());
          }
        }
      }
      else if (msgId === 3) { // 工具列表响应
        // console.log('✅ 收到MCP工具列表响应');
        if (result && typeof result === 'object' && Array.isArray(result.content)) {
          const contentsData = result.content;
          // console.log(`📊 客户端设备支持的工具数量: ${toolsData.length}`);

          for (let i = 0; i < contentsData.length; i++) {
            const content = contentsData[i];
            if (typeof content === 'object') {
              console.log(`🔧 客户端工具 #${i + 1}: ${JSON.stringify(content)}`);
            }
          }

        }
      }
    } else if ('method' in payload) {
      const method = payload.method;
      console.log(`📥 收到MCP客户端请求: ${method}`);

    } else if ('error' in payload) {
      const errorData = payload.error;
      const errorMsg = errorData?.message || '未知错误';
      console.error(`❌ 收到MCP错误响应: ${errorMsg}`);

      const msgId = parseInt(payload.id || 0);
      if (mcpClient.callResults.has(msgId)) {
        mcpClient.rejectCallResult(msgId, new Error(`MCP错误: ${errorMsg}`));
      }
    }
  }

  /**
   * 发送MCP消息
   */
  sendMcpMessage(connection, payload) {
    if (!connection.features?.mcp) {
      console.warn('⚠️ 客户端不支持MCP，无法发送MCP消息');
      return;
    }

    const message = JSON.stringify({
      type: 'mcp',
      payload: payload
    });

    try {
      connection.send(message);
      console.log('📤 成功发送MCP消息:', message.substring(0, 100) + '...');
    } catch (error) {
      console.error('❌ 发送MCP消息失败:', error);
    }
  }

  /**
   * 发送MCP初始化消息
   */
  sendMcpInitializeMessage(connection) {
    // Vision capability: firmware McpServer::ParseCapabilities reads
    // capabilities.vision.url/token and feeds Camera::SetExplainUrl, which is
    // the only way self.camera.take_photo can upload the captured JPEG.
    // URL must be LAN-reachable for the device (same addressing as the OTA
    // websocket url); endpoint lives at core/routes/visionRoutes.js.
    const cfg = getConfig() || {};
    const port = cfg.port || 8003;
    let localIp = '127.0.0.1';
    const interfaces = os.networkInterfaces();
    outer: for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) { localIp = iface.address; break outer; }
      }
    }
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {
          roots: { listChanged: true },
          sampling: {},
          vision: {
            url: `http://${localIp}:${port}/xiaozhi/vision/explain`,
            ...(cfg.sharedToken ? { token: cfg.sharedToken } : {})
          }
        },
        clientInfo: {
          name: 'XiaozhiClient',
          version: '1.0.0'
        }
      }
    };

    console.log('📤 发送MCP初始化消息');
    this.sendMcpMessage(connection, payload);
  }

  /**
   * 发送MCP工具列表请求
   */
  sendMcpToolsListRequest(connection) {
    const payload = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: { cursor: "" }  // ✅ 添加必需的params字段
    };

    console.log('📤 发送MCP工具列表请求');
    this.sendMcpMessage(connection, payload);
  }

  /**
   * 发送带有cursor的MCP工具列表请求
   */
  sendMcpToolsListContinueRequest(connection, cursor) {
    const payload = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: { cursor: cursor }
    };

    console.log(`📤 发送带cursor的MCP工具列表请求: ${cursor}`);
    this.sendMcpMessage(connection, payload);
  }

  /**
   * 调用设备端MCP工具
   */
  async callDeviceMcpTool(connection, toolName, args = {}, timeout = 30, boundProviderKey = null) {
    // 跨实例反向调用（改动三）：本实例为 branch 且绑定身体不在本实例（注册在云端），
    // 但存在于云端回灌的 provider 快照时，反向 callHub 调云端 /api/mcp/call 并回传结果。
    // hub 非 branch 不会再转发，无成环；沿用纯 JSON stub 连接（对硬件直连不走 TTS）。
    if (boundProviderKey && this.peerLink && this.peerLink.isBranch
        && !this.hasLocalProvider(boundProviderKey) && this.hasProviderAnywhere(boundProviderKey)) {
      const r = await this.peerLink.callHub('POST', '/api/mcp/call',
        { device: boundProviderKey, tool: toolName, args: args || {} }, (timeout + 5) * 1000);
      if (!r.error) {
        const b = r.body || {};
        if (b.ok) return b.result == null ? null : String(b.result);
        throw new Error(b.error || `云端身体调用失败: ${toolName}`);
      }
      console.warn(`[MCP] branch reverse call to hub failed (${toolName}): ${r.error}`);
      throw new Error(`云端身体反向调用失败: ${r.error}`);
    }
    // 路由到“真正拥有该工具的设备”：优先当前会话设备，否则在所有在线设备中按 hasTool 查找。
    // 这样跨设备（如 ESP32 会话调用 MasterPi 的 robot.* 工具）才能正确下发。
    let mcpClient;
    let targetConnection = connection;
    if (boundProviderKey) {
      // 一一对应绑定：只路由到绑定的身体，绝不回退全局，避免多台机器人时指挥错乱
      mcpClient = this._findDeviceClient(boundProviderKey);
      if (!mcpClient || !mcpClient.isReady()) {
        throw new Error(`绑定的机器人硬件离线或未就绪: ${boundProviderKey}`);
      }
      if (!mcpClient.hasTool(toolName)) {
        throw new Error(`绑定的机器人硬件(${boundProviderKey})不支持工具 ${toolName}`);
      }
      targetConnection = mcpClient.connection || connection;
      console.log(`🔒 按绑定路由工具 ${toolName} → ${boundProviderKey}`);
    } else {
      mcpClient = this.deviceClients.get(connection.clientId);
      if (!mcpClient || !mcpClient.isReady() || !mcpClient.hasTool(toolName)) {
        let found = null;
        for (const [, mc] of this.deviceClients) {
          if (mc.isReady() && mc.hasTool(toolName)) {
            found = mc;
            break;
          }
        }
        if (found) {
          mcpClient = found;
          targetConnection = found.connection || connection;
          console.log(`🔀 跨设备路由工具 ${toolName} 到归属设备连接`);
        }
      }
    }

    if (!mcpClient) {
      throw new Error('设备端MCP客户端未初始化');
    }

    if (!mcpClient.isReady()) {
      throw new Error('设备端MCP客户端未准备就绪');
    }

    if (!mcpClient.hasTool(toolName)) {
      throw new Error(`工具 ${toolName} 不存在`);
    }

    const toolCallId = mcpClient.getNextId();

    // 创建Promise用于等待响应
    const promise = new Promise((resolve, reject) => {
      mcpClient.registerCallResultFuture(toolCallId, { resolve, reject });
    });

    // 处理参数
    let toolArgs = args;
    if (typeof args === 'string') {
      try {
        toolArgs = args.trim() ? JSON.parse(args) : {};
      } catch (error) {
        throw new Error(`参数JSON解析失败: ${error.message}`);
      }
    }

    const actualName = mcpClient.nameMapping.get(toolName) || toolName;
    const payload = {
      jsonrpc: '2.0',
      id: toolCallId,
      method: 'tools/call',
      params: {
        name: actualName,
        arguments: toolArgs
      }
    };

    console.log(`📤 发送客户端MCP工具调用请求: ${actualName}，参数:`, toolArgs);
    this.sendMcpMessage(targetConnection, payload);

    try {
      // 等待响应或超时
      const rawResult = await Promise.race([
        promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('工具调用请求超时')), timeout * 1000)
        )
      ]);

      console.log(`✅ 客户端MCP工具调用 ${actualName} 成功，原始结果:`, rawResult);

      if (typeof rawResult === 'object' && rawResult !== null) {
        if (rawResult.isError === true) {
          const errorMsg = rawResult.error || '工具调用返回错误，但未提供具体错误信息';
          throw new Error(`工具调用错误: ${errorMsg}`);
        }

        const content = rawResult.content;
        let resultText = null;
        if (Array.isArray(content) && content.length > 0) {
          if (typeof content[0] === 'object' && 'text' in content[0]) {
            resultText = content[0].text;
          }
        }
        if (resultText !== null) {
          // IK 微调基准统一：机械臂相关工具真实执行后推进/作废基准（仅按绑定身体归因）
          ikJogNoteToolResult(toolName, toolArgs, resultText, boundProviderKey);
          return resultText;
        }
      }

      // 如果结果不是预期的格式，将其转换为字符串
      const fallbackText = String(rawResult);
      ikJogNoteToolResult(toolName, toolArgs, fallbackText, boundProviderKey);
      return fallbackText;

    } catch (error) {
      mcpClient.cleanupCallResult(toolCallId);
      // 超时未响应：连接大概率是僵尸（对端进程已死但未触发 close），清理该条目，
      // 避免后续路由反复命中死连接；设备真还活着会自行重连重新注册
      if (/工具调用请求超时/.test(error.message)) {
        const cid = (mcpClient.connection && mcpClient.connection.clientId) || null;
        if (cid) {
          console.warn(`⚠️ 工具调用超时，判定连接为僵尸并清理: ${cid}`);
          const conn = mcpClient.connection;
          this.handleDeviceDisconnect(cid);
          // 必须同时关掉底层 socket：设备侧 ws 无 ping 超时，只删服务端条目
          // 对端无感知，会拿着半开连接永等不到重连，身体长期离线
          try { conn.close(1011, 'mcp call timeout, zombie connection'); } catch { /* already closed */ }
        }
      }
      throw error;
    }
  }

  /**
   * 处理设备断开连接
   * @param {string} clientId
   * @param {object} [connection] 正在关闭的连接。设备重连时 clientId 不变，
   *   旧连接的 close 事件可能晚于新连接的 MCP 注册到达，无主删除会把刚建好的
   *   客户端连带清掉（表现为工具全部消失、拍照等调用报“硬件离线”）。传入连接
   *   时做归属校验，仅当登记的仍是这条连接才清理；不传（僵尸连接判定路径）则
   *   无条件清理。
   */
  handleDeviceDisconnect(clientId, connection = null) {
    if (this.deviceClients.has(clientId)) {
      const mc = this.deviceClients.get(clientId);
      if (connection && mc && mc.connection && mc.connection !== connection) {
        console.log(`🛡️ 跳过 MCP 客户端清理（clientId ${clientId} 已被新连接接管）`);
        return;
      }
      this.deviceClients.delete(clientId);
      this.refreshTools();
      console.log(`🔌 设备 ${clientId} 断开连接，清理MCP客户端`);
    }
  }
}

/**
 * 设备端MCP工具执行器
 */
class DeviceMCPExecutor extends ToolExecutor {
  constructor(mcpService) {
    super();
    this.mcpService = mcpService;
  }

  async execute(connection, toolName, args) {
    try {
      // 调用设备端MCP工具
      const result = await this.mcpService.callDeviceMcpTool(connection, toolName, args);

      // 尝试解析JSON结果
      let resultJson = null;
      if (typeof result === 'string') {
        try {
          resultJson = JSON.parse(result);
        } catch (e) {
          // 解析失败，继续使用字符串结果
        }
      }

      // 视觉大模型不经过二次LLM处理
      if (resultJson && typeof resultJson === 'object' && 'action' in resultJson) {
        return new ActionResponse(
          Action[resultJson.action],
          resultJson.response || ''
        );
      }

      return new ActionResponse(Action.REQLLM, null, String(result));

    } catch (error) {
      if (error.message.includes('不存在')) {
        return new ActionResponse(Action.NOTFOUND, error.message);
      }
      return new ActionResponse(Action.ERROR, error.message);
    }
  }

  getTools() {
    const tools = {};

    // 收集所有设备的MCP工具
    for (const [clientId, mcpClient] of this.mcpService.deviceClients) {
      if (mcpClient.isReady()) {
        const mcpTools = mcpClient.getAvailableTools();
        for (const tool of mcpTools) {
          const funcDef = tool.function;
          const toolName = funcDef.name;

          if (toolName) {
            tools[toolName] = new ToolDefinition(
              toolName,
              tool,
              ToolType.DEVICE_MCP
            );
          }
        }
      }
    }

    return tools;
  }

  hasTool(toolName) {
    // 检查所有设备的MCP客户端
    for (const mcpClient of this.mcpService.deviceClients.values()) {
      if (mcpClient.hasTool(toolName)) {
        return true;
      }
    }
    return false;
  }
}

/**
 * HomeKit 灯具控制执行器（方案A：纯 Node HomeKit 控制器）
 * 把 HomeKitService 发现的每台灯暴露为一个 function 工具，LLM 直接选工具+参数。
 */
class HomeKitExecutor extends ToolExecutor {
  constructor(homekitService) {
    super();
    this.homekitService = homekitService;
    // toolName -> { key, accessoryId }：灯具键只在配件内唯一，同名冲突时工具名加配件后缀，
    // 执行时按本映射回推目标灯，避免跨配件误控。
    this.toolTargets = new Map();
  }

  getTools() {
    const tools = {};
    this.toolTargets = new Map();
    if (!this.homekitService || !this.homekitService.enabled) return tools;
    for (const light of this.homekitService.getLights()) {
      let toolName = this.homekitService.toolNameForLight(light.key);
      if (tools[toolName]) {
        // 跨配件键冲突：用配件标识（MAC 去分隔符）生成唯一工具名
        const token = String(light.accessoryId || '').toLowerCase().replace(/[^0-9a-z]/g, '').slice(-8);
        toolName = `${this.homekitService.toolNameForLight(light.key)}_${token}`;
        console.warn(`[HomeKit] duplicate light key ${light.key}, tool renamed to ${toolName}`);
        if (tools[toolName]) continue;
      }
      this.toolTargets.set(toolName, { key: light.key, accessoryId: light.accessoryId });
      const properties = {
        power: { type: 'boolean', description: '开(true)/关(false)灯' },
        brightness: { type: 'integer', minimum: 0, maximum: 100, description: '亮度百分比 0-100' }
      };
      if (light.hasColorTemp !== false && light.colorTempIid != null) {
        properties.color_temp = { type: 'integer', minimum: 0, maximum: 100, description: '色温暖度百分比 0-100，0=最冷白，100=最暖' };
      }
      const funcDef = {
        type: 'function',
        function: {
          name: toolName,
          description: `控制${light.name}（HomeKit 智能灯）：开关、亮度${light.colorTempIid != null ? '、色温' : ''}。任何开/关/调亮度的请求都必须调用本工具（它会读取并操作设备真实状态并回传）；严禁凭对话历史口头臆断灯的开关状态而不调工具。`,
          parameters: { type: 'object', properties, required: [] }
        }
      };
      tools[toolName] = new ToolDefinition(toolName, funcDef, ToolType.HOMEKIT);
    }
    return tools;
  }

  hasTool(toolName) {
    return this.toolTargets.has(toolName) || (this.homekitService.lightKeyFromTool(toolName) != null && this.homekitService.getLights().length > 0);
  }

  async execute(connection, toolName, args) {
    try {
      const target = this.toolTargets.get(toolName) || { key: this.homekitService.lightKeyFromTool(toolName), accessoryId: null };
      const text = await this.homekitService.applyControl(target.key, args, target.accessoryId);
      return new ActionResponse(Action.REQLLM, null, text);
    } catch (error) {
      return new ActionResponse(Action.ERROR, error.message);
    }
  }
}

/**
 * MCP接入点执行器（简化版）
 */
class MCPEndpointExecutor extends ToolExecutor {
  constructor(mcpService) {
    super();
    this.mcpService = mcpService;
  }

  async execute(connection, toolName, args) {
    // TODO: 实现MCP接入点工具调用
    return new ActionResponse(
      Action.ERROR,
      'MCP接入点功能暂未实现'
    );
  }

  getTools() {
    // TODO: 实现MCP接入点工具获取
    return {};
  }

  hasTool(toolName) {
    return false;
  }
}

export default McpService;
export {
  Action,
  ActionResponse,
  DeviceMCPClient,
  DeviceMCPExecutor,
  HomeKitExecutor,
  MCPEndpointExecutor, ToolDefinition,
  ToolExecutor,
  ToolType
};
