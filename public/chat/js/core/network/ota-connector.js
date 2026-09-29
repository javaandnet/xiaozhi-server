import { log } from '../../utils/logger.js?v=0205';

// WebSocket 连接
export async function webSocketConnect(otaUrl, config) {

    if (!validateConfig(config)) {
        return;
    }

    // 发送OTA请求并获取返回的websocket信息
    const otaResult = await sendOTA(otaUrl, config);
    if (!otaResult) {
        log('无法从OTA服务器获取信息', 'error');
        return;
    }

    // 从OTA响应中提取websocket信息
    const { websocket } = otaResult;
    if (!websocket || !websocket.url) {
        log('OTA响应中缺少websocket信息', 'error');
        return;
    }

    // 使用OTA返回的websocket URL
    let connUrl = new URL(websocket.url);

    // 使用当前页面的host替换OTA返回的host，确保证书匹配
    // 例如：如果页面是 https://localhost:8003，则使用 localhost 而不是 IP
    const pageHost = window.location.host; // 包含端口号
    const pageProtocol = window.location.protocol; // http: 或 https:

    // 替换host为当前页面的host
    connUrl.host = pageHost;

    // 根据当前页面协议自动调整 WebSocket 协议
    // 如果页面是 https，则使用 wss；如果是 http，则使用 ws
    const isSecurePage = pageProtocol === 'https:';
    if (isSecurePage) {
        connUrl.protocol = 'wss:';
        log(`页面使用HTTPS，WebSocket使用wss协议，主机: ${pageHost}`, 'info');
    } else {
        connUrl.protocol = 'ws:';
        log(`页面使用HTTP，WebSocket使用ws协议，主机: ${pageHost}`, 'info');
    }

    // 添加token参数（从OTA响应中获取）
    if (websocket.token) {
        if (websocket.token.startsWith("Bearer ")) {
            connUrl.searchParams.append('authorization', websocket.token);
        } else {
            connUrl.searchParams.append('authorization', 'Bearer ' + websocket.token);
        }
    }

    // 添加认证参数（保持原有逻辑）
    connUrl.searchParams.append('device-id', config.deviceId);
    connUrl.searchParams.append('client-id', config.clientId);

    // 添加客户端类型和时间戳参数
    connUrl.searchParams.append('client_type', 'agent');
    connUrl.searchParams.append('timestamp', Date.now());

    const wsurl = connUrl.toString()

    log(`正在连接: ${wsurl}`, 'info');

    if (wsurl) {
        document.getElementById('serverUrl').value = wsurl;
    }

    return new WebSocket(connUrl.toString());
}

// 验证配置
function validateConfig(config) {
    if (!config.deviceMac) {
        log('设备MAC地址不能为空', 'error');
        return false;
    }
    if (!config.clientId) {
        log('客户端ID不能为空', 'error');
        return false;
    }
    return true;
}

// OTA发送请求，验证状态，并返回响应数据
async function sendOTA(otaUrl, config) {
    try {
        const res = await fetch(otaUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Device-Id': config.deviceId,
                'Client-Id': config.clientId
            },
            body: JSON.stringify({
                version: 0,
                uuid: '',
                application: {
                    name: 'xiaozhi-web-test',
                    version: '1.0.0',
                    compile_time: '2025-04-16 10:00:00',
                    idf_version: '4.4.3',
                    elf_sha256: '1234567890abcdef1234567890abcdef1234567890abcdef'
                },
                ota: { label: 'xiaozhi-web-test' },
                board: {
                    type: config.deviceName,
                    ssid: 'xiaozhi-web-test',
                    rssi: 0,
                    channel: 0,
                    ip: '192.168.1.1',
                    mac: config.deviceMac
                },
                flash_size: 0,
                minimum_free_heap_size: 0,
                mac_address: config.deviceMac,
                chip_model_name: '',
                chip_info: { model: 0, cores: 0, revision: 0, features: 0 },
                partition_table: [{ label: '', type: 0, subtype: 0, address: 0, size: 0 }]
            })
        });

        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

        const result = await res.json();
        return result; // 返回完整的响应数据
    } catch (err) {
        return null; // 失败返回null
    }
}