// Development-mode mock helpers.
//
// Purpose: allow exercising the full STT -> LLM -> TTS round-trip without
// touching any external service (no ASR/LLM/TTS network calls, no ffmpeg),
// to save bandwidth and iteration time.
//
// Two levels of control (see config.json -> devMode):
//   - master switch: devMode.enabled (or env XIAOZHI_DEV_MODE=1) mocks the
//     selected segments at once;
//   - per-segment: with the master off, a segment is still mocked when its
//     own provider is set to "mock" (stt.provider / llm.provider / tts.provider).
import fs from 'fs';
import path from 'path';

const DEFAULT_STT_TEXTS = ['这是一条开发模式测试语音'];
const DEFAULT_LLM_REPLY = '（开发模式）已收到你的话，这是固定回复。';
const DEFAULT_OPUS_FILE = 'data/mock/fixed_reply.opus.json';

/**
 * Resolve which segments should run in mock mode.
 * @param {Object} config - root config (with devMode + stt/llm/tts sections)
 * @returns {{master:boolean, stt:boolean, llm:boolean, tts:boolean, dev:Object}}
 */
export function resolveMockFlags(config) {
  const dev = (config && config.devMode) || {};
  const envOn = process.env.XIAOZHI_DEV_MODE === '1';
  const master = !!(dev.enabled || envOn);
  const segMock = (seg) => {
    if (master) return dev[seg] !== false;            // master on: mock unless explicitly disabled
    return !!(config[seg] && config[seg].provider === 'mock'); // master off: honor provider=mock
  };
  return { master, stt: segMock('stt'), llm: segMock('llm'), tts: segMock('tts'), dev };
}

/**
 * Mock LLM fixed reply text.
 * @param {Object} config - root config (or the attached mock payload)
 * @returns {string}
 */
export function mockLlmReply(mock) {
  return (mock && mock.llmReply) || DEFAULT_LLM_REPLY;
}

// Cache the decoded opus frames so the JSON asset is read from disk only once.
let opusFrameCache; // undefined = not loaded yet; null = unavailable; Array = frames

/**
 * Load pre-baked opus frames (base64 array in a JSON file) for mock TTS.
 * Returns null when the asset is missing/invalid, so the caller can fall back
 * to a text-only TTS notice instead of crashing.
 * @param {string} relPath - path relative to project root (or absolute)
 * @returns {Buffer[]|null}
 */
export function loadMockOpusFrames(relPath) {
  if (opusFrameCache !== undefined) {
    return opusFrameCache;
  }
  const file = path.isAbsolute(relPath || '') ? relPath : path.join(process.cwd(), relPath || DEFAULT_OPUS_FILE);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const frames = Array.isArray(raw.frames) ? raw.frames.map((b64) => Buffer.from(b64, 'base64')) : [];
    if (frames.length === 0) {
      console.warn(`[devMode] mock opus asset has no frames (${file}); TTS mock will send text-only notice`);
      opusFrameCache = null;
    } else {
      console.log(`[devMode] loaded ${frames.length} mock opus frames from ${file}`);
      opusFrameCache = frames;
    }
  } catch (error) {
    console.warn(`[devMode] mock opus asset unavailable (${file}): ${error.message}; TTS mock will send text-only notice`);
    opusFrameCache = null;
  }
  return opusFrameCache;
}

export const MOCK_DEFAULTS = { DEFAULT_STT_TEXTS, DEFAULT_LLM_REPLY, DEFAULT_OPUS_FILE };
