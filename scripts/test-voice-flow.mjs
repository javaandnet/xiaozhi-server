#!/usr/bin/env node
// Injection-style check for the voice-flow I/O primitives (websocket.js).
// Validates the flow-agnostic "answer collector": startVoiceFlow/closeVoiceFlow
// drive the reused practice aggregation, and _finalizePracticeTurn posts the
// joined transcript to the controller callback INSTEAD of the coach summary.
// Run: node scripts/test-voice-flow.mjs
import WebSocketHandler from '../core/handlers/websocket.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const config = {
  modeKeywords: {
    practiceOn: ['进入口语模式'],
    practiceOff: ['退出口语模式'],
  },
  practice: { enabled: false, endMode: 'manual', silenceTimeoutMs: 200 },
  voiceFlow: { token: 'shared-secret', callbackAllowList: ['127.0.0.1', '.example.com'] },
};

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`PASS ${name}`);
  else { failures++; console.error(`FAIL ${name} ${extra}`); }
};

// stub llm: coach-summary + auto DONE classifier, records calls
const makeLlm = () => ({
  calls: [],
  verdicts: [],
  isConfigured: () => true,
  config: { provider: 'openai' },
  async chat(historyKey, message, options = {}) {
    this.calls.push({ message, options });
    return { text: 'coach-summary-reply' };
  },
  async classifyPracticeDone(text) {
    this.calls.push({ classifier: text });
    return this.verdicts.length ? this.verdicts.shift() : 'CONTINUE';
  },
});

// capture callback POSTs (xiaozhi -> controller)
function stubFetch() {
  const captured = [];
  globalThis.fetch = async (url, opts = {}) => {
    captured.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, async json() { return {}; } };
  };
  return captured;
}

function setup(cfg = config) {
  const llm = makeLlm();
  const devices = [];
  const handler = new WebSocketHandler({ config: cfg, llmService: llm });
  handler.getDeviceManager = () => ({ getAllDevices: () => devices, addDevice: () => {} });
  handler.sendTtsAudio = async (ws, sessionId, text) => { (ws._tts || (ws._tts = [])).push(text); };
  const conn = {
    readyState: 1,
    on: () => {},
    send: (s) => { const m = JSON.parse(s); (conn._msgs || (conn._msgs = [])).push(m); },
    close: () => {},
  };
  handler.handleConnection(conn, { headers: {}, url: '/?client_type=hard', socket: { remoteAddress: '127.0.0.1' } });
  conn.deviceId = `dev-${devices.length}`;
  devices.push({ deviceId: conn.deviceId, clientId: conn.deviceId, connection: conn });
  const send = (obj) => handler.handleMessage(conn, JSON.stringify(obj));
  const fragment = (text) => handler.handleCompleteChatMessage(conn, text);
  return { handler, llm, conn, devices, send, fragment };
}

// ============ Case 1: manual collect -> button stop posts transcript (no coach) ============
{
  const captured = stubFetch();
  const { handler, llm, conn, send, fragment } = setup();

  const applied = handler.startVoiceFlow({
    deviceId: conn.deviceId, endOn: 'button',
    callbackUrl: 'http://127.0.0.1:3800/api/xiaozhi/callback', sessionId: 'S-1',
  });
  check('start: applied to 1 session', applied === 1, `applied=${applied}`);
  check('start: collector mode on (reuses practiceMode)', conn.practiceMode === true && conn.practiceEndMode === 'manual');
  check('start: flowCollect carries callback+token', conn.flowCollect && conn.flowCollect.url && conn.flowCollect.token === 'shared-secret');

  await fragment('我负责后端服务',);
  await fragment('用 Node 和 Spring 各三年');
  check('collect: fragments aggregated', conn.practiceBuffer.length === 2);
  check('collect: zero llm while gathering', llm.calls.length === 0, `llm=${llm.calls.length}`);

  await send({ type: 'listen', state: 'stop' });
  await sleep(40);
  check('stop: exactly one callback fired', captured.length === 1, `n=${captured.length}`);
  const cb = captured[0];
  check('stop: transcript = joined fragments', cb && cb.body.transcript.includes('我负责后端服务') && cb.body.transcript.includes('Spring'),
    JSON.stringify(cb && cb.body));
  check('stop: sessionId echoed back', cb && cb.body.sessionId === 'S-1');
  check('stop: X-Xiaozhi-Key header set', cb && /X-Xiaozhi-Key/i.test(JSON.stringify(cb.opts.headers)) && cb.opts.headers['X-Xiaozhi-Key'] === 'shared-secret');
  check('stop: NO coach summary round', llm.calls.every((c) => !c.options?.practiceSummary));
  check('stop: buffer cleared, collector stays ready', conn.practiceBuffer.length === 0 && conn.practiceMode === true);

  handler.closeVoiceFlow({ deviceId: conn.deviceId });
  check('close: collector off + flowCollect cleared', conn.practiceMode === false && conn.flowCollect === null);
}

// ============ Case 2: auto collect -> DONE classifier posts transcript ============
{
  const captured = stubFetch();
  const { handler, llm, conn, fragment } = setup();
  handler.startVoiceFlow({ deviceId: conn.deviceId, endOn: 'auto', callbackUrl: 'http://127.0.0.1:30005/api/xiaozhi/callback', sessionId: 'S-2' });
  check('auto: collector endMode auto', conn.practiceEndMode === 'auto');

  llm.verdicts = ['CONTINUE', 'DONE'];
  await fragment('第一段作答');
  check('auto: CONTINUE keeps gathering (no callback)', captured.length === 0 && conn.practiceBuffer.length === 1);
  await fragment('第二段作答');
  await sleep(40);
  check('auto: DONE posts one callback', captured.length === 1, `n=${captured.length}`);
  check('auto: transcript joins both fragments', captured[0] && captured[0].body.transcript.includes('第一段') && captured[0].body.transcript.includes('第二段'));
  check('auto: no coach summary fired', llm.calls.every((c) => !c.options?.practiceSummary));
}

// ============ Case 3: empty collector stop still notifies controller (re-ask path) ============
{
  const captured = stubFetch();
  const { handler, conn, send } = setup();
  handler.startVoiceFlow({ deviceId: conn.deviceId, endOn: 'button', callbackUrl: 'http://127.0.0.1:3800/cb', sessionId: 'S-3' });
  await send({ type: 'listen', state: 'stop' });
  await sleep(30);
  check('empty: one callback with empty transcript', captured.length === 1 && captured[0].body.transcript === '',
    `n=${captured.length}`);
  check('empty: no coach prompt spoken', (conn._tts || []).length === 0);
}

// ============ Case 4: regression - plain practice mode still runs coach summary ============
{
  const captured = stubFetch();
  const { handler, llm, conn, send, fragment } = setup();
  await fragment('进入口语模式'); // voice enter, no flowCollect
  await sleep(20);
  check('regression: coach mode entered (no flowCollect)', conn.practiceMode === true && !conn.flowCollect);
  await fragment('这是纯口语练习的一段讲述');
  await send({ type: 'listen', state: 'stop' });
  await sleep(40);
  check('regression: coach summary fires', llm.calls.some((c) => c.options?.practiceSummary && c.message.includes('纯口语练习')));
  check('regression: no controller callback in coach mode', captured.length === 0);
}

console.log(failures === 0 ? '\nALL VOICE-FLOW CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
