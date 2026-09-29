/**
 * 自包含 logger（standalone 版）——不再依赖 galaclaw 的 moduleLogger。
 * 输出：console + 可选文件（XZ_LOG_DIR，默认 ./logs/server.log）。
 * 兼容两种调用面：
 *   - logger.info/warn/error/debug/verbose(message, meta)
 *   - channelLogger.logModuleInit/logModuleStart/logModuleStop/logOperation/logModuleError
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = process.env.XZ_LOG_DIR || path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }

const LEVELS = { verbose: 5, debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[(process.env.XZ_LOG_LEVEL || 'info').toLowerCase()] ?? 20;
const TO_FILE = (process.env.XZ_LOG_TO_FILE || '1') !== '0';

function safe(o) {
  if (o === undefined || o === null || o === '') return '';
  if (typeof o === 'string') return o;
  try { return JSON.stringify(o); } catch { return String(o); }
}

function write(level, message, meta) {
  if ((LEVELS[level] ?? 20) < MIN) return;
  const ts = new Date().toISOString();
  const extra = meta ? ` | ${safe(meta)}` : '';
  const line = `[${ts}] [${level.toUpperCase()}] ${message}${extra}`;
  if (level === 'error') console.error(line); else console.log(line);
  if (TO_FILE) { try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* ignore */ } }
}

export const logger = {
  verbose: (m, x) => write('verbose', m, x),
  debug:   (m, x) => write('debug', m, x),
  info:    (m, x) => write('info', m, x),
  warn:    (m, x) => write('warn', m, x),
  error:   (m, x) => write('error', m, x),
};

export const channelLogger = {
  ...logger,
  logModuleInit:   (x = {}) => write('info', `模块初始化: ${x.component || x.module || ''}`, x),
  logModuleStart:  (x = {}) => write('info', `模块启动: ${x.component || x.module || ''}`, x),
  logModuleStop:   (x = {}) => write('info', `模块停止: ${x.component || x.module || ''}`, x),
  logOperation:    (m, x)   => write('info', m, x),
  logModuleError:  (err, m, x = {}) => write('error', `${m || '模块错误'}: ${err && err.message ? err.message : err}`, { ...x, stack: err && err.stack }),
};

export default logger;
