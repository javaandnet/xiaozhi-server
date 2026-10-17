import { logger } from '../../utils/logger.js';
import BaseService from './base.js';
import { mockLlmReply } from '../utils/devMode.js';

/**
 * LLM服务（standalone 版：仅支持 bridge，不依赖 gala 主智能体）
 *
 * provider 取值：
 *   - 'openai'（默认）：直连 OpenAI 兼容端点（如 aibridge:3300，本地推理最快路径），
 *     apiKey 读 config.apiKey 或环境变量 AIBRIDGE_API_KEY（不入库）
 *   - 'dsh'：请求转发给 dsh-xiaozhi-bridge（DeepSeek Harness agent），
 *     失败时按 config.fallbackBaseUrl 回退 openai，仍不可用则返回降级回复
 * 配置项（config.json → llm）：
 *   { "provider": "openai", "baseUrl": "http://127.0.0.1:3300/v1", "model": "Qwen3.8-27B-ROCmFP4-FAST.gguf", "timeoutMs": 60000 }
 *   { "provider": "dsh", "baseUrl": "http://127.0.0.1:3320/v1", "model": "dsh-agent", "timeoutMs": 120000 }
 */
class LlmService extends BaseService {
  constructor(config = {}) {
    super('LLM', config);
    this.isInit = false;
    // provider 缺省即 openai（bridge 直连），彻底移除 gala 依赖
    this.config.provider = this.config.provider || 'openai';
    this.maxHistoryLength = 10; // 最大历史对话轮数
    this.conversationHistory = new Map(); // 存储每个连接的对话历史
  }

  get dshBaseUrl() {
    return this.config.baseUrl || (this.config.provider === 'openai' ? '' : 'http://127.0.0.1:3320/v1');
  }

