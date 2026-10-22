import { logger } from '../../utils/logger.js';
import DeviceModel from '../models/device.js';

class DeviceManager {
  constructor() {
    this.devices = new Map(); // clientId -> DeviceModel
    this.deviceLookup = new Map(); // deviceId -> clientId
    this.maxDevices = 10000;
  }

  // 添加设备
  addDevice(deviceData) {
    try {
      const validation = DeviceModel.validate(deviceData);
      if (!validation.valid) {
        throw new Error(`设备数据验证失败: ${validation.errors.join(', ')}`);
      }

      // 检查设备数量限制
      if (this.devices.size >= this.maxDevices) {
        throw new Error(`设备数量已达上限: ${this.maxDevices}`);
      }

      const device = new DeviceModel(deviceData);

      // 检查是否已存在
      if (this.devices.has(device.clientId)) {
        logger.warn(`设备已存在，更新信息: ${device.clientId}`);
        return this.updateDevice(device.clientId, deviceData);
      }

      this.devices.set(device.clientId, device);
      this.deviceLookup.set(device.deviceId, device.clientId);

      logger.info(`设备添加成功: ${device.deviceId} (${device.clientId})`);
      return device;
    } catch (error) {
      logger.error(`添加设备失败:`, error);
      throw error;
    }
  }

  // 获取设备
  getDevice(clientId) {
    return this.devices.get(clientId);
  }

  // 根据设备ID获取设备
  getDeviceByDeviceId(deviceId) {
    const clientId = this.deviceLookup.get(deviceId);
    return clientId ? this.devices.get(clientId) : null;
  }

  // 获取所有设备
  getAllDevices() {
    return Array.from(this.devices.values());
  }

  // 获取在线设备
  getOnlineDevices() {
    return this.getAllDevices().filter(device => device.isOnline());
  }

  // 更新设备信息
  updateDevice(clientId, updates) {
    const device = this.devices.get(clientId);
    if (!device) {
      throw new Error(`设备不存在: ${clientId}`);
    }

    device.update(updates);
    logger.debug(`设备信息更新: ${clientId}`);
    return device;
  }

  // 更新设备状态
  updateDeviceStatus(clientId, status) {
    const device = this.devices.get(clientId);
    if (!device) {
      throw new Error(`设备不存在: ${clientId}`);
    }

    device.updateStatus(status);
    logger.debug(`设备状态更新: ${clientId} -> ${status}`);
    return device;
  }

  // 移除设备
  // 归属校验在上层做（handleDisconnect 用 activeConnections 比对关闭的是否为当前活跃连接），
  // 这里只负责按 clientId 删除。
  removeDevice(clientId) {
    const device = this.devices.get(clientId);
    if (device) {
      this.devices.delete(clientId);
      this.deviceLookup.delete(device.deviceId);
      logger.info(`设备移除: ${device.deviceId} (${clientId})`);
      return device;
    }
    return null;
  }

  // 清理离线设备
  cleanupOfflineDevices(timeoutMinutes = 10) {
    const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000);
    const removedDevices = [];

    for (const [clientId, device] of this.devices) {
      if (new Date(device.lastActivity) < cutoffTime) {
        removedDevices.push(this.removeDevice(clientId));
      }
    }

    if (removedDevices.length > 0) {
      logger.info(`清理离线设备: ${removedDevices.length}个`);
    }

    return removedDevices;
  }

  // 获取设备统计信息
  getStats() {
    const allDevices = this.getAllDevices();
    const onlineDevices = this.getOnlineDevices();

    const typeStats = {};
    allDevices.forEach(device => {
      const type = device.type || 'unknown';
      typeStats[type] = (typeStats[type] || 0) + 1;
    });

    return {
      total: allDevices.length,
      online: onlineDevices.length,
      offline: allDevices.length - onlineDevices.length,
      types: typeStats,
      maxDevices: this.maxDevices
    };
  }

  // 搜索设备
  searchDevices(query) {
    const { deviceId, type, status, onlineOnly } = query;
    let devices = this.getAllDevices();

    if (deviceId) {
      devices = devices.filter(d =>
        d.deviceId.toLowerCase().includes(deviceId.toLowerCase())
      );
    }

    if (type) {
      devices = devices.filter(d => d.type === type);
    }

    if (status) {
      devices = devices.filter(d => d.status === status);
    }

    if (onlineOnly) {
      devices = devices.filter(d => d.isOnline());
    }

    return devices;
  }

  // 批量操作
  batchUpdate(updates) {
    const results = {
      success: 0,
      failed: 0,
      errors: []
    };

    for (const [clientId, updateData] of Object.entries(updates)) {
      try {
        this.updateDevice(clientId, updateData);
        results.success++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          clientId,
          error: error.message
        });
      }
    }

    return results;
  }

  // 获取在线设备统计信息
  getOnlineStats() {
    const allDevices = this.getAllDevices();
    const onlineDevices = this.getOnlineDevices();

    return {
      total: allDevices.length,
      online: onlineDevices.length,
      offline: allDevices.length - onlineDevices.length
    };
  }
}

export default DeviceManager;