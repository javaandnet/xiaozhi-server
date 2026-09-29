/**
 * Firmware Studio — config accessor.
 * Reads the `firmware` section from the project config.json so the whole
 * product (voice server + firmware workbench) shares ONE config file.
 * - dataBinDir defaults to THIS project's data/bin — the exact dir the OTA
 *   handler serves, so anything built/installed here is live immediately.
 * - deviceDb defaults to THIS project's xz.db (same as the running server,
 *   honoring XZ_DB_PATH), so auto-detect reads the real connected devices.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const cfgPath = process.env.XZ_CONFIG || path.join(root, 'config.json');
let fw = {};
try {
  fw = JSON.parse(readFileSync(cfgPath, 'utf8')).firmware || {};
} catch {
  fw = {};
}

// 从主 config 的 llm/stt 段派生依赖服务探活目标（改配置即自动跟随）
let mainCfg = {};
try { mainCfg = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch { mainCfg = {}; }

export const studioConfig = {
  repoDir: fw.repoDir || '/Users/fengleiren/git/xiaozhi-esp32',
  idfExport: fw.idfExport || path.join(process.env.HOME || '', 'esp/esp-idf/export.sh'),
  idfPython: fw.idfPython || '',
  idfPythonEnv: fw.idfPythonEnv || (process.env.HOME + '/.espressif/python_env/idf6.1_py3.12_env'),
  githubRepo: fw.githubRepo || '78/xiaozhi-esp32',
  dataBinDir: process.env.XZ_DATA_BIN || fw.dataBinDir || path.join(root, 'data', 'bin'),
  deviceDb: process.env.XZ_DB_PATH || fw.deviceDb || path.join(root, 'data', 'xz.db'),
  serialGlob: fw.serialGlob || '/dev/cu.usb*',
  otaUrl: fw.otaUrl || 'http://192.168.1.55:8003/xiaozhi/ota/',
  otaUrlFallback: fw.otaUrlFallback || '',
  buildTimeoutMs: Number(fw.buildTimeoutMs) || 1800000,
  serviceChecks: {
    llmUrl: (mainCfg.llm && mainCfg.llm.baseUrl || 'http://127.0.0.1:3300/v1').replace(/\/$/, '') + '/models',
    sttHost: (mainCfg.stt && mainCfg.stt.funasr && mainCfg.stt.funasr.host) || 'localhost',
    sttPort: Number(mainCfg.stt && mainCfg.stt.funasr && mainCfg.stt.funasr.port) || 10096,
  },
};
