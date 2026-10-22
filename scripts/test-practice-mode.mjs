#!/usr/bin/env node
// E2E check for speaking-practice mode (websocket.js mode gate).
// Run: node scripts/test-practice-mode.mjs
import WebSocketHandler from '../core/handlers/websocket.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- config mirroring the practice defaults in config.json ----
const config = {
  modeKeywords: {
    practiceOn: ['进入口语模式', 'practice speaking', 'スピーチ練習'],
    practiceOff: ['退出口语模式', 'end practice'],
    practiceEndManual: ['手动结束', 'manual end', '手動終了'],
    practiceEndAuto: ['自动结束', 'auto end', '自動終了'],
  },
  practice: { enabled: false, endMode: 'manual', silenceTimeoutMs: 200 },
};

// ---- stub llm: records calls, classifier verdict driven by verdicts[] ----
const makeLlm = () => ({
  calls: [],
  verdicts: [],
  isConfigured: () => true,
  config: { provider: 'openai' },
  async chat(historyKey, message, options = {}) {
    this.calls.push({ message, options });
    return { text: 'summary-reply' };
  },
  async classifyPracticeDone(text) {
    this.calls.push({ classifier: text });
    return this.verdicts.length ? this.verdicts.shift() : 'CONTINUE';
  },
});

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`PASS ${name}`);
  else { failures++; console.error(`FAIL ${name} ${extra}`); }
};

// build a handler + fake connection that satisfies handleConnection's event wiring
function setup(cfg = config) {
  const llm = makeLlm();
  const devices = [];
  const handler = new WebSocketHandler({ config: cfg, llmService: llm });
  handler.getDeviceManager = () => ({ getAllDevices: () => devices, addDevice: () => {} });
  handler.sendTtsAudio = async (ws, sessionId, text, turn) => {
    (ws._tts || (ws._tts = [])).push(text);
  };
  const conn = {
    readyState: 1,
    on: () => {},
    send: (s) => {
      const m = JSON.parse(s);
      (conn._msgs || (conn._msgs = [])).push(m);
    },
    close: () => {},
  };
  handler.handleConnection(conn, { headers: {}, url: '/?client_type=hard', socket: { remoteAddress: '127.0.0.1' } });
  conn.deviceId = `dev-${devices.length}`;
  devices.push({ deviceId: conn.deviceId, connection: conn });
  const send = (obj) => handler.handleMessage(conn, JSON.stringify(obj));
  const msgs = () => conn._msgs || [];
  return { handler, llm, conn, send, msgs };
}

// feed a recognized fragment text through the mode-gate convergence point.
// real recognition path (_handleSttResultDirectly) hands the gate the text and
// returns on interception; inject the same way to avoid the listen-detect auto
// echo, so each practice fragment produces exactly one stt display message.
const makeInjector = (handler, conn) => (text) => handler.handleCompleteChatMessage(conn, text);

// ============ Case 1: voice enter/exit + manual aggregation + stop finalize ============
{
  const { handler, llm, conn, send, msgs } = setup();
  const fragment = (text) => makeInjector(handler, conn)(text);

  await fragment('进入口语模式');
  await sleep(30);
  check('enter: practiceMode on', conn.practiceMode === true);
  check('enter: endMode default manual', conn.practiceEndMode === 'manual');
  check('enter: fixed prompt spoken', (conn._tts || []).some((t) => t.includes('口语')));
  check('enter: mode label practice', msgs().some((m) => m.type === 'mode' && m.text === '口语'));

  // fragments aggregate, zero llm calls
  await fragment('大家好，我叫小明');
  await fragment('我毕业于东京大学');
  check('manual: fragments aggregated', conn.practiceBuffer.length === 2 && llm.calls.length === 0,
    `buf=${conn.practiceBuffer.length} llm=${llm.calls.length}`);
  check('manual: stt display sent', msgs().filter((m) => m.type === 'stt').length === 2);

  // button: listen stop -> finalize with coach prompt
  await send({ type: 'listen', state: 'stop' });
  await sleep(50);
  const summary = llm.calls.find((c) => c.options?.practiceSummary);
  check('stop: summary round fired', !!summary && summary.message.includes('大家好') && summary.message.includes('东京大学'),
    JSON.stringify(summary && summary.message));
  check('stop: buffer cleared', conn.practiceBuffer.length === 0);
  check('stop: practice mode retained', conn.practiceMode === true);
  check('stop: skipModeGate set', summary && summary.options.skipModeGate === true);

  // switch end-mode via multilingual keyword (lowercase normalization)
  await fragment('Manual End');
  await sleep(30);
  check('kw: manual end (case-insensitive)', conn.practiceEndMode === 'manual');
  await fragment('auto end');
  await sleep(30);
  check('kw: auto end', conn.practiceEndMode === 'auto');
  await fragment('手動終了');
  await sleep(30);
  check('kw: ja manual end', conn.practiceEndMode === 'manual');
  await fragment('自動終了');
  await sleep(30);
  check('kw: ja auto end', conn.practiceEndMode === 'auto');

  // auto mode: CONTINUE aggregates, DONE finalizes
  llm.verdicts = ['CONTINUE', 'DONE'];
  const before = llm.calls.length;
  await fragment('我的自我介绍完毕');
  check('auto: classifier called per fragment', llm.calls.length === before + 1);
  await fragment('我说完了');
  await sleep(50);
  const doneSummary = llm.calls.find((c) => c.options?.practiceSummary && c !== summary);
  check('auto: DONE verdict finalizes', !!doneSummary && doneSummary.message.includes('自我介绍完毕'),
    JSON.stringify(doneSummary && doneSummary.message));

  // exit
  await fragment('退出口语模式');
  await sleep(30);
  check('exit: practiceMode off', conn.practiceMode === false && conn.practiceBuffer.length === 0);

  // regression: normal chat flows to llm without practice flags
  llm.calls = [];
  await fragment('今天天气如何');
  await sleep(30);
  const normal = llm.calls.find((c) => c.message === '今天天气如何');
  check('regression: normal chat passes gate', !!normal && !normal.options.practiceSummary);
}

// ============ Case 2: silence timeout sweep forces finalize + goodbye suppressed ============
{
  const { handler, llm, conn } = setup();
  conn.practiceMode = true;
  conn.practiceBuffer = ['残留讲述内容'];
  conn.practiceLastActiveAt = Date.now() - 5000; // > silenceTimeoutMs (200)
  await handler._checkIdleTimeout(conn, false);
  await sleep(80);
  check('sweep: silence timeout finalizes',
    llm.calls.some((c) => c.options?.practiceSummary && c.message.includes('残留讲述内容')));
  check('sweep: goodbye suppressed in practice',
    llm.calls.every((c) => !String(c.message).includes('时间过得真快')));
}

// ============ Case 3: global enabled -> connection starts in practice mode ============
{
  const { conn } = setup({ ...config, practice: { ...config.practice, enabled: true } });
  check('global: session born in practice mode', conn.practiceMode === true && conn.practiceEndMode === 'manual');
}

console.log(failures === 0 ? '\nALL PRACTICE-MODE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
