#!/usr/bin/env node
// E2E check for idle-timeout -> rest mode (sleep) chain in websocket.js.
// Run: node scripts/test-idle-rest.mjs
import WebSocketHandler from '../core/handlers/websocket.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const config = {
  close_connection_no_voice_time: 1,
  modeKeywords: {
    restOn: ['进入休息模式', '休息吧'],
    restOff: ['退出休息模式'],
  },
};

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`PASS ${name}`);
  else { failures++; console.error(`FAIL ${name} ${extra}`); }
};

function setup() {
  const llmCalls = [];
  const llm = {
    isConfigured: () => true,
    config: { provider: 'openai' },
    async chat(historyKey, message, options = {}) {
      llmCalls.push(message);
      return { text: 'time-flies-farewell' };
    },
  };
  const restWrites = [];
  const store = {
    markDeviceRest: (deviceId, flag) => restWrites.push(`${deviceId}:${flag}`),
    getDeviceSettings: () => ({}),
    recordDevice: () => {},
  };
  const handler = new WebSocketHandler({ config, llmService: llm, store });
  handler.getDeviceManager = () => ({ getAllDevices: () => [], addDevice: () => {} });
  // 音频链路不在本检查范围：只记录合成请求，避免依赖真实 TTS/Opus
  handler.sendTtsAudio = async () => true;
  const conn = {
    readyState: 1,
    on: () => {},
    send: (s) => (conn._msgs || (conn._msgs = [])).push(JSON.parse(s)),
    close: () => {},
  };
  handler.handleConnection(conn, { headers: {}, url: '/?client_type=hard', socket: { remoteAddress: '127.0.0.1' } });
  conn.deviceId = 'dev-idle';
  conn.sessionId = 'S-1';
  const types = () => (conn._msgs || []).map((m) => m.type);
  return { handler, conn, llmCalls, restWrites, types };
}

// ============ Case 1: idle timeout says farewell then enters rest ============
{
  const { handler, conn, llmCalls, restWrites, types } = setup();
  conn.lastActivityTime = Date.now() - 5000;
  await handler._checkIdleTimeout(conn, false);
  await sleep(30);
  check('idle: farewell round fired', llmCalls.some((m) => m.includes('结束这场对话')));
  check('idle: restMode on', conn.restMode === true);
  check('idle: resting persisted', restWrites.includes('dev-idle:1'));
  check('idle: sleep command sent', types().includes('sleep'));
  check('idle: mode label switched to rest', (conn._msgs || []).some((m) => m.type === 'mode' && m.text === '休息'));
  check('idle: sleepy emotion pushed', (conn._msgs || []).some((m) => m.type === 'llm' && m.emotion === 'sleepy'));
  check('idle: idle clock reset', Date.now() - conn.lastActivityTime < 2000);

  // 休息态下再次巡检不得重复触发告别
  const before = llmCalls.length;
  conn.lastActivityTime = Date.now() - 5000;
  await handler._checkIdleTimeout(conn, false);
  await sleep(20);
  check('idle: no repeat farewell while resting', llmCalls.length === before);
}

// ============ Case 2: wake clears rest and resets the idle clock ============
{
  const { handler, conn } = setup();
  conn.restMode = true;
  conn.lastActivityTime = Date.now() - 60000;
  handler._clearRestDisplay(conn);
  check('wake: restMode off', conn.restMode === false);
  check('wake: clock reset so no instant farewell', Date.now() - conn.lastActivityTime < 1000);
  const msgsBefore = (conn._msgs || []).length;
  await handler._checkIdleTimeout(conn, false);
  await sleep(20);
  check('wake: first silent frame does not end the turn', (conn._msgs || []).length === msgsBefore);
}

// ============ Case 3: voice keyword rest-on keeps working ============
{
  const { handler, conn, types } = setup();
  await handler._handleModeGate(conn, '进入休息模式');
  check('keyword: restMode on', conn.restMode === true);
  check('keyword: sleep command sent', types().includes('sleep'));
}