  async _initialize() {
    if (this.config.provider === 'mock') {
      logger.info('LLM 服务以 mock 模式初始化（开发模式，不发任何外部请求）');
      this.isInit = true;
      return;
    }
    logger.info(`初始化LLM服务 (provider=${this.config.provider})`);
    if (this.config.provider === 'openai') {
      // 直连模式：探活 OpenAI 兼容端点，失败不阻断初始化
      const apiKey = this.config.apiKey || process.env.AIBRIDGE_API_KEY || '';
      if (!apiKey) {
        logger.warn('openai 直连模式未提供 apiKey（config.apiKey 或环境变量 AIBRIDGE_API_KEY），请求可能被拒绝');
      }
      try {
        await fetch(`${this.dshBaseUrl.replace(/\/$/, '')}/models`, {
          headers: { 'x-api-key': apiKey },
          signal: AbortSignal.timeout(5000),
        });
        logger.info(`OpenAI 兼容端点在线: ${this.dshBaseUrl}`);
      } catch (error) {
        logger.warn(`OpenAI 兼容端点不可达（${this.dshBaseUrl}）: ${error.message}`);
      }
      this.isInit = true;
      return;
    }
    if (this.config.provider === 'dsh') {
      // 探活桥接服务，失败不阻断初始化（每次调用仍会回退 gala）
      try {
        const resp = await fetch(`${this.dshBaseUrl.replace(/\/v1\/?$/, '')}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        const info = await resp.json();
        logger.info(`dsh 桥接服务在线: ${JSON.stringify(info)}`);
      } catch (error) {
        logger.warn(`dsh 桥接服务不可达（${this.dshBaseUrl}）: ${error.message}，调用时将按 fallbackBaseUrl 回退 openai 或降级`);
      }
      this.isInit = true;
      return;
    }
    this.isInit = true;
  }



  /**
   * 聊天接口 - 生成AI回复
   * @param {string} questId - 连接ID
   * @param {string} message - 用户消息
   * @returns {Promise<Object>} AI回复对象
   */
  async chat(questId, message) {
    try {
      if (this.config.provider === 'mock') {
        const reply = mockLlmReply(this.config.mock);
        this.addToHistory(questId, 'user', message);
        this.addToHistory(questId, 'assistant', reply);
        logger.info(`[devMode] LLM mock reply: ${reply.substring(0, 30)}`);
        return { text: reply, rawText: reply, sessionId: questId, provider: 'mock', model: 'mock' };
      }
      if (this.config.provider === 'openai') {
        return await this.chatViaOpenai(questId, message);
      }
      if (this.config.provider === 'dsh') {
        try {
          return await this.chatViaDsh(questId, message);
        } catch (error) {
          logger.error(`dsh 调用失败，尝试回退 openai: ${error.message}`);
          if (this.config.fallbackBaseUrl) {
            const bak = this.config.baseUrl;
            this.config.baseUrl = this.config.fallbackBaseUrl;
            try {
              return await this.chatViaOpenai(questId, message);
            } finally {
              this.config.baseUrl = bak;
            }
          }
          return this._degradedReply(questId, message, error);
        }
      }
      // 未知 provider（standalone 仅支持 openai / dsh）
      logger.error(`未知 LLM provider=${this.config.provider}（standalone 仅支持 openai / dsh）`);
      return this._degradedReply(questId, message, new Error(`unsupported provider: ${this.config.provider}`));
    } catch (error) {
      logger.error(`LLM调用失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 降级回复：无可用模型端点时返回友好提示，不再依赖 gala
   */
  _degradedReply(questId, message, error) {
    const text = '抱歉，我现在连不上语言模型服务，请稍后再试。';
    this.addToHistory(questId, 'user', message);
    this.addToHistory(questId, 'assistant', text);
    logger.error(`LLM 降级回复（${error && error.message ? error.message : 'unknown'}）`);
    return { text, rawText: text, sessionId: questId, provider: 'degraded', model: 'none' };
  }

  /**
   * 直连 OpenAI 兼容端点（aibridge 等本地推理服务）
   * 上下文由本服务维护（buildMessages：system + 最近 10 轮 + 新消息）
   */
  async chatViaOpenai(questId, message) {
    const apiKey = this.config.apiKey || process.env.AIBRIDGE_API_KEY || '';
    const url = `${this.dshBaseUrl.replace(/\/$/, '')}/chat/completions`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { 'x-api-key': apiKey, 'Authorization': `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.model || 'default',
        messages: this.buildMessages(questId, message),
        temperature: this.config.temperature ?? 0.7,
        max_tokens: this.config.maxTokens ?? 500,
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs || 60000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`openai ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = await resp.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || !reply.trim()) {
      throw new Error('openai 端点返回空回复');
    }

    this.addToHistory(questId, 'user', message);
    this.addToHistory(questId, 'assistant', reply);

    logger.info(`openai生成回复: ${message.substring(0, 20)}... -> ${reply.substring(0, 20)}...`);

    return {
      text: reply,
      rawText: reply,
      sessionId: questId,
      provider: 'openai',
      model: data?.model || this.config.model,
    };
  }

  /**
   * 经 dsh-xiaozhi-bridge 调用 DeepSeek Harness
   * 同一 questId 映射到同一条 dsh 会话（header x-dsh-session），上下文由 dsh 维护
   */
  async chatViaDsh(questId, message) {
    const url = `${this.dshBaseUrl.replace(/\/$/, '')}/chat/completions`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dsh-session': String(questId),
      },
      body: JSON.stringify({
        model: this.config.model || 'dsh-agent',
        messages: this.buildMessages(questId, message),
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs || 120000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`dsh bridge ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = await resp.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || !reply.trim()) {
      throw new Error('dsh bridge 返回空回复');
    }

    // 保存对话历史（与 gala 路径一致，供 buildMessages/历史记录展示）
    this.addToHistory(questId, 'user', message);
    this.addToHistory(questId, 'assistant', reply);

    logger.info(`dsh生成回复: ${message.substring(0, 20)}... -> ${reply.substring(0, 20)}...`);

    return {
      text: reply,
      rawText: reply,
      sessionId: data?.dsh?.session_id || questId,
      provider: 'dsh',
      model: data?.dsh?.model || this.config.model || 'dsh-agent',
    };
  }

  /**
   * 构建消息列表
   * @param {string} connectionId - 连接ID
   * @param {string} newMessage - 新消息
   * @returns {Array} 消息数组
   */
  buildMessages(connectionId, newMessage) {
    const messages = [];

    // 添加系统提示
    messages.push({
      role: 'system',
      content: '你是小智，一个友好、智能的AI助手。请用中文回复用户的问题，回答要简洁明了。'
    });

    // 添加历史对话
    const history = this.conversationHistory.get(connectionId) || [];
    messages.push(...history);

    // 添加新消息
    messages.push({
      role: 'user',
      content: newMessage
    });

    return messages;
  }


  /**
   * 添加到对话历史
   * @param {string} connectionId - 连接ID
   * @param {string} role - 角色(user/assistant)
   * @param {string} content - 内容
   */
  addToHistory(connectionId, role, content) {
    if (!this.conversationHistory.has(connectionId)) {
      this.conversationHistory.set(connectionId, []);
    }

    const history = this.conversationHistory.get(connectionId);
    history.push({ role, content });

    // 限制历史长度
    if (history.length > this.maxHistoryLength * 2) { // 每轮对话包含user和assistant两条消息
      history.splice(0, 2); // 移除最老的一轮对话
    }
  }

  /**
   * 清除对话历史
   * @param {string} connectionId - 连接ID
   */
  clearHistory(connectionId) {
    this.conversationHistory.delete(connectionId);
    logger.info(`清除连接 ${connectionId} 的对话历史`);
  }

  /**
   * 获取对话历史
   * @param {string} connectionId - 连接ID
   * @returns {Array} 对话历史
   */
  getHistory(connectionId) {
    return this.conversationHistory.get(connectionId) || [];
  }

  /**
   * 检查配置是否有效
   * @returns {boolean} 是否配置有效
   */
  isConfigured() {
    return !!this.apiKey;
  }

  async _healthCheck() {
    try {
      // 测试简单对话
      const testResponse = await this.chat('health_check', '你好');
      return {
        message: 'LLM服务运行正常',
        provider: 'gala',
        model: 'ollama:qwen2.5',
        configured: true,
        testResponse: testResponse.text.substring(0, 50) + '...'
      };
    } catch (error) {
      throw new Error(`LLM服务健康检查失败: ${error.message}`);
    }
  }

  /**
   * 获取统计信息
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      activeSessions: this.conversationHistory.size,
      totalMessages: Array.from(this.conversationHistory.values()).reduce((sum, history) => sum + history.length, 0),
      provider: 'gala',
      model: 'ollama:qwen2.5',
      configured: true
    };
  }

  /**
    * 处理category数据
    * @param {object} info - 包含category和相关信息的数据
    */
  handleCategoryData(info) {
    const { category } = info;
    let rtn = "无信息";
    if (category === "agent") {
      // 处理助手切换
      const agent = info.agent;
      if (agent && agent.name) {
        // 显示助手切换消息
        return `已切换到助手: ${agent.name}`;
      }
    } else if (category === "status") {
      // 处理状态信息
      const status = info.status;
      if (status) {
        // 显示状态消息
        return {
          text: `状态切换到: ${status}`,
          status: status
        }
      }
    }
    return rtn;
  }

  isConfigured(){
    return this.isInit;
  }
}

export default LlmService;
