/**
 * 通用工具：配置加载、命令执行、shell 引号、SSE 广播
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** 展开 ~ 前缀 */
export function expandHome(p) {
  if (!p) return p;
  return p.replace(/^~(?=$|\/)/, os.homedir());
}

/** 读取 config.json 并允许环境变量覆盖关键路径 */
export function loadConfig() {
  const fileCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
  const cfg = { ...fileCfg, ROOT };
  const envMap = {
    port: ['XZS_PORT', Number],
    host: ['XZS_HOST', String],
    repoDir: ['XZS_REPO', String],
    idfExport: ['XZS_IDF_EXPORT', String],
    idfPython: ['XZS_IDF_PYTHON', String],
    dataBinDir: ['XZS_DATA_BIN', String],
    deviceDb: ['XZS_DEVICE_DB', String],
    otaUrl: ['XZS_OTA_URL', String],
  };
  for (const [key, [envKey, cast]] of Object.entries(envMap)) {
    if (process.env[envKey]) cfg[key] = cast(process.env[envKey]);
  }
  for (const k of ['idfExport', 'dataBinDir', 'deviceDb', 'repoDir']) {
    if (cfg[k]) cfg[k] = expandHome(cfg[k]);
  }
  return cfg;
}

/** 单引号包裹，安全传给 bash */
export function shq(v) {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

/**
 * 执行命令（经 bash -lc），返回 {code, signal, out, err}
 * onLine 逐行回调（合并 stdout+stderr），用于日志流。
 */
export function run(cmd, { cwd, onLine, timeoutMs, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', cmd], {
      cwd,
      env: { ...process.env, ...(env || {}) },
    });
    let out = '';
    let err = '';
    let buf = '';
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        err += `\n[xz-studio] 超时被终止 (${timeoutMs}ms)\n`;
      }, timeoutMs);
    }
    const onData = (chunk, sink) => {
      const s = chunk.toString();
      sink === 'out' ? (out += s) : (err += s);
      if (onLine) {
        buf += s;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          try { onLine(line); } catch { /* ignore */ }
        }
      }
    };
    child.stdout.on('data', (c) => onData(c, 'out'));
    child.stderr.on('data', (c) => onData(c, 'err'));
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (buf && onLine) { try { onLine(buf); } catch { /* ignore */ } buf = ''; }
      resolve({ code, signal, out, err });
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      err += `\n[xz-studio] 启动失败: ${e.message}\n`;
      resolve({ code: -1, signal: null, out, err });
    });
  });
}

/** 简单同步 JSON 抓取（GitHub API），失败返回 null */
export async function fetchJson(url, timeoutMs = 8000) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'xz-firmware-studio', Accept: 'application/vnd.github+json' },
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export const SSE = {
  clients: new Set(),
  add(res) { this.clients.add(res); res.on('close', () => this.clients.delete(res)); },
  send(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) { try { c.write(payload); } catch { /* ignore */ } }
  },
};