// ============ Case 4: employee/voice-flow states are not auto-rested ============
{
  const { handler, conn, types } = setup();
  conn.employeeMode = true;
  conn.lastActivityTime = Date.now() - 5000;
  await handler._checkIdleTimeout(conn, false);
  await sleep(20);
  check('employee: idle flow untouched', conn.restMode !== true && !types().includes('sleep'));
  check('employee: clock kept alive', Date.now() - conn.lastActivityTime < 2000);
}
{
  const { handler, conn, types } = setup();
  conn.flowCollect = { url: 'http://127.0.0.1:3800/cb', sessionId: 'S-9', token: 't' };
  conn.lastActivityTime = Date.now() - 5000;
  await handler._checkIdleTimeout(conn, false);
  await sleep(20);
  check('voiceFlow: idle flow untouched', conn.restMode !== true && !types().includes('sleep'));
}

// ============ Case 5: goodbye intent path unchanged ============
{
  const { handler, conn, restWrites, types } = setup();
  const handled = await handler._handleIntent(conn, '再见');
  check('goodbye: handled', handled === true);
  check('goodbye: restMode on', conn.restMode === true && restWrites.includes('dev-idle:1'));
  check('goodbye: sleep command sent', types().includes('sleep'));
}

// ============ Case 6: already resting -> no repeated sleep/announcement ============
{
  const { handler, conn, restWrites, types } = setup();
  await handler._handleModeGate(conn, '进入休息模式');
  const sleepBefore = types().filter((t) => t === 'sleep').length;
  const writesBefore = restWrites.length;
  const msgsBefore = (conn._msgs || []).length;
  await handler._handleModeGate(conn, '休息吧');
  await handler._handleIntent(conn, '再见');
  await sleep(20);
  check('repeat: still one sleep command', types().filter((t) => t === 'sleep').length === sleepBefore);
  check('repeat: no extra resting write', restWrites.length === writesBefore);
  check('repeat: no extra downstream message', (conn._msgs || []).length === msgsBefore);
}
{
  const { handler, conn, types } = setup();
  conn.lastActivityTime = Date.now() - 5000;
  await handler._checkIdleTimeout(conn, false);
  await sleep(30);
  const sleepAfterFirst = types().filter((t) => t === 'sleep').length;
  // 模拟休眠后设备仍发帧（心跳/残帧）：巡检不得再走一遍休眠链路
  conn.lastActivityTime = Date.now() - 5000;
  await handler._checkIdleTimeout(conn, false);
  await sleep(20);
  check('repeat: idle sweep does not re-sleep', types().filter((t) => t === 'sleep').length === sleepAfterFirst);
}

// ============ Case 7: spoken-shell prefixes/suffixes still hit the keyword ============
{
  const { handler } = setup();
  const hit = (t) => handler._matchModeCommand(t);
  // 裸口令与带语气词/称呼前缀的自然说法等价
  check('shell: bare keyword', hit('进入休息模式') === 'rest-on');
  check('shell: leading filler', hit('好的，进入休息模式。') === 'rest-on');
  check('shell: 那…吧 combo', hit('那进入休息模式吧') === 'rest-on');
  check('shell: 请你…', hit('请你进入休息模式') === 'rest-on');
  check('shell: 我们…', hit('我们现在进入休息模式') === 'rest-on');
  check('shell: keyword itself ends with 语气词', hit('好的，休息吧') === 'rest-on');
  check('shell: exit keyword', hit('好的，退出休息模式。') === 'rest-off');
  // 剥离不得把提问/陈述句误判成口令（仍是全等口径，不是包含匹配）
  check('shell: question not matched', hit('进入休息模式怎么说') === null);
  check('shell: how-to not matched', hit('怎么进入休息模式') === null);
  check('shell: sentence with other intent not matched', hit('进入休息模式会怎么样呢') === null);
  check('shell: empty/none keyword', hit('今天天气不错') === null);
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL IDLE-REST CHECKS PASSED');
process.exit(failures ? 1 : 0);
