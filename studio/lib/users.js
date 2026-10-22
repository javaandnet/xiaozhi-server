/**
 * Console account store (JSON file under data/).
 * Bootstrap: the legacy single manage.password becomes the default `admin`
 * account on first run. Passwords are stored as scrypt(salt) hashes.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const now = () => Date.now();

function usersFile(cfg) { return path.join(cfg.manageDir, 'manage_users.json'); }
function secretFile(cfg) { return path.join(cfg.manageDir, 'manage_secret'); }

function readStore(cfg) {
  const f = usersFile(cfg);
  if (!fs.existsSync(f)) return { users: [] };
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    console.warn('[ManageUsers] store parse failed, starting empty:', e.message);
    return { users: [] };
  }
}
function writeStore(cfg, store) {
  const f = usersFile(cfg);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify(store, null, 2));
  fs.renameSync(f + '.tmp', f);
}

function hashPw(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString('hex') };
}

/** Auth is active once a bootstrap password is set or the user store exists */
export function authEnabled(cfg) {
  return Boolean(cfg.managePassword) || fs.existsSync(usersFile(cfg));
}

/** Signing secret for session tokens (random, persisted, survives restarts) */
export function getSecret(cfg) {
  const f = secretFile(cfg);
  if (!fs.existsSync(f)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'));
    console.log('[ManageUsers] signing secret generated');
  }
  return crypto.createHash('sha256').update(fs.readFileSync(f, 'utf8')).digest('hex');
}

/** Seed the default admin from the legacy manage.password if no admin exists */
export function ensureDefaultAdmin(cfg) {
  const store = readStore(cfg);
  if (!store.users.some((u) => u.role === 'admin')) {
    const pw = cfg.managePassword || 'admin';
    const { salt, hash } = hashPw(pw);
    store.users.push({
      username: 'admin', salt, hash, role: 'admin',
      created_at: now(), updated_at: now(), created_by: 'system', updated_by: 'system',
    });
    writeStore(cfg, store);
    console.log('[ManageUsers] default admin created');
  }
}

export function verifyUser(cfg, username, password) {
  const u = readStore(cfg).users.find((x) => x.username === username);
  if (!u) return false;
  const cand = crypto.scryptSync(String(password), u.salt, 64).toString('hex');
  return cand.length === u.hash.length && crypto.timingSafeEqual(Buffer.from(cand), Buffer.from(u.hash));
}

export function userExists(cfg, username) {
  return readStore(cfg).users.some((u) => u.username === username);
}

export function listUsers(cfg) {
  return readStore(cfg).users
    .map(({ salt, hash, ...rest }) => rest)
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
}

export function addUser(cfg, { username, password, role = 'admin', by }) {
  username = String(username || '').trim();
  if (!/^[A-Za-z0-9._\-]{2,32}$/.test(username)) return { error: '用户名需 2-32 位（字母/数字/._-）' };
  if (!password || String(password).length < 6) return { error: '密码至少 6 位' };
  if (role !== 'admin') return { error: '暂只支持 admin 角色' };
  const store = readStore(cfg);
  if (store.users.some((u) => u.username === username)) return { error: '用户名已存在' };
  const { salt, hash } = hashPw(password);
  store.users.push({
    username, salt, hash, role,
    created_at: now(), updated_at: now(), created_by: by || 'system', updated_by: by || 'system',
  });
  writeStore(cfg, store);
  console.log(`[ManageUsers] admin "${username}" added by "${by}"`);
  return { ok: true };
}

export function deleteUser(cfg, username, by) {
  const store = readStore(cfg);
  const target = store.users.find((u) => u.username === username);
  if (!target) return { error: '用户不存在' };
  if (username === by) return { error: '不能删除当前登录账号' };
  if (target.role === 'admin' && store.users.filter((u) => u.role === 'admin').length <= 1) {
    return { error: '必须保留至少一名管理员' };
  }
  store.users = store.users.filter((u) => u.username !== username);
  writeStore(cfg, store);
  console.log(`[ManageUsers] admin "${username}" deleted by "${by}"`);
  return { ok: true };
}

export function setPassword(cfg, username, password, by) {
  if (!password || String(password).length < 6) return { error: '密码至少 6 位' };
  const store = readStore(cfg);
  const target = store.users.find((u) => u.username === username);
  if (!target) return { error: '用户不存在' };
  const { salt, hash } = hashPw(password);
  target.salt = salt;
  target.hash = hash;
  target.updated_at = now();
  target.updated_by = by || 'system';
  writeStore(cfg, store);
  console.log(`[ManageUsers] password changed for "${username}" by "${by}"`);
  return { ok: true };
}
