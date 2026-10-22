import { logger } from '../../utils/logger.js';
import BaseService from './base.js';
import { mockLlmReply } from '../utils/devMode.js';

// 口语练习总结轮默认 system prompt（config.practice.summaryPrompt 可覆盖）
const DEFAULT_PRACTICE_SUMMARY_PROMPT = '你是一名口语教练。用户刚完成一段口语讲述练习（如自我介绍或面试回答）。请对以下完整讲述内容依次给出：1) 内容要点总结；2) 表达、语法与用词的纠正和改进建议；3) 面试视角的整体评价与提升方向。用与用户讲述内容相同的语言回复。';

// 口语说完判定器默认 prompt（config.practice.classifierPrompt 可覆盖，{{text}} 为占位符）
const DEFAULT_PRACTICE_CLASSIFIER_PROMPT = '以下是用户口语练习中已经讲述的内容。请判断用户是否已明确表达本次讲述结束（例如说了“我说完了”“以上就是我的自我介绍”之类，或语义上已完整收尾）。只回答 CONTINUE 或 DONE，不要输出任何其他文字。\n\n已讲述内容：{{text}}';

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
    // 回复语言托底（config.json → language.default，经构造注入或设置端点热更）
    this.defaultLanguage = config.defaultLanguage || 'zh';
    this.maxHistoryLength = 10; // 最大历史对话轮数
    this.conversationHistory = new Map(); // 存储每个连接的对话历史
    // 时区偏移（小时），与 OTA server_time 同源口径：config.server.timezone_offset 覆盖，默认取本机时区
    this.timezoneOffset = Number.isFinite(config.timezoneOffset) ? config.timezoneOffset : null;
  }

  /**
   * 当前日期时间（按服务器时区），注入 system prompt 供模型回答日期/时间类问题
   */
  getCurrentDateTime() {
    const tz = Number.isFinite(this.timezoneOffset)
      ? this.timezoneOffset
      : -(new Date().getTimezoneOffset() / 60);
    const now = new Date(Date.now() + tz * 3600 * 1000); // 转到目标时区的墙上时间，用 UTC getter 读取
    const pad = (n) => String(n).padStart(2, '0');
    const weeks = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${weeks[now.getUTCDay()]} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}（UTC${tz >= 0 ? '+' : ''}${tz}，服务器本地时间）`;
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
  async chat(questId, message, options = {}) {
    try {
      if (this.config.provider === 'mock') {
        const reply = mockLlmReply(this.config.mock);
        this.addToHistory(questId, 'user', message);
        this.addToHistory(questId, 'assistant', reply);
        logger.info(`[devMode] LLM mock reply: ${reply.substring(0, 30)}`);
        return { text: reply, rawText: reply, sessionId: questId, provider: 'mock', model: 'mock' };
      }
      if (this.config.provider === 'openai') {
        return await this.chatViaOpenai(questId, message, options);
      }
      if (this.config.provider === 'dsh') {
        try {
          return await this.chatViaDsh(questId, message, options);
        } catch (error) {
          logger.error(`dsh 调用失败，尝试回退 openai: ${error.message}`);
          if (this.config.fallbackBaseUrl) {
            const bak = this.config.baseUrl;
            this.config.baseUrl = this.config.fallbackBaseUrl;
            try {
              return await this.chatViaOpenai(questId, message, options);
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
   * 口语练习“说完”判定（仅 endMode=auto 时每片段调用一次）：
   * 独立小 prompt、不进 conversationHistory；失败/不可解析一律 CONTINUE
   * （宁可少答不可错断，用户可随时按键兜底收卷）
   * @param {string} partialText - 目前已聚合的讲述全文
   * @returns {Promise<'CONTINUE'|'DONE'>}
   */
  async classifyPracticeDone(partialText) {
    if (this.config.provider === 'mock') {
      logger.info('[devMode] practice classifier: mock provider -> CONTINUE');
      return 'CONTINUE';
    }
    try {
      const tpl = this.config.practice?.classifierPrompt || DEFAULT_PRACTICE_CLASSIFIER_PROMPT;
      const prompt = tpl.replace('{{text}}', String(partialText || ''));
      const apiKey = this.config.apiKey || process.env.AIBRIDGE_API_KEY || '';
      // openai/dsh 端点均接受 OpenAI 格式 messages；dsh 会话隔离：判定器用独立 session，不污染主对话上下文
      const body = {
        model: this.config.model || 'default',
        messages: [{ role: 'user', content: prompt }],
      };
      if (this.config.provider !== 'dsh') {
        body.temperature = 0;
        body.max_tokens = 4;
      }
      const resp = await fetch(`${this.dshBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.provider === 'dsh' ? { 'x-dsh-session': `practice-classify-${Date.now()}` } : {}),
          ...(apiKey ? { 'x-api-key': apiKey, 'Authorization': `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.practice?.classifyTimeoutMs || 5000),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`practice-classifier ${resp.status}: ${text.slice(0, 120)}`);
      }
      const data = await resp.json();
      const out = String(data?.choices?.[0]?.message?.content || '').toUpperCase();
      const verdict = /\bDONE\b/.test(out) && !/\bCONTINUE\b/.test(out) ? 'DONE' : 'CONTINUE';
      logger.info(`口语说完判定: ${verdict} (raw="${out.trim().slice(0, 20)}")`);
      return verdict;
    } catch (error) {
      logger.warn(`口语说完判定失败，按 CONTINUE 处理: ${error.message}`);
      return 'CONTINUE';
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
  async chatViaOpenai(questId, message, options = {}) {
    const apiKey = this.config.apiKey || process.env.AIBRIDGE_API_KEY || '';
    const url = `${this.dshBaseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers = {
      'content-type': 'application/json',
      ...(apiKey ? { 'x-api-key': apiKey, 'Authorization': `Bearer ${apiKey}` } : {}),
    };

    const tools = (Array.isArray(options.tools) && options.tools.length) ? options.tools : null;
    const executeToolCall = (typeof options.executeToolCall === 'function') ? options.executeToolCall : null;
    const messages = this.buildMessages(questId, message, options.language, options);

    // 有工具时多轮：模型发 tool_calls → 执行 → 回灌结果 → 再要最终口语回复。
    // 无工具时保持单轮原逻辑（非机器人设备零回归）。
    const maxRounds = (tools && executeToolCall) ? 4 : 1;
    let curMessages = messages;
    let reply = '';
    let model = this.config.model;
    let lastToolCalls = null;

    for (let round = 0; round < maxRounds; round++) {
      const body = {
        model: this.config.model || 'default',
        messages: curMessages,
        temperature: this.config.temperature ?? 0.7,
        max_tokens: this.config.maxTokens ?? 500,
      };
      if (tools) { body.tools = tools; body.tool_choice = 'auto'; }

      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs || 60000),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`openai ${resp.status}: ${text.slice(0, 200)}`);
      }
      const data = await resp.json();
      model = data?.model || model;
      const msg = data?.choices?.[0]?.message;
      const toolCalls = msg?.tool_calls;

      if (tools && executeToolCall && Array.isArray(toolCalls) && toolCalls.length) {
        lastToolCalls = toolCalls;
        curMessages = [...curMessages, { role: 'assistant', content: msg.content || '', tool_calls: toolCalls }];
        const actionTools = (options.robotActionTools instanceof Set) ? options.robotActionTools : null;
        let allBodyAction = !!actionTools;
        for (const tc of toolCalls) {
          let args = {};
          try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { args = {}; }
          let out;
          let toolFailed = false;
          try {
            out = await executeToolCall(tc.function?.name, args);
          } catch (e) {
            out = `工具执行失败: ${e && e.message ? e.message : String(e)}`;
            toolFailed = true;
          }
          const content = (typeof out === 'string') ? out : JSON.stringify(out ?? '');
          curMessages.push({ role: 'tool', tool_call_id: tc.id, content });
          // 设备回报业务失败（JSON 中 ok:false，如未接线/被安全红线拒绝）也视为失败，不能假报“好了”
          let bizFailed = false;
          if (!toolFailed) {
            try { const o = JSON.parse(content); if (o && o.ok === false) bizFailed = true; } catch { /* 非 JSON，不判失败 */ }
          }
          // 非动作工具、或本工具报错/业务失败 → 需要二轮 LLM 叙述（回答查询 / 播报失败），不短路
          if (!actionTools || !actionTools.has(tc.function?.name) || toolFailed || bizFailed) allBodyAction = false;
        }
        // 纯身体动作且全部成功：动作本身即反馈，跳过二轮 LLM 口语，只补一句极短确认
        if (allBodyAction) {
          reply = (typeof options.robotConfirmText === 'string' && options.robotConfirmText.trim())
            ? options.robotConfirmText.trim() : '好了';
          break;
        }
        continue;
      }

      reply = msg?.content;
      break;
    }

    // 工具执行后若模型没给出口语回复，补一句兑底，避免空回复抛错卡流程。
    if ((typeof reply !== 'string' || !reply.trim())) {
      if (lastToolCalls) reply = '好的，已完成。';
      else throw new Error('openai 端点返回空回复');
    }

    this.addToHistory(questId, 'user', message);
    this.addToHistory(questId, 'assistant', reply);

    logger.info(`openai生成回复: ${message.substring(0, 20)}... -> ${reply.substring(0, 20)}...`);

    return {
      text: reply,
      rawText: reply,
      sessionId: questId,
      provider: 'openai',
      model,
      toolCalls: lastToolCalls || undefined,
    };
  }

  /**
   * 经 dsh-xiaozhi-bridge 调用 DeepSeek Harness
   * 同一 questId 映射到同一条 dsh 会话（header x-dsh-session），上下文由 dsh 维护
   */
  async chatViaDsh(questId, message, options = {}) {
    const url = `${this.dshBaseUrl.replace(/\/$/, '')}/chat/completions`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dsh-session': String(questId),
      },
      body: JSON.stringify({
        model: this.config.model || 'dsh-agent',
        messages: this.buildMessages(questId, message, options.language, options),
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
   * @param {string|null} language - 回复语言托底
   * @param {Object} options - { practiceSummary: true 时 system 换为口语教练总结提示词 }
   * @returns {Array} 消息数组
   */
  buildMessages(connectionId, newMessage, language = null, options = {}) {
    const messages = [];

    // 添加系统提示（多语言：跟随用户语言，无法判断时按设备/全局默认语种托底）
    // speaker：当前说话人（声纹识别接入后逐人区分；未启用时取默认单一说话人），留空则不称呼
    const langName = { zh: '中文', ja: '日本語', en: 'English' }[language || this.defaultLanguage] || '中文';
    const speakerHint = options.speaker ? `当前说话人是「${options.speaker}」，回复时自然地称呼对方。` : '';
    if (options.practiceSummary) {
      // 口语练习总结轮：教练角色点评聚合全文
      messages.push({
        role: 'system',
        content: this.config.practice?.summaryPrompt || DEFAULT_PRACTICE_SUMMARY_PROMPT
      });
    } else {
      // 机器人身体人设：仅当后台将该设备设为机器人（options.robotPersona）时追加，
      // 普通设备保持原提示词不变（零回归）。
      const robotHint = options.robotPersona
        ? ' 你拥有一台可实际操控的机器人身体（机械臂、底盘、蜂鸣器等）。当用户要求执行动作时，必须调用相应工具（如 robot_arm_pose、robot_beep）真正完成，禁止只用文字描述动作或假装执行。'
        : '';
      // 设备人设：后台“设备个体设定”可自定义名字/性格（settings.persona），
      // 未设时保持默认“小智”人设（零回归）。
      const pname = (options.persona && options.persona.name) ? String(options.persona.name).trim() : '';
      const ppersonality = (options.persona && options.persona.personality) ? String(options.persona.personality).trim() : '';
      const identity = pname ? `你是${pname}。` : '你是小智，一个友好、智能的AI助手。';
      const personalityHint = ppersonality ? `你的性格：${ppersonality}。` : '';
      messages.push({
        role: 'system',
        content: `${identity}${personalityHint}今天是${this.getCurrentDateTime()}，涉及日期/时间的问题以此为准，禁止凭记忆猜测。请用与用户相同的语言回复；无法判断时用${langName}。${speakerHint}回答要简洁明了。${robotHint}`
      });
    }

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
