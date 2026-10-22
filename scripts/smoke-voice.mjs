#!/usr/bin/env node
/**
 * smoke-voice.mjs — 小智语音通道下行冒烟自检（联调前一条命令验证设备在线 + 播报可达）
 *
 * 做两件事：
 *   1) POST /api/voice/devices  → 列出在线设备（确认 deviceId 对得上、设备保活在册）
 *   2) 给了 --device + --text 时，POST /api/voice/speak 做一次主动推话（验证 idle 保活下能出声）
 *
 * 端口与共享密钥默认从同目录 ../config.json 读（port / voiceFlow.token），
 * 也可用环境变量或命令行覆盖——密钥不硬编码进脚本。
 *
 * 用法：
 *   node scripts/smoke-voice.mjs                       # 只列在线设备
 *   node scripts/smoke-voice.mjs --device AA:BB:CC --text "测试播报"   # 列设备 + 下行自检
 *   可选：--base http://127.0.0.1:8003  --token <x>  --port 8003
 * 退出码：0=通过；1=失败（设备不在线/密钥不符/网络不可达/播报被拒）。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { o[a.slice(2)] = argv[i + 1]; i++; }
  }
  return o;
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, '../config.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const args = parseArgs(process.argv);
const cfg = loadConfig();
const port = args.port || process.env.XIAOZHI_PORT || cfg.port || 8003;
const base = (args.base || process.env.XIAOZHI_BASE || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
const rawToken = args.token || process.env.XIAOZHI_VOICE_TOKEN || cfg?.voiceFlow?.token || '';
// config.json may store the "$shared" reference; resolve to the top-level sharedToken.
const token = (rawToken === '$shared') ? (cfg?.sharedToken || '') : rawToken;

const headers = { 'Content-Type': 'application/json' };
if (token) headers['X-Xiaozhi-Key'] = token;

async function post(pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const ok = (msg) => { console.log(`  ✓ ${msg}`); };
const fail = (msg) => { console.error(`  ✗ ${msg}`); process.exitCode = 1; };

(async () => {
  console.log(`小智语音通道冒烟自检  base=${base}  token=${token ? `(${token.slice(0, 6)}…已配置)` : '未配置!'}`);
  if (!token) {
    fail('未取到共享密钥（config.voiceFlow.token 或 --token / XIAOZHI_VOICE_TOKEN）');
    return;
  }

  // 1) 在线设备
  let devices = [];
  try {
    const { status, data } = await post('/api/voice/devices', {});
    if (status !== 200 || data.ok === false) {
      fail(`设备查询失败 HTTP ${status} ${data.error || ''}`);
      return;
    }
    devices = data.devices || data.data || [];
    ok(`设备查询通过，在线 ${Array.isArray(devices) ? devices.length : '?'}`);
    if (Array.isArray(devices) && devices.length) {
      for (const d of devices.slice(0, 10)) {
        const id = d.deviceId || d.id || d;
        const extra = d.name ? ` (${d.name})` : (d.mode ? ` [${d.mode}]` : '');
        console.log(`      - ${id}${extra}`);
      }
    } else {
      console.log('      （无在线设备：设备可能缩了 WS，先确认保活/唤醒，否则下行 speak 不可达）');
    }
  } catch (e) {
    fail(`设备查询异常：${e.message}（xiaozhi-server 是否在 ${base} 运行？）`);
    return;
  }

  // 2) 可选下行播报自检
  if (args.device && args.text) {
    console.log(`\n向设备 ${args.device} 播报：“${args.text}”`);
    try {
      const { status, data } = await post('/api/voice/speak', { deviceId: args.device, text: args.text });
      if (status === 200 && data.ok !== false) {
        ok('下行 speak 成功——请现场确认设备是否出声（idle 保活生效）');
      } else {
        fail(`speak 返回 HTTP ${status}：${data.error || JSON.stringify(data)}`);
        console.log('      常见原因：deviceId 不在在线列表 / 密钥不符 / 该设备未保活');
      }
    } catch (e) {
      fail(`speak 异常：${e.message}`);
    }
  } else {
    console.log('\n（未带 --device + --text，跳过下行播报自检）');
  }
})();
