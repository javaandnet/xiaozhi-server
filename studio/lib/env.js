/**
 * 环境探测 / 板型列举 / 版本查询 / 设备识别
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { connect } from 'net';
import { run, shq, fetchJson } from './util.js';

let boardCache = { ts: 0, data: null };

/** 读取 CMakeLists.txt 的 set(PROJECT_VER "x.y.z") */
export function readProjectVersion(repoDir) {
  try {
    const txt = fs.readFileSync(path.join(repoDir, 'CMakeLists.txt'), 'utf-8');
    const m = txt.match(/set\(PROJECT_VER\s+"([^"]+)"\)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** 环境健康检查 */
export async function probeEnv(cfg) {
  const checks = {
    repoDir: { ok: fs.existsSync(path.join(cfg.repoDir, 'scripts', 'build.py')), path: cfg.repoDir },
    idfExport: { ok: fs.existsSync(cfg.idfExport), path: cfg.idfExport },
    idfPython: { ok: fs.existsSync(cfg.idfPython), path: cfg.idfPython },
    dataBinDir: { ok: fs.existsSync(cfg.dataBinDir), path: cfg.dataBinDir },
    deviceDb: { ok: fs.existsSync(cfg.deviceDb), path: cfg.deviceDb },
  };
  // 依赖服务探活（HTTP/TCP，短超时；进程存活判定：HTTP status<500，401 也算在线）
  const sc = cfg.serviceChecks || {};
  if (sc.llmUrl) {
    checks.llmBridge = { ok: false, url: sc.llmUrl };
    try {
      const r = await fetch(sc.llmUrl, { signal: AbortSignal.timeout(2500) });
      checks.llmBridge.ok = r.status < 500;
      checks.llmBridge.status = r.status;
    } catch (e) { checks.llmBridge.error = e.cause?.message || e.message; }
  }
  if (sc.sttPort) {
    checks.funasr = { ok: await tcpReachable(sc.sttHost === 'localhost' ? '127.0.0.1' : sc.sttHost, sc.sttPort), url: `ws://${sc.sttHost}:${sc.sttPort}` };
  }
  const ports = listSerialPorts(cfg.serialGlob);
  const repoVersion = readProjectVersion(cfg.repoDir);
  let gitBranch = null;
  if (checks.repoDir.ok) {
    const r = await run(`git -C ${shq(cfg.repoDir)} rev-parse --abbrev-ref HEAD 2>/dev/null`, { timeoutMs: 5000 });
    gitBranch = r.code === 0 ? r.out.trim() : null;
  }
  const LOCAL_ONLY = ['llmBridge', 'funasr']; // 服务探活不参与编译门禁 allOk
  return { checks, ports, repoVersion, gitBranch, otaUrl: cfg.otaUrl, otaUrlFallback: cfg.otaUrlFallback || '', allOk: Object.entries(checks).filter(([k]) => !LOCAL_ONLY.includes(k)).every(([, c]) => c.ok) };
}

/** 列出串口（glob 前缀匹配 /dev/cu.usb*） */
export function listSerialPorts(globPrefix = '/dev/cu.usb*') {
  const stem = globPrefix.replace(/\*$/, ''); // '/dev/cu.usb'
  const dir = path.dirname(stem);             // '/dev'
  const base = path.basename(stem);           // 'cu.usb'
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith(base))
      .filter((f) => !/Bluetooth|debug-console/.test(f))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** 板型清单：优先调 build.py --list-boards --json，缓存 60s */
export async function listBoards(cfg, { refresh = false } = {}) {
  if (!refresh && boardCache.data && Date.now() - boardCache.ts < 60000) return boardCache.data;
  if (!fs.existsSync(path.join(cfg.repoDir, 'scripts', 'build.py'))) {
    return { error: '未找到 xiaozhi-esp32 仓库或 build.py', items: [] };
  }
  const py = fs.existsSync(cfg.idfPython) ? cfg.idfPython : 'python3';
  const cmd = `cd ${shq(cfg.repoDir)} && ${shq(py)} scripts/build.py --list-boards --json 2>/dev/null`;
  const r = await run(cmd, { timeoutMs: 30000 });
  if (r.code !== 0 || !r.out.trim().startsWith('[')) {
    return { error: '板型列举失败（build.py 无输出）', raw: r.out.slice(0, 400), items: [] };
  }
  let items;
  try {
    items = JSON.parse(r.out);
  } catch (e) {
    return { error: `板型 JSON 解析失败: ${e.message}`, items: [] };
  }
  const norm = items.map((x) => ({
    board: x.board, name: x.name, type: x.type, full_name: x.full_name,
    target: x.target, config: x.config, display_name: x.display_name,
  }));
  boardCache = { ts: Date.now(), data: { items: norm, count: norm.length } };
  return boardCache.data;
}

/** 读设备注册表 xz_devices（最近连接，用于自动识别板型） */
export async function listDevices(cfg, limit = 10) {
  if (!fs.existsSync(cfg.deviceDb)) return { error: '未找到设备库 gala.db', items: [] };
  const sql = `SELECT device_id, model, type, firmware_version, online, datetime(last_seen/1000,'unixepoch','localtime') AS last_seen FROM xz_devices ORDER BY last_seen DESC LIMIT ${Number(limit) | 0};`;
  const r = await run(`sqlite3 -json ${shq(cfg.deviceDb)} ${shq(sql)} 2>/dev/null`, { timeoutMs: 8000 });
  if (r.code !== 0 || !r.out.trim()) return { items: [] };
  try {
    return { items: JSON.parse(r.out) };
  } catch {
    return { items: [] };
  }
}

/** 从 macOS ioreg 读 USB 设备描述符：序列号(小智固件=MAC)/VID/PID/产品名，并映射到 /dev/cu.* 节点 */
export function usbInfo() {
  return new Promise((resolve) => {
    const child = spawn('ioreg', ['-p', 'IOUSB', '-l', '-w0']);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      const devs = [];
      // ioreg 树形输出：'  +-o "设备名"@location  <class ...>' 开头，逐行切块
      const blocks = [];
      let cur = null;
      for (const L of out.split('\n')) {
        const mm = L.match(/\+-o (.+)$/);
        if (mm) { cur = { head: mm[1], txt: '' }; blocks.push(cur); } else if (cur) cur.txt += L + '\n';
      }
      for (const { head, txt } of blocks) {
        const m = head.match(/^"?([^"@]+?)"?(@|\s|$)/);
        if (!m) continue;
        const g = (re) => { const x = txt.match(re); return x ? x[1] : null; };
        const serial = g(/"USB Serial Number" = "([^"]*)"/);
        const vid = g(/"idVendor" = (\d+)/);
        const pid = g(/"idProduct" = (\d+)/);
        const product = g(/"kUSBProductString" = "([^"]*)"/);
        const vendor = g(/"kUSBVendorString" = "([^"]*)"/);
        if (!serial && !vid) continue;
        devs.push({ entry: m[1], serial, vid: vid ? Number(vid) : null, pid: pid ? Number(pid) : null, product, vendor, mac: serial ? macOf(serial) : null, path: null });
      }
      // 节点名形如 usbmodem03cd11176609 / usbmodem11201：序列号去分隔符后可能带前导0，做宽松匹配
      const ports = listSerialPorts();
      for (const d of devs) {
        if (!d.serial) continue;
        const digits = d.serial.replace(/[^0-9A-Fa-f]/g, '').replace(/^0+/, '').toLowerCase();
        if (!digits) continue;
        if (digits.length < 6) continue; // 过短序列号（如 '1'）不做模糊匹配，防误挂
        const hit = ports.find((p) => { const b = path.basename(p).toLowerCase(); return b.includes(digits) || b.slice(-digits.length) === digits; });
        if (hit) d.path = hit;
      }
      resolve(devs);
    });
  });
}

