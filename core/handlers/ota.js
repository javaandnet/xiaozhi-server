import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '../../utils/logger.js';

class OTAHandler {
  constructor(config) {
    this.config = config;
    this.binDir = path.join(process.cwd(), 'data', 'bin');
    this.authEnabled = false;
    this.allowedDevices = new Set();
    // 设备上报回调（用于持久化设备注册表），由频道层注入
    this.onDeviceReport = null;
    this.setupAuth();
  }

  /**
   * 通知上层设备上报（内部吞掉异常，不影响OTA响应）
   */
  _notifyDeviceReport(info) {
    if (typeof this.onDeviceReport !== 'function') return;
    try {
      this.onDeviceReport(info);
    } catch (error) {
      logger.error('设备上报回调异常:', error);
    }
  }

  setupAuth() {
    const serverConfig = this.config.server || {};
    const authConfig = serverConfig.auth || {};

    this.authEnabled = authConfig.enabled || false;

    if (authConfig.allowed_devices && Array.isArray(authConfig.allowed_devices)) {
      this.allowedDevices = new Set(authConfig.allowed_devices);
    }
  }

  /**
   * 获取本地IP地址
   */
  getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return '192.168.1.55';
  }

  /**
   * 生成MQTT密码签名
   */
  generatePasswordSignature(content, secretKey) {
    try {
      const hmac = crypto.createHmac('sha256', secretKey);
      const signature = hmac.update(content).digest('base64');
      return signature;
    } catch (error) {
      logger.error('生成MQTT密码签名失败:', error);
      return '';
    }
  }

  /**
   * 获取WebSocket URL
   */
  getWebsocketUrl(localIp, port) {
    const serverConfig = this.config.server || {};
    const websocketConfig = serverConfig.websocket;

    // 如果配置了自定义websocket URL
    if (websocketConfig && websocketConfig !== '' && !websocketConfig.includes('你的')) {
      return websocketConfig;
    } else {
      // 根据服务端是否启用HTTPS决定协议
      const protocol = serverConfig.use_https ? 'wss' : 'ws';
      return `${protocol}://${localIp}:${port}/xiaozhi/v1/`;
    }
  }

  /**
   * 解析版本号
   */
  parseVersion(version) {
    const parts = version.match(/\d+/g) || [];
    return parts.map(p => parseInt(p, 10));
  }

  /**
   * 比较版本号
   */
  isHigherVersion(newVersion, oldVersion) {
    const newParts = this.parseVersion(newVersion);
    const oldParts = this.parseVersion(oldVersion);

    const maxLen = Math.max(newParts.length, oldParts.length);
    for (let i = 0; i < maxLen; i++) {
      const newPart = newParts[i] || 0;
      const oldPart = oldParts[i] || 0;
      if (newPart > oldPart) return true;
      if (newPart < oldPart) return false;
    }
    return false;
  }

  /**
   * 刷新固件缓存
   */
  refreshBinCache() {
    const filesByModel = {};

    try {
      // 确保目录存在
      if (!fs.existsSync(this.binDir)) {
        fs.mkdirSync(this.binDir, { recursive: true });
      }

      // 查找固件文件
      const files = fs.readdirSync(this.binDir);

      for (const file of files) {
        if (!file.endsWith('.bin')) continue;

        // 文件名格式: {model}_{version}.bin
        const match = file.match(/^(.+?)_([0-9][A-Za-z0-9.\-_]*)\.bin$/);
        if (!match) continue;

        const model = match[1];
        const version = match[2];

        if (!filesByModel[model]) {
          filesByModel[model] = [];
        }
        filesByModel[model].push({ version, filename: file });
      }

      // 对每个型号的版本进行排序（降序）
      for (const model of Object.keys(filesByModel)) {
        filesByModel[model].sort((a, b) => {
          return this.isHigherVersion(a.version, b.version) ? -1 : 1;
        });
      }

      logger.info(`固件缓存刷新: ${Object.keys(filesByModel).length} 个型号`);
      return filesByModel;
    } catch (error) {
      logger.error('刷新固件缓存失败:', error);
      return {};
    }
  }

  /**
   * 处理OTA POST请求
   * @param {Object} req - Express请求对象
   */
  async handlePost(req) {
    try {
      // 处理各种大小写的请求头
      const headers = req.headers || {};
      const deviceId = headers['device-id'] || headers['Device-Id'] || headers['device_id'] || '';
      const clientId = headers['client-id'] || headers['Client-Id'] || headers['client_id'] || '';

      // 获取请求体数据（Express已经解析了JSON）
      const bodyData = req.body || {};

      // 获取设备型号
      const deviceModel = headers['device-model'] || headers['Device-Model'] ||
        headers['device_model'] ||
        (bodyData.board && bodyData.board.type) ||
        bodyData.model || 'default';

      // 获取设备版本
      const deviceVersion = headers['device-version'] || headers['Device-Version'] ||
        headers['device_version'] ||
        (bodyData.application && bodyData.application.version) ||
        bodyData.version || '0.0.0';

      // 获取MAC地址
      const deviceMac = headers['mac-address'] || headers['Mac-Address'] ||
        bodyData.mac_address || bodyData.mac || '';

      logger.info(`OTA请求: 设备ID=${deviceId}, ClientID=${clientId}, 型号=${deviceModel}, 版本=${deviceVersion}, MAC=${deviceMac}`);

      // 登记设备到注册表（OTA 是设备最可靠的身份来源：型号/固件版本/MAC）
      if (deviceId) {
        this._notifyDeviceReport({
          deviceId,
          clientId,
          model: deviceModel,
          version: deviceVersion,
          mac: deviceMac,
          ip: req.socket?.remoteAddress || req.headers['x-forwarded-for'] || null,
          type: 'hard',
          source: 'ota',
          online: 0,
          newConnection: true
        });
      }

      const serverConfig = this.config.server || {};
      // WebSocket和HTTP共用同一端口（http_port）
      const httpPort = serverConfig.http_port || serverConfig.port || 8003;
      const websocketPort = httpPort; // 使用HTTP端口作为WebSocket端口
      const localIp = this.getLocalIP();
      // 设备固件(ota.cc)将 server_time.timezone_offset 按「分钟」解释（ts += offset*60*1000）。
      // 这里 config.server.timezone_offset 以「小时」表示（如 9=UTC+9），未配置则取服务器本机真实时区偏移；下发前换算为分钟。
      const tzOffsetHours = serverConfig.timezone_offset ?? -(new Date().getTimezoneOffset() / 60);
      const timezoneOffset = Math.round(tzOffsetHours * 60);

      const returnJson = {
        server_time: {
          timestamp: Date.now(),
          timezone_offset: timezoneOffset
        },
        firmware: {
          version: deviceVersion,
          url: ''
        }
      };

      // 检查MQTT配置
      const mqttGateway = serverConfig.mqtt_gateway;

      if (mqttGateway) {
        // 配置了MQTT网关，返回MQTT配置
        const groupId = `GID_${deviceModel}`.replace(/[:\s]/g, '_');
        const macAddressSafe = deviceId.replace(/:/g, '_');
        const mqttClientId = `${groupId}@@@${macAddressSafe}@@@${macAddressSafe}`;

        // 生成用户名
        const userData = JSON.stringify({ ip: 'unknown' });
        const username = Buffer.from(userData).toString('base64');

        // 生成密码
        let password = '';
        const signatureKey = serverConfig.mqtt_signature_key || '';
        if (signatureKey) {
          password = this.generatePasswordSignature(
            `${mqttClientId}|${username}`,
            signatureKey
          );
        }

        returnJson.mqtt = {
          endpoint: mqttGateway,
          client_id: mqttClientId,
          username: username,
          password: password,
          publish_topic: 'device-server',
          subscribe_topic: `devices/p2p/${macAddressSafe}`
        };

        logger.info(`为设备 ${deviceId} 下发MQTT网关配置`);
      } else {
        // 未配置MQTT，返回WebSocket配置
        let token = '';
        if (this.authEnabled) {
          if (this.allowedDevices.size > 0) {
            if (this.allowedDevices.has(deviceId)) {
              token = this.generateToken(clientId, deviceId);
            }
          } else {
            token = this.generateToken(clientId, deviceId);
          }
        }

        returnJson.websocket = {
          url: this.getWebsocketUrl(localIp, websocketPort),
          token: token
        };

        logger.info(`为设备 ${deviceId} 下发WebSocket配置: ${returnJson.websocket.url}`);

        // GALA: deliver a server-managed backup websocket address (server1).
        // The device tries url first, then url_fallback when the primary is unreachable.
        const wsFallback = String(serverConfig.websocket_fallback || '').trim();
        if (wsFallback && !wsFallback.includes('你的')) {
          returnJson.websocket.url_fallback = wsFallback;
          logger.info(`为设备 ${deviceId} 下发备用WebSocket地址(server1): ${wsFallback}`);
        }
      }

      // 检查固件更新
      try {
        const filesByModel = this.refreshBinCache();
        const candidates = filesByModel[deviceModel] || [];

        logger.info(`查找型号 ${deviceModel} 的固件，找到 ${candidates.length} 个候选`);

        let chosenUrl = '';
        let chosenVersion = deviceVersion;

        for (const candidate of candidates) {
          if (this.isHigherVersion(candidate.version, deviceVersion)) {
            chosenVersion = candidate.version;
            chosenUrl = `http://${localIp}:${httpPort}/xiaozhi/ota/download/${candidate.filename}`;
            break;
          }
        }

        if (chosenUrl) {
          returnJson.firmware.version = chosenVersion;
          returnJson.firmware.url = chosenUrl;
          logger.info(`为设备 ${deviceId} 下发固件 ${chosenVersion}`);
        } else {
          logger.info(`设备 ${deviceId} 固件已是最新: ${deviceVersion}`);
        }
      } catch (error) {
        logger.error('检查固件版本时出错:', error);
      }

      return returnJson;
    } catch (error) {
      logger.error('OTA POST处理异常:', error);
      return { success: false, message: 'request error' };
    }
  }

  /**
   * 处理OTA GET请求
   */
  handleGet() {
    try {
      const serverConfig = this.config.server || {};
      // WebSocket和HTTP共用同一端口
      const httpPort = serverConfig.http_port || serverConfig.port || 8003;
      const websocketPort = httpPort;
      const localIp = this.getLocalIP();
      const websocketUrl = this.getWebsocketUrl(localIp, websocketPort);

      return {
        message: `OTA接口运行正常，向设备发送的websocket地址是：${websocketUrl}`,
        websocket_url: websocketUrl
      };
    } catch (error) {
      logger.error('OTA GET请求异常:', error);
      return { message: 'OTA接口异常' };
    }
  }

  /**
   * 生成认证token
   */
  generateToken(clientId, username) {
    const serverConfig = this.config.server || {};
    const authConfig = serverConfig.auth || {};
    const secretKey = serverConfig.auth_key || 'default_secret_key';
    const expireSeconds = authConfig.expire_seconds || 2592000;

    const timestamp = Math.floor(Date.now() / 1000);
    const content = `${clientId}|${username}|${timestamp}`;

    const sig = crypto
      .createHmac('sha256', secretKey)
      .update(content, 'utf8')
      .digest('base64url');

    return `${sig}.${timestamp}`;
  }

  /**
   * 处理固件下载
   */
  async handleDownload(filename) {
    try {
      // 安全检查：只允许 basename
      const safeFilename = path.basename(filename);

      // 验证文件名格式
      if (!/^[A-Za-z0-9.\-_]+\.bin$/.test(safeFilename)) {
        return { error: 'invalid filename', status: 400 };
      }

      const filePath = path.join(this.binDir, safeFilename);

      // 验证文件路径
      const realPath = path.resolve(filePath);
      const realDir = path.resolve(this.binDir);

      if (!realPath.startsWith(realDir + path.sep)) {
        return { error: 'forbidden', status: 403 };
      }

      // 检查文件是否存在
      if (!fs.existsSync(filePath)) {
        return { error: 'file not found', status: 404 };
      }

      return {
        filePath: filePath,
        filename: safeFilename
      };
    } catch (error) {
      logger.error('固件下载异常:', error);
      return { error: 'download error', status: 500 };
    }
  }
}

export default OTAHandler;