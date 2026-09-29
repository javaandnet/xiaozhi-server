import BaseModel from './base.js';

class SessionModel extends BaseModel {
  constructor(data = {}) {
    super(data);
    this.sessionId = data.sessionId || this.generateSessionId();
    this.clientId = data.clientId || '';
    this.userId = data.userId || null;
    this.deviceId = data.deviceId || null;
    this.status = data.status || 'active'; // active, inactive, closed
    this.startTime = data.startTime || new Date();
    this.endTime = data.endTime || null;
    this.lastActivity = data.lastActivity || new Date();
    this.metadata = data.metadata || {};
    this.context = data.context || {}; // 对话上下文
  }

  generateSessionId() {
    return 'sess_' + Date.now() + Math.random().toString(36).substr(2, 9);
  }

  toJSON() {
    return {
      ...super.toJSON(),
      sessionId: this.sessionId,
      clientId: this.clientId,
      userId: this.userId,
      deviceId: this.deviceId,
      status: this.status,
      startTime: this.startTime,
      endTime: this.endTime,
      lastActivity: this.lastActivity,
      metadata: this.metadata,
      context: this.context
    };
  }

  isActive() {
    return this.status === 'active' && 
           (new Date() - new Date(this.lastActivity)) < 300000; // 5分钟内
  }

  updateActivity() {
    this.lastActivity = new Date();
    this.updatedAt = new Date();
  }

  close() {
    this.status = 'closed';
    this.endTime = new Date();
    this.updatedAt = new Date();
  }

  addContext(key, value) {
    this.context[key] = value;
    this.updatedAt = new Date();
  }

  getContext(key) {
    return this.context[key];
  }

  static validate(data) {
    const errors = [];
    
    if (!data.clientId) {
      errors.push('客户端ID不能为空');
    }
    
    const validStatus = ['active', 'inactive', 'closed'];
    if (data.status && !validStatus.includes(data.status)) {
      errors.push(`无效的会话状态: ${data.status}`);
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
}

export default SessionModel;