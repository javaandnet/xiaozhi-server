// 基础服务类
class BaseService {
  constructor(name, config = {}) {
    this.name = name;
    this.config = config;
    this.enabled = config.enabled !== false;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) {
      return true;
    }

    try {
      await this._initialize();
      this.initialized = true;
      return true;
    } catch (error) {
      console.error(`服务初始化失败 ${this.name}:`, error);
      throw error;
    }
  }

  async _initialize() {
    // 子类应该实现具体的初始化逻辑
  }

  async destroy() {
    if (!this.initialized) {
      return;
    }

    try {
      await this._destroy();
      this.initialized = false;
    } catch (error) {
      console.error(`服务销毁失败 ${this.name}:`, error);
      throw error;
    }
  }

  async _destroy() {
    // 子类应该实现具体的销毁逻辑
  }

  isEnabled() {
    return this.enabled && this.initialized;
  }

  getConfig() {
    return this.config;
  }

  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }

  async healthCheck() {
    if (!this.initialized) {
      return {
        status: 'uninitialized',
        message: '服务未初始化'
      };
    }

    try {
      const result = await this._healthCheck();
      return {
        status: 'healthy',
        ...result
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message
      };
    }
  }

  async _healthCheck() {
    // 子类应该实现具体的健康检查逻辑
    return { message: '服务运行正常' };
  }
}

export default BaseService;