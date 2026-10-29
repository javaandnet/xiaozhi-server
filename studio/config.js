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
  manageDir: fw.manageDir || path.join(root, 'data'),
  deviceDb: process.env.XZ_DB_PATH || fw.deviceDb || path.join(root, 'data', 'xz.db'),
  serialGlob: fw.serialGlob || '/dev/cu.usb*',
  otaUrl: fw.otaUrl || 'http://192.168.1.55:8003/xiaozhi/ota/',
  otaUrlFallback: fw.otaUrlFallback || '',
  buildTimeoutMs: Number(fw.buildTimeoutMs) || 1800000,
  // MasterPi (option A): SSH target for the studio "连接设定" page to patch the
  // Pi's local config.json server block and restart the systemd client.
  masterpi: {
    host: (fw.masterpi && fw.masterpi.host) || '192.168.1.91',
    user: (fw.masterpi && fw.masterpi.user) || 'pi',
    remoteConfig: (fw.masterpi && fw.masterpi.remoteConfig) || '~/masterpi_client/config.json',
    clientService: (fw.masterpi && fw.masterpi.clientService) || 'masterpi-client',
    configPort: Number(fw.masterpi && fw.masterpi.configPort) || 8010,
    streamPort: Number(fw.masterpi && fw.masterpi.streamPort) || 8110,
    // Watch announce settings: persisted at the TOP-level masterpi.watch of
    // config.json (peerRoutes POST writes there); also honor firmware.masterpi.watch.
    // Without this the home-side poller would never start after a cold restart.
    watch: (mainCfg.masterpi && mainCfg.masterpi.watch)
      || (fw.masterpi && fw.masterpi.watch) || null,
  },
  serviceChecks: {
    llmUrl: (mainCfg.llm && mainCfg.llm.baseUrl || 'http://127.0.0.1:3300/v1').replace(/\/$/, '') + '/models',
    sttHost: (mainCfg.stt && mainCfg.stt.funasr && mainCfg.stt.funasr.host) || 'localhost',
    sttPort: Number(mainCfg.stt && mainCfg.stt.funasr && mainCfg.stt.funasr.port) || 10096,
  },
  // Console login brute-force guard overrides (config.json manage.loginGuard):
  // { maxFails, windowMs, lockMs } — omit to use routes.js defaults (5 / 10min / 15min)
  loginGuard: (mainCfg.manage && mainCfg.manage.loginGuard) || null,
};
