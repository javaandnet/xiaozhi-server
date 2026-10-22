import BaseModel from './base.js';

// WebSocket readyState.OPEN。仅用于判活，避免为此引入 ws 依赖
const WS_READY_STATE_OPEN = 1;

class DeviceModel extends BaseModel {
  constructor(data = {}) {
    super(data);
    this.deviceId = data.deviceId || '';
    this.clientId = data.clientId || '';
    this.name = data.name || '';
    this.type = data.type || 'unknown';
    this.status = data.status || 'offline';
    this.ip = data.ip || '';
    this.mac = data.mac || '';
    this.version = data.version || '';
    this.capabilities = Array.isArray(data.capabilities) ? data.capabilities : [];
    this.lastActivity = data.lastActivity ? new Date(data.lastActivity) : new Date();
    this.battery = typeof data.battery === 'number' && data.battery >= 0 && data.battery <= 100 ? data.battery : null;
    this.signal = typeof data.signal === 'number' ? data.signal : null;
    this.location = data.location || null;
    this.metadata = typeof data.metadata === 'object' && data.metadata !== null ? data.metadata : {};
    // 保持WebSocket连接引用
    this.connection = data.connection || null;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      deviceId: this.deviceId,
      clientId: this.clientId,
      name: this.name,
      type: this.type,
      status: this.status,
      ip: this.ip,
      mac: this.mac,
      version: this.version,
      capabilities: this.capabilities,
      lastActivity: this.lastActivity.toISOString(),
      battery: this.battery,
      signal: this.signal,
      location: this.location,
      metadata: this.metadata
    };
  }

  isOnline() {
    // 在线以真实 WebSocket 连接为准：连接在就在线。休息态设备保持连接但不上传有效语音，
    // lastActivity 因此长期不刷新；若沿用活动窗口判定，设备连上 2 分钟后必被误判离线
    // （后台设备一览显示"未在线"即此因）。
    if (this.connection) {
      return this.connection.readyState === WS_READY_STATE_OPEN;
    }
    // 无连接引用（仅由注册信息重建的设备）退回状态位 + 活动窗口兜底
    return this.status === 'online' &&
      (new Date() - new Date(this.lastActivity)) < 120000; // 2分钟内
  }

  updateStatus(status) {
    this.status = status;
    this.lastActivity = new Date();
    this.updatedAt = new Date();
  }

  updateBattery(level) {
    this.battery = level;
    this.lastActivity = new Date();
    this.updatedAt = new Date();
  }

  static validate(data) {
    const errors = [];

    if (!data.deviceId || typeof data.deviceId !== 'string') {
      errors.push('设备ID不能为空且必须是字符串');
    }

    if (!data.clientId || typeof data.clientId !== 'string') {
      errors.push('客户端ID不能为空且必须是字符串');
    }

    const validTypes = ['sensor', 'agent', 'hard', 'manager', 'unknown'];
    if (data.type && !validTypes.includes(data.type)) {
      errors.push(`无效的设备类型: ${data.type}`);
    }

    if (data.battery !== undefined && (typeof data.battery !== 'number' || data.battery < 0 || data.battery > 100)) {
      errors.push('电池电量必须是0-100之间的数字');
    }

    if (data.lastActivity && isNaN(new Date(data.lastActivity).getTime())) {
      errors.push('最后活动时间无效');
    }

    if (data.metadata !== undefined && (typeof data.metadata !== 'object' || data.metadata === null)) {
      errors.push('元数据必须是对象');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

export default DeviceModel;