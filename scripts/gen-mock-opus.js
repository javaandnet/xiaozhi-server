// One-time generator for the dev-mode mock TTS asset.
//
// It synthesizes a fixed phrase with Edge TTS (the ONLY step that needs the
// network), encodes it into Opus frames (needs ffmpeg), and writes them as a
// base64 JSON array to data/mock/fixed_reply.opus.json. After this runs once,
// dev-mode TTS mock replays these frames with zero external calls / no ffmpeg.
//
// Usage:
//   node scripts/gen-mock-opus.js ["要合成的固定文字"]
//   -> writes data/mock/fixed_reply.opus.json
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { audioConverter } from '../core/utils/audioConverter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const text = process.argv[2] || '好的，这是开发模式的固定回复，用于验证整条链路。';
const voice = process.env.MOCK_TTS_VOICE || 'zh-CN-XiaoxiaoNeural';
const outFile = path.join(ROOT, 'data', 'mock', 'fixed_reply.opus.json');

async function main() {
  console.log(`[gen-mock-opus] synthesizing with edge TTS: voice=${voice}`);
  const { EdgeTTS } = await import('node-edge-tts');
  const tts = new EdgeTTS({ voice, rate: '+0%', volume: '+0%' });
  const mp3Path = path.join(os.tmpdir(), `mock-opus-${Date.now()}.mp3`);
  await tts.ttsPromise(text, mp3Path);
  const mp3 = fs.readFileSync(mp3Path);
  fs.unlinkSync(mp3Path);
  console.log(`[gen-mock-opus] mp3 ${mp3.length} bytes -> encoding opus frames`);

  const frames = await audioConverter.mp3ToOpusFrames(mp3);
  if (!frames || frames.length === 0) {
    throw new Error('no opus frames produced (is ffmpeg installed?)');
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const payload = {
    text,
    voice,
    sampleRate: 16000,
    channels: 1,
    createdAt: new Date().toISOString(),
    frames: frames.map((f) => Buffer.from(f).toString('base64'))
  };
  fs.writeFileSync(outFile, JSON.stringify(payload));
  console.log(`[gen-mock-opus] wrote ${frames.length} frames to ${outFile}`);
}

main().catch((err) => {
  console.error(`[gen-mock-opus] failed: ${err.message}`);
  process.exit(1);
});
