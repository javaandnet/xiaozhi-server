import BaseService from './base.js';

class VadService extends BaseService {
  constructor(config = {}) {
    super('VAD', config);
  }

  async _initialize() {
    console.log('初始化VAD服务');
  }

  async _healthCheck() {
    return {
      message: 'VAD服务运行正常'
    };
  }

  /**
   * 检测音频数据中是否有语音
   * @param {Buffer} audioData - 音频数据
   * @returns {boolean|null} 是否有语音，返回 null 表示未处理（交由调用方处理）
   */
  detect(audioData) {
    // 默认实现：如果未配置具体引擎，返回 null 告知调用方使用本地 VAD 逻辑
    return null;
  }
}

export default VadService;
