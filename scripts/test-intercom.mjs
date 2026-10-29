#!/usr/bin/env node
// E2E check for intercom passthrough mode (websocket.js + intercomService).
// Run: node scripts/test-intercom.mjs
import WebSocketHandler from '../core/handlers/websocket.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const config = {
  language: { default: 'zh' },
  modeKeywords: {
    intercomOn: ['进入对讲模式', '对讲模式'],
    intercomOff: ['退出对讲模式', '结束对讲'],
    intercomCall: ['呼叫', '对讲'],
    restOff: ['退出休息模式'],
  },
  intercom: { enabled: true, silenceReleaseMs: 400, maxFloorMs: 3000, tailGraceMs: 60, releaseGraceMs: 80, idleExitMs: 600 },
};

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`PASS ${name}`);
  else { failures++; console.error(`FAIL ${name} ${extra}`); }
};

// fake device connection: JSON msgs -> _msgs, binary frames -> _bin
const makeConn = () => {
  const conn = {
    readyState: 1,
    on: () => {},
    send: (s) => {
      if (typeof s === 'string') (conn._msgs || (conn._msgs = [])).push(JSON.parse(s));
      else (conn._bin || (conn._bin = [])).push(s);
    },
    close: () => {},
  };
  conn.msgs = () => conn._msgs || [];
  conn.bin = () => conn._bin || [];
  return conn;
};

// two online devices A/B; persona names drive intercom peer resolution
function setup(cfg = config) {
  const devices = [];
  const handler = new WebSocketHandler({ config: cfg });
  handler.getDeviceManager = () => ({ getAllDevices: () => devices, addDevice: () => {}, removeDevice: () => {}, getDevice: (id) => devices.find((d) => d.clientId === id) });
  handler.sessionManager = { createSession: () => ({ sessionId: `sess-${Math.random().toString(36).slice(2, 8)}` }), closeSession: () => {} };
  handler.sendTtsAudio = async (ws, sessionId, text) => { (ws._tts || (ws._tts = [])).push(text); return true; };

  const mkDevice = (tag, settings) => {
    const conn = makeConn();
    conn.deviceId = `dev-${tag}`;
    conn.deviceSettings = settings;
    handler.handleConnection(conn, { headers: { 'device-id': `dev-${tag}` }, url: '/?client_type=hard', socket: { remoteAddress: '127.0.0.1' } });
    conn.deviceId = `dev-${tag}`;
    conn.deviceSettings = settings;
    devices.push({ deviceId: conn.deviceId, clientId: conn.clientId, connection: conn });
    conn.sendJson = (obj) => handler.handleMessage(conn, JSON.stringify(obj));
    conn.tts = () => conn._tts || [];
    return conn;
  };
  const a = mkDevice('a', { persona: { name: '一号' }, intercom: { peer: '二号' } });
  const b = mkDevice('b', { persona: { name: '二号' }, intercom: { peer: '一号' } });
  // hello both (server echoes audio_params; hello marks devices resting -> clear for chat-path tests)
  for (const c of [a, b]) {
    c.sendJson({ type: 'hello', version: 1, transport: 'websocket', audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 } });
    c.restMode = false;
  }
  const say = (conn, text) => handler.handleCompleteChatMessage(conn, text);
  return { handler, a, b, say, devices };
}

// ============ Case 1: enter by keyword (peer from settings) + full PTT round + exit ============
{
  const { handler, a, b, say } = setup();

  await say(a, '进入对讲模式');
  check('enter: intercomMode on A', a.intercomMode === true);
  check('enter: peer bound to B', a.intercomPeerClientId === b.clientId);
  check('enter: mode label 对讲', a.msgs().some((m) => m.type === 'mode' && m.text === '对讲'));
  check('enter: fixed prompt spoken', a.tts().some((t) => t.includes('对讲')));

  // PTT press: A hold-to-talk
  a.sendJson({ type: 'listen', state: 'start', mode: 'manual' });
  const f1 = Buffer.from([0x01, 0x02]);
  const f2 = Buffer.from([0x03, 0x04]);
  await handler.handleBinaryData(a, f1);
  await handler.handleBinaryData(a, f2);
  check('stream: B got tts start', b.msgs().some((m) => m.type === 'tts' && m.state === 'start'));
  check('stream: B receives raw frames', b.bin().length === 2 && b.bin()[0] === f1 && b.bin()[1] === f2);
  check('stream: B mic gate up', b.intercomIncoming === true);

  // receiver frames must be dropped (loop guard)
  await handler.handleBinaryData(b, Buffer.from([0x99]));
  check('guard: receiver frames dropped, not relayed to A', a.bin().length === 0);

  // release
  a.sendJson({ type: 'listen', state: 'stop', mode: 'manual' });
  await sleep(150);
  check('end: B got tts stop with listen:disable', b.msgs().some((m) => m.type === 'tts' && m.state === 'stop' && m.listen === 'disable'));
  check('end: B gate released', b.intercomIncoming === false);
  const room = handler.intercomService.byClient.get(a.clientId);
  check('end: floor released', room && room.floor === null);

  // voice exit switches back to chat
  await say(a, '退出对讲模式');
  check('exit: A left intercom', a.intercomMode === false);
  check('exit: room torn down', !handler.intercomService.byClient.has(a.clientId) && !handler.intercomService.byClient.has(b.clientId));
  check('exit: mode label back to chat', a.msgs().filter((m) => m.type === 'mode').at(-1)?.text === '聊天');
}

// ============ Case 2: "呼叫+人设名" dialing ============
{
  const { handler, a, b, say } = setup();
  await say(a, '呼叫小智二号'); // tail "小智二号" != persona "二号" -> no peer match, refused
  check('call: unmatched persona keeps A out of mode', !a.intercomMode);
  await say(a, '呼叫二号');
  check('call: A entered with peer B', a.intercomMode === true && a.intercomPeerClientId === b.clientId);
  check('call: callee B auto-joined', b.intercomMode === true && b.intercomPeerClientId === a.clientId);
  // A presses & streams: B receives
  a.sendJson({ type: 'listen', state: 'start', mode: 'manual' });
  await handler.handleBinaryData(a, Buffer.from([0x0a]));
  check('call: peer receives frames', b.bin().length === 1 && b.intercomIncoming === true);
  a.sendJson({ type: 'listen', state: 'stop', mode: 'manual' });
  await sleep(150);
  check('call: peer released', b.intercomIncoming === false);
  // auto-joined callee can talk back
  b.sendJson({ type: 'listen', state: 'start', mode: 'manual' });
  await handler.handleBinaryData(b, Buffer.from([0x0b]));
  check('call: callee talks back, A receives', a.bin().length === 1 && a.intercomIncoming === true);
  b.sendJson({ type: 'listen', state: 'stop', mode: 'manual' });
  await sleep(150);
}

// ============ Case 3: floor arbitration (busy) + off-floor swallow ============
{
  const { handler, a, b, say } = setup();
  await say(a, '对讲模式');
  // A grabs floor and streams
  a.sendJson({ type: 'listen', state: 'start', mode: 'manual' });
  await handler.handleBinaryData(a, Buffer.from([0x01]));
  // B presses while A holds floor -> rejected with busy notice
  b.sendJson({ type: 'listen', state: 'start', mode: 'manual' });
  const busyNotice = b.msgs().some((m) => m.type === 'tts' && m.state === 'sentence_start' && (m.text || '').includes('对方正在讲话'));
  check('busy: B got busy notice', busyNotice);
  // B is receiver (intercomIncoming) so its frames are gate-dropped before passthrough branch
  await handler.handleBinaryData(b, Buffer.from([0x02]));
  check('busy: B frames not relayed to A', a.bin().length === 0);
  // after A release + grace, B pressing now wins the floor
  a.sendJson({ type: 'listen', state: 'stop', mode: 'manual' });
  await sleep(150);
  b.sendJson({ type: 'listen', state: 'start', mode: 'manual' });
  await handler.handleBinaryData(b, Buffer.from([0x03]));
  check('swap: B takes floor next turn', a.bin().length === 1 && a.intercomIncoming === true);
  b.sendJson({ type: 'listen', state: 'stop', mode: 'manual' });
  await sleep(150);
  check('swap: released after B turn', a.intercomIncoming === false);
}

// ============ Case 4: silence timeout auto-release + idle exit + disconnect teardown ============
{
  const { handler, a, b, say } = setup();
  await say(a, '对讲模式');
  a.sendJson({ type: 'listen', state: 'start', mode: 'manual' });
  await handler.handleBinaryData(a, Buffer.from([0x01]));
  await sleep(config.intercom.silenceReleaseMs + 150); // no further frames -> forced release
  check('silence: stream auto-ended, B got stop', b.msgs().some((m) => m.type === 'tts' && m.state === 'stop'));
  check('silence: B gate released', b.intercomIncoming === false);

  // idle exit: no activity for idleExitMs
  await sleep(config.intercom.idleExitMs + 200);
  check('idle: silent exit after timeout', a.intercomMode === false && !handler.intercomService.byClient.has(a.clientId));

  // disconnect teardown while streaming
  await say(a, '对讲模式');
  a.sendJson({ type: 'listen', state: 'start', mode: 'manual' });
  await handler.handleBinaryData(a, Buffer.from([0x01]));
  a.readyState = 0;
  handler.handleDisconnect(a);
  check('disconnect: room torn down', !handler.intercomService.byClient.has(b.clientId) && b.intercomIncoming === false);
}

// ============ Case 5: call to offline peer is refused ============
{
  const { handler, a, b, say } = setup();
  b.readyState = 3; // connection closed
  await say(a, '呼叫二号');
  check('offline: enter refused', a.intercomMode !== true);
  check('offline: peer-offline prompt spoken', a.tts().some((t) => t.includes('不在线')));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