/** "34:CD:B0:BA:34:B8" / "34cdb0ba34b8" → 小写冒号格式 */
function macOf(s) {
  const hex = String(s).replace(/[^0-9A-Fa-f]/g, '');
  return hex.length === 12 ? hex.toLowerCase().match(/.{2}/g).join(':') : null;
}

/** 自动识别：优先匹配最近在线设备的 model→板型 type；否则用串口号提示 */
export async function detectBoard(cfg) {
  const [devRes, boardsRes] = await Promise.all([listDevices(cfg, 10), listBoards(cfg)]);
  const boards = boardsRes.items || [];
  const devices = devRes.items || [];
  const online = devices.filter((d) => Number(d.online) === 1);
  const pool = online.length ? online : devices;
  let matched = null;
  // 优先：USB 描述符序列号(=MAC) 直查注册表 —— 识别"当前插着的这块板"
  const usbs = await usbInfo();
  const usb = usbs.find((u) => u.mac && pool.some((d) => d.device_id === u.mac)) || usbs.find((u) => u.mac);
  if (usb) {
    const dev = pool.find((d) => d.device_id === usb.mac);
    if (dev) {
      const model = (dev.model || '').trim();
      const hit = boards.find((b) => b.type === model || b.name === model);
      if (hit) matched = { board: hit, device: dev, via: 'usb-mac' };
    }
  }
  if (!matched) {
    for (const d of pool) {
      const model = (d.model || '').trim();
      if (!model) continue;
      const hit = boards.find((b) => b.type === model || b.name === model);
      if (hit) { matched = { board: hit, device: d, via: 'db-model' }; break; }
    }
  }
  const ports = usbs.map((u) => u.path).filter(Boolean);
  const allPorts = ports.length ? ports : listSerialPorts(cfg.serialGlob);
  let hint;
  if (matched && matched.via === 'usb-mac') {
    hint = `✓ USB 直连设备 MAC ${usb.mac}（序列号 ${usb.serial}，芯片 ${usb.product || '?'}）在注册表命中：${matched.device.model} → 板型 ${matched.board.type}`;
  } else if (usb && !matched) {
    hint = `USB 设备 MAC ${usb.mac || '?'}（${usb.product || '?'}）不在注册表（设备从未连过 OTA），无法映射板型，请手动选择`;
  } else if (matched) {
    hint = `未从 USB 识别到设备，按注册表最近记录匹配：${matched.device.device_id}（型号 ${matched.device.model}）→ ${matched.board.type}`;
  } else {
    hint = allPorts.length
      ? `未能匹配板型，检测到 ${allPorts.length} 个串口：${allPorts.join(', ')}，请手动选择板型`
      : '未检测到在线设备，也无可识别串口，请手动选择板型';
  }
  return { matched, ports: allPorts, usb: usb || null, hint };
}

/** 官方最新版本 + 该板型是否有预编译 zip（信息用途） */
export async function checkOfficial(cfg, boardType) {
  const rel = await fetchJson(`https://api.github.com/repos/${cfg.githubRepo}/releases/latest`);
  if (!rel) return { error: '无法访问 GitHub（离线？）', latest: null };
  const tag = (rel.tag_name || '').replace(/^v/, '');
  const assets = (rel.assets || []).map((a) => a.name);
  const zip = boardType ? assets.find((n) => n === `v${tag}_${boardType}.zip`) : null;
  return { latest: tag, url: rel.html_url, zipForBoard: zip || null, published: rel.published_at };
}

/** TCP 连通性探测（短超时） */
function tcpReachable(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = connect({ host, port, timeout: timeoutMs });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}
