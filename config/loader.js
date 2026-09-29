/**
 * Xiaozhi Channel Configuration Loader
 * 统一的配置加载器，从config.json读取所有配置
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class ConfigLoader {
  constructor() {
    this.config = null;
    this.configPath = path.join(__dirname, '../config.json');
  }

  /**
   * 加载配置文件
   */
  loadConfig() {
    if (this.config) {
      return this.config;
    }

    try {
      if (!fs.existsSync(this.configPath)) {
        throw new Error(`Configuration file not found: ${this.configPath}`);
      }

      const configFile = fs.readFileSync(this.configPath, 'utf8');
      this.config = JSON.parse(configFile);
      
      // 应用环境变量覆盖
      this.applyEnvironmentOverrides();
      
      console.log('[ConfigLoader] Configuration loaded successfully');
      return this.config;
    } catch (error) {
      console.error('[ConfigLoader] Failed to load configuration:', error.message);
      throw error;
    }
  }

  /**
   * 应用环境变量覆盖配置
   */
  applyEnvironmentOverrides() {
    if (!this.config) return;

    // 服务器配置覆盖
    this.config.port = process.env.XIAOZHI_PORT || process.env.PORT || this.config.port || 8003;
    this.config.host = process.env.XIAOZHI_HOST || process.env.HOST || this.config.host || '0.0.0.0';
    
    // STT配置覆盖
    if (this.config.stt) {
      this.config.stt.provider = process.env.STT_PROVIDER || this.config.stt.provider || 'funasr';
      this.config.stt.language = process.env.STT_LANGUAGE || this.config.stt.language || 'zh-CN';
    }
    
    // TTS配置覆盖
    if (this.config.tts) {
      this.config.tts.provider = process.env.TTS_PROVIDER || this.config.tts.provider || 'edge';
      this.config.tts.voice = process.env.TTS_VOICE || this.config.tts.voice || 'zh-CN-XiaoxiaoNeural';
    }
    
    // FunASR配置覆盖
    if (this.config.stt?.funasr) {
      this.config.stt.funasr.host = process.env.FUNASR_HOST || this.config.stt.funasr.host || 'localhost';
      this.config.stt.funasr.port = process.env.FUNASR_PORT || this.config.stt.funasr.port || 10096;
      this.config.stt.funasr.mode = process.env.FUNASR_MODE || this.config.stt.funasr.mode || 'offline';
    }
  }

  /**
   * 获取完整配置
   */
  getConfig() {
    if (!this.config) {
      this.loadConfig();
    }
    return this.config;
  }

  /**
   * 获取服务器配置
   */
  getServerConfig() {
    const config = this.getConfig();
    return {
      port: config.port || 8003,
      host: config.host || '0.0.0.0',
      environment: process.env.NODE_ENV || 'development'
    };
  }

  /**
   * 获取STT配置
   */
  getSttConfig() {
    const config = this.getConfig();
    return config.stt || {
      provider: 'funasr',
      language: 'zh-CN',
      sampleRate: 16000,
      channels: 1
    };
  }

  /**
   * 获取TTS配置
   */
  getTtsConfig() {
    const config = this.getConfig();
    return config.tts || {
      provider: 'edge',
      voice: 'zh-CN-XiaoxiaoNeural',
      rate: 1.0,
      volume: 1.0
    };
  }

  /**
   * 获取FunASR配置
   */
  getFunasrConfig() {
    const sttConfig = this.getSttConfig();
    return sttConfig.funasr || {
      host: 'localhost',
      port: 10096,
      is_ssl: false,
      api_key: 'none',
      mode: 'offline',
      chunk_size: [5, 10, 5],
      chunk_interval: 10,
      itn: false
    };
  }

  /**
   * 获取LLM配置（如果存在）
   */
  getLlmConfig() {
    const config = this.getConfig();
    return config.llm || {
      provider: 'glm',
      model: 'glm-4-flash',
      temperature: 0.7,
      maxTokens: 500
    };
  }

  /**
   * 获取频道基本信息
   */
  getChannelInfo() {
    const config = this.getConfig();
    return {
      id: config.id || 'xiaozhi',
      name: config.name || 'XiaoZhi',
      desc: config.desc || 'XiaoZhi Channel',
      type: config.type || 'XiaoZhi',
      enabled: config.enabled !== undefined ? config.enabled : true
    };
  }

  /**
   * 验证配置完整性
   */
  validateConfig() {
    const config = this.getConfig();
    
    const errors = [];
    
    // 检查必需字段
    if (!config.id) errors.push('Missing required field: id');
    if (!config.name) errors.push('Missing required field: name');
    
    // 检查STT配置
    if (!config.stt) {
      errors.push('Missing STT configuration');
    } else {
      if (!config.stt.provider) errors.push('Missing STT provider');
      if (!config.stt.language) errors.push('Missing STT language');
    }
    
    // 检查TTS配置
    if (!config.tts) {
      errors.push('Missing TTS configuration');
    } else {
      if (!config.tts.provider) errors.push('Missing TTS provider');
      if (!config.tts.voice) errors.push('Missing TTS voice');
    }
    
    if (errors.length > 0) {
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }
    
    return true;
  }

  /**
   * 重新加载配置（用于运行时配置更新）
   */
  reloadConfig() {
    this.config = null;
    return this.loadConfig();
  }
}

// 导出单例实例
export const configLoader = new ConfigLoader();

// 便捷方法导出
export const getConfig = () => configLoader.getConfig();
export const getServerConfig = () => configLoader.getServerConfig();
export const getSttConfig = () => configLoader.getSttConfig();
export const getTtsConfig = () => configLoader.getTtsConfig();
export const getFunasrConfig = () => configLoader.getFunasrConfig();
export const getLlmConfig = () => configLoader.getLlmConfig();
export const getChannelInfo = () => configLoader.getChannelInfo();
export const validateConfig = () => configLoader.validateConfig();

export default configLoader;