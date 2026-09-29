/**
 * 安装 / 烧录 / 源码同步（均含安全检查，危险操作需 confirm）
 */
import fs from 'fs';
import path from 'path';
import { run, shq } from './util.js';

/** 语义化版本比较：a>b 返回 1，a<b 返回 -1，相等 0 */
export function cmpVer(a, b) {
  const pa = String(a).match(/\d+/g)?.map(Number) || [];
  const pb = String(b).match(/\d+/g)?.map(Number) || [];
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** 列出 data/bin 里已安装固件（解析 {type}_{ver}.bin） */
export function listInstalled(cfg) {
  if (!fs.existsSync(cfg.dataBinDir)) return { items: [], dir: cfg.dataBinDir, missing: true };
  const items = fs.readdirSync(cfg.dataBinDir)
    .filter((f) => f.endsWith('.bin'))
    .map((f) => {
      const m = f.match(/^(.+?)_([0-9][A-Za-z0-9.\-_]*)\.bin$/);
      const st = fs.statSync(path.join(cfg.dataBinDir, f));
      return {
        filename: f,
        model: m ? m[1] : null,
        version: m ? m[2] : null,
        size: st.size,
        mtime: st.mtimeMs,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return { items, dir: cfg.dataBinDir };
}

/**
 * 安装（拷贝 app 镜像到 data/bin/{type}_{ver}.bin）
 * 目标已存在且版本相同/更高时需 confirm=true 才覆盖。
 */
export async function installFirmware(cfg, { source, model, version, confirm = false }) {
  if (!source || !fs.existsSync(source)) return { error: `源镜像不存在: ${source}` };
  if (!model || !version) return { error: '缺少 model / version' };
  if (!/^[A-Za-z0-9.\-_]+$/.test(`${model}_${version}`)) return { error: '型号/版本含非法字符' };

  fs.mkdirSync(cfg.dataBinDir, { recursive: true });
  const dest = path.join(cfg.dataBinDir, `${model}_${version}.bin`);

  // 安全检查 1：目标是否已存在同型号
  const existing = listInstalled(cfg).items.filter((i) => i.model === model);
  const sameOrNewer = existing.find((i) => cmpVer(i.version, version) >= 0);
  if ((fs.existsSync(dest) || sameOrNewer) && !confirm) {
    return {
      needConfirm: true,
      message: sameOrNewer
        ? `已存在同型号固件 ${sameOrNewer.filename}（版本 ${sameOrNewer.version} ≥ 目标 ${version}）。确认覆盖？`
        : `目标文件 ${path.basename(dest)} 已存在，确认覆盖？`,
      dest,
    };
  }
  fs.copyFileSync(source, dest);
  const st = fs.statSync(dest);
  return { ok: true, dest, size: st.size, model, version };
}

/**
 * 删除已安装固件（需 confirm）
 */
export function removeFirmware(cfg, { filename, confirm = false }) {
  if (!confirm) return { needConfirm: true, message: `确认删除 ${filename}？` };
  const safe = path.basename(filename);
  if (!/^[A-Za-z0-9.\-_]+\.bin$/.test(safe)) return { error: '文件名非法' };
  const p = path.join(cfg.dataBinDir, safe);
  const realDir = path.resolve(cfg.dataBinDir);
  if (!path.resolve(p).startsWith(realDir + path.sep)) return { error: 'forbidden' };
  if (!fs.existsSync(p)) return { error: '文件不存在' };
  fs.unlinkSync(p);
  return { ok: true };
}

/**
 * USB 直接烧录（危险：会改写设备固件，需 confirm）
 * 对当前已配置/编译的 build 目录执行 idf.py -p PORT flash。
 */
export async function flashUsb(cfg, { port, board, name, confirm = false }, onLine) {
  if (!confirm) return { needConfirm: true, message: 'USB 烧录会直接改写设备固件（有风险）。确认继续？' };
  if (!port) return { error: '未选择串口号' };
  if (!/^\/dev\/cu\./.test(port)) return { error: '串口路径非法' };
  const script = [
    'set -o pipefail',
    `export IDF_PYTHON_ENV_PATH=${shq(cfg.idfPythonEnv || (process.env.HOME + '/.espressif/python_env/idf6.1_py3.12_env'))}`,
    `source ${shq(cfg.idfExport)}`,
    `cd ${shq(cfg.repoDir)}`,
    `echo "[xz-studio] USB 烧录 → ${port}"`,
    `idf.py -p ${shq(port)} flash`,
  ].join('\n');
  const r = await run(script, { cwd: cfg.repoDir, timeoutMs: 600000, onLine });
  return { ok: r.code === 0, code: r.code };
}

/**
 * 同步源码（git pull / checkout tag，需 confirm）
 */
export async function syncSource(cfg, { ref, confirm = false }, onLine) {
  if (!confirm) {
    return { needConfirm: true, message: `将执行 git 拉取/切表（ref=${ref || 'pull'}），本地未提交改动可能被影响。确认？` };
  }
  const target = ref && ref.trim();
  const script = [
    'set -o pipefail',
    `cd ${shq(cfg.repoDir)}`,
    `git fetch --tags --all --prune`,
    target ? `git checkout ${shq(target)}` : `git pull --ff-only`,
    `git submodule update --init --recursive`,
    `sed -n 's/^set(PROJECT_VER "\\(.*\\)")/\\1/p' CMakeLists.txt | head -1 | sed 's/^/[xz-studio] PROJECT_VER=/'`,
  ].join('\n');
  const r = await run(script, { cwd: cfg.repoDir, timeoutMs: 300000, onLine });
  return { ok: r.code === 0, code: r.code };
}
