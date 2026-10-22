/**
 * HTTP transport for the console.
 *
 * Two backends sit behind one port:
 *   - studio API  (express router mounted at /firmware/api)  -> 'studio/xxx'
 *   - main service API (/api/xxx, /health)                    -> '/api/xxx'
 * On the cloud the whole app is served under the /xiaozhi namespace, so every
 * absolute path must carry that prefix (same rule as the legacy page).
 */
export const NS = location.pathname.startsWith('/xiaozhi') ? '/xiaozhi' : '';
export const CONSOLE_ROOT = `${NS}/firmware`;
export const APP_ROOT = `${CONSOLE_ROOT}/app`;

const LOGIN_URL = `${CONSOLE_ROOT}/login`;

/** Resolve an endpoint path to a same-origin URL. */
export function toUrl(path) {
  if (path.startsWith('studio/')) return `${CONSOLE_ROOT}/api/${path.slice('studio/'.length)}`;
  return path.startsWith('/') ? NS + path : path;
}

function gotoLogin() {
  const back = encodeURIComponent(location.pathname + location.search);
  location.href = `${LOGIN_URL}?redirect=${back}`;
}

async function request(path, init = {}, { authRedirect = true } = {}) {
  const resp = await fetch(toUrl(path), init);
  if (resp.status === 401) {
    if (authRedirect) gotoLogin();
    throw new Error('login required');
  }
  if (!resp.ok) {
    let detail = '';
    try {
      const body = await resp.json();
      detail = body.error || body.message || '';
    } catch {
      /* non-JSON error body: keep the status text */
    }
    throw new Error(`${resp.status} ${resp.statusText}${detail ? ` · ${detail}` : ''}`);
  }
  return resp;
}

export async function apiGet(path, opts) {
  const resp = await request(path, { method: 'GET' }, opts);
  return resp.json();
}

export async function apiPost(path, body, opts) {
  const resp = await request(
    path,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) },
    opts,
  );
  return resp.json();
}

export async function apiDelete(path, opts) {
  const resp = await request(path, { method: 'DELETE' }, opts);
  return resp.json();
}

/** Full URL of an endpoint, for things the browser fetches itself (EventSource, download). */
export function urlOf(path) {
  return toUrl(path);
}

/** POST that answers with a `data: {...}` line stream (sync / flash / build logs). */
export async function apiPostStream(path, body, onObj) {
  const resp = await request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  await readStream(resp, onObj);
}

export async function readStream(resp, onObj) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (raw.startsWith('data:')) {
        try {
          onObj(JSON.parse(raw.slice(5).trim()));
        } catch {
          /* ignore malformed heartbeat lines */
        }
      }
    }
  }
}
