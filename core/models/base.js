// 基础数据模型类
class BaseModel {
  constructor(data = {}) {
    this.id = data.id || this.generateId();
    this.createdAt = data.createdAt || new Date();
    this.updatedAt = data.updatedAt || new Date();
    this.deleted = data.deleted || false;
  }

  generateId() {
    return Date.now() + Math.random().toString(36).substr(2, 9);
  }

  toJSON() {
    return {
      id: this.id,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      deleted: this.deleted
    };
  }

  update(data) {
    Object.keys(data).forEach(key => {
      if (key !== 'id' && key !== 'createdAt') {
        this[key] = data[key];
      }
    });
    this.updatedAt = new Date();
  }

  delete() {
    this.deleted = true;
    this.updatedAt = new Date();
  }

  static validate(data) {
    // 子类应该实现具体的验证逻辑
    return { valid: true };
  }
}

export default BaseModel;