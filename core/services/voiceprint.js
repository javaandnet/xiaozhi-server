import { logger } from '../../utils/logger.js';
import BaseService from './base.js';

/**
 * 声纹识别服务
 * 移植自 xiaozhi-server/core/utils/voiceprint_provider.py
 * 
 * 配置格式:
 * {
 *   url: 'https://api.example.com?key=xxx',  // API地址，key从URL参数提取
 *   speakers: ['speaker_id,姓名,描述', ...],
 *   similarity_threshold: 0.4  // 相似度阈值，默认0.4
 * }
 */
class VoiceprintService extends BaseService {
  constructor(config = {}) {
    super('Voiceprint', config);

    this.originalUrl = config.url || '';
    this.speakers = config.speakers || [];
    this.similarityThreshold = parseFloat(config.similarity_threshold) || 0.4;

    // 解析后的配置
    this.apiUrl = null;
    this.apiKey = null;
    this.speakerIds = [];
    this.speakerMap = {};

    // 缓存健康检查结果
    this._healthCache = {
      result: null,
      timestamp: 0,
      ttl: 5 * 60 * 1000 // 5分钟缓存
    };
  }

  async _initialize() {
    logger.info('初始化声纹服务...');

    if (!this.originalUrl) {
      logger.warn('声纹识别URL未配置，声纹识别将被禁用');
      this.enabled = false;
      return;
    }

    // 解析URL和key
    const urlObj = new URL(this.originalUrl);
    const baseUrl = `${urlObj.protocol}//${urlObj.host}`;
    this.apiKey = urlObj.searchParams.get('key');

    if (!this.apiKey) {
      logger.error('URL中未找到key参数，声纹识别将被禁用');
      this.enabled = false;
      return;
    }

    // 构造API地址
    this.apiUrl = `${baseUrl}/voiceprint/identify`;

    // 解析speakers配置
    this._parseSpeakers();

    if (this.speakerIds.length === 0) {
      logger.warn('未配置有效的说话人，声纹识别将被禁用');
      this.enabled = false;
      return;
    }

    // 健康检查
    const isHealthy = await this._checkServerHealth(baseUrl);
    if (isHealthy) {
      this.enabled = true;
      logger.info(`声纹识别已启用: API=${this.apiUrl}, 说话人=${this.speakerIds.length}个, 阈值=${this.similarityThreshold}`);
    } else {
      this.enabled = false;
      logger.warn(`声纹识别服务器不可用，声纹识别已禁用: ${this.apiUrl}`);
    }
  }

  /**
   * 解析说话人配置
   * 格式: 'speaker_id,name,description'
   */
  _parseSpeakers() {
    for (const speakerStr of this.speakers) {
      try {
        const parts = speakerStr.split(',').map(s => s.trim());
        if (parts.length >= 1) {
          const speakerId = parts[0];
          this.speakerIds.push(speakerId);

          if (parts.length >= 3) {
            this.speakerMap[speakerId] = {
              name: parts[1],
              description: parts[2]
            };
          }
        }
      } catch (e) {
        logger.warn(`解析说话人配置失败: ${speakerStr}`);
      }
    }
  }

  /**
   * 检查声纹识别服务器健康状态
   */
  async _checkServerHealth(baseUrl) {
    const now = Date.now();

    // 检查缓存
    if (this._healthCache.result !== null &&
      (now - this._healthCache.timestamp) < this._healthCache.ttl) {
      logger.debug(`使用缓存的健康状态: ${this._healthCache.result}`);
      return this._healthCache.result;
    }

    logger.info('执行声纹服务器健康检查...');

    try {
      const healthUrl = `${baseUrl}/voiceprint/health?key=${this.apiKey}`;
      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(3000)
      });

      if (response.ok) {
        const result = await response.json();
        const isHealthy = result.status === 'healthy';

        this._healthCache = { result: isHealthy, timestamp: now };
        logger.info(`声纹识别服务器健康检查: ${isHealthy ? '通过' : '异常'}`);
        return isHealthy;
      } else {
        logger.warn(`声纹识别服务器健康检查失败: HTTP ${response.status}`);
        this._healthCache = { result: false, timestamp: now };
        return false;
      }
    } catch (e) {
      logger.warn(`声纹识别服务器健康检查异常: ${e.message}`);
      this._healthCache = { result: false, timestamp: now };
      return false;
    }
  }

  /**
   * 识别说话人
   * @param {Buffer} audioData - WAV音频数据
   * @param {string} sessionId - 会话ID
   * @returns {Promise<string|null>} 说话人名称或null
   */
  async identifySpeaker(audioData, sessionId) {
    if (!this.enabled || !this.apiUrl || !this.apiKey) {
      logger.debug('声纹识别功能已禁用或未配置，跳过识别');
      return null;
    }

    const startTime = performance.now();

    try {
      // 构造 multipart/form-data
      const formData = new FormData();
      formData.append('speaker_ids', this.speakerIds.join(','));
      formData.append('file', new Blob([audioData], { type: 'audio/wav' }), 'audio.wav');

      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: formData,
        signal: AbortSignal.timeout(10000)
      });

      const elapsed = (performance.now() - startTime) / 1000;
      logger.info(`声纹识别耗时: ${elapsed.toFixed(3)}s`);

      if (response.ok) {
        const result = await response.json();
        const speakerId = result.speaker_id;
        const score = result.score || 0;

        // 相似度阈值检查
        if (score < this.similarityThreshold) {
          logger.warn(`声纹识别相似度${score.toFixed(3)}低于阈值${this.similarityThreshold}`);
          return '未知说话人';
        }

        if (speakerId && this.speakerMap[speakerId]) {
          const name = this.speakerMap[speakerId].name;
          logger.info(`声纹识别成功: ${name} (相似度: ${score.toFixed(3)})`);
          return name;
        } else {
          logger.warn(`未识别的说话人ID: ${speakerId}`);
          return '未知说话人';
        }
      } else {
        logger.error(`声纹识别API错误: HTTP ${response.status}`);
        return null;
      }
    } catch (e) {
      const elapsed = (performance.now() - startTime) / 1000;
      logger.error(`声纹识别失败 (${elapsed.toFixed(3)}s): ${e.message}`);
      return null;
    }
  }

  /**
   * 声纹注册接口（预留）：向外部声纹服务 POST /voiceprint/register 登记一段音频为某说话人。
   * 声纹服务未配置时直接返回失败，不抛异常。
   * @param {string} speakerId - 说话人ID（与 config.voiceprint.speakers 首段一致）
   * @param {Buffer|ArrayBuffer} audioData - 注册音频（WAV）
   */
  async registerSpeaker(speakerId, audioData) {
    if (!this.enabled || !this.apiKey) {
      logger.warn('声纹服务未启用，无法注册声纹');
      return { ok: false, error: 'voiceprint disabled' };
    }
    try {
      const baseUrl = this.apiUrl.replace(/\/voiceprint\/identify$/, '');
      const formData = new FormData();
      formData.append('speaker_id', speakerId);
      formData.append('file', new Blob([audioData], { type: 'audio/wav' }), 'register.wav');
      const response = await fetch(`${baseUrl}/voiceprint/register`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        body: formData,
        signal: AbortSignal.timeout(15000)
      });
      const ok = response.ok;
      logger.info(`声纹注册 ${speakerId}: HTTP ${response.status}`);
      return { ok, error: ok ? null : `HTTP ${response.status}` };
    } catch (e) {
      logger.error(`声纹注册失败: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  /** 声纹删除接口（预留）：DELETE /voiceprint/delete?speaker_id= */
  async deleteSpeaker(speakerId) {
    if (!this.enabled || !this.apiKey) {
      logger.warn('声纹服务未启用，无法删除声纹');
      return { ok: false, error: 'voiceprint disabled' };
    }
    try {
      const baseUrl = this.apiUrl.replace(/\/voiceprint\/identify$/, '');
      const response = await fetch(`${baseUrl}/voiceprint/delete?speaker_id=${encodeURIComponent(speakerId)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(10000)
      });
      const ok = response.ok;
      logger.info(`声纹删除 ${speakerId}: HTTP ${response.status}`);
      return { ok, error: ok ? null : `HTTP ${response.status}` };
    } catch (e) {
      logger.error(`声纹删除失败: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  async _healthCheck() {
    if (!this.enabled) {
      return { message: '声纹服务未启用' };
    }
    return {
      message: '声纹服务运行正常',
      apiUrl: this.apiUrl,
      speakerCount: this.speakerIds.length,
      threshold: this.similarityThreshold
    };
  }
}

export default VoiceprintService;
