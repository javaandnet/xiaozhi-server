import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * TTS 帧缓存：对"常用固定对话"（模式播报/欢迎/唤醒确认等）缓存最终 Opus 帧，
 * 命中后跳过 网络合成（Edge TTS）与 ffmpeg mp3->Opus 转换，实现零延迟、断网可播。
 *
 * 两级缓存：
 *  - 内存 LRU（maxEntries 条，进程内即时命中）
 *  - 磁盘 JSON（data/tts-cache/<key>.json，跨重启存活；文件数超 maxFiles 按 mtime 淘汰）
 *
 * 由 config.ttsCache 控制：{ enabled, dir, maxEntries, maxFiles }（默认启用）。
 * 仅缓存显式标记 cacheable 的播报（_speakFixed 链路），LLM 长回复不写入，避免污染。
 */
class TtsCache {
  constructor(config = {}) {
    this.enabled = config.enabled !== false;
    this.dir = config.dir || 'data/tts-cache';
    this.maxEntries = config.maxEntries || 200;
    this.maxFiles = config.maxFiles || 300;
    this.memory = new Map(); // key -> Buffer[]（Map 迭代序即 LRU：get/put 时 delete+set 提鲜）
    this.putCount = 0;
    this.dirReady = false;
  }

  /** 缓存键：sha256(voiceId|text) 前 32 位；voiceId 由调用方拼入 provider/voice/rate/volume */
  key(text, voiceId) {
    return crypto.createHash('sha256').update(`${voiceId}|${text}`, 'utf8').digest('hex').slice(0, 32);
  }

  fileFor(key) {
    return path.join(this.dir, `${key}.json`);
  }

  ensureDir() {
    if (this.dirReady) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.dirReady = true;
    } catch (e) {
      // dir failure degrades to memory-only cache, not fatal
      console.warn(`[TtsCache] cannot create cache dir ${this.dir}, memory-only: ${e.message}`);
    }
  }

  /**
   * 查缓存：内存 > 磁盘（读回后回填内存）
   * @param {string} text - 分段文本
   * @param {string} voiceId - 音色标识（provider|voice|rate|volume 拼串）
   * @returns {Buffer[]|null} Opus 帧数组，未命中返回 null
   */
  get(text, voiceId) {
    if (!this.enabled || !text) return null;
    const key = this.key(text, voiceId);
    if (this.memory.has(key)) {
      const frames = this.memory.get(key);
      this.memory.delete(key);
      this.memory.set(key, frames); // refresh LRU position
      return frames;
    }
    try {
      const file = this.fileFor(key);
      if (!fs.existsSync(file)) return null;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!data || data.text !== text || data.voiceId !== voiceId || !Array.isArray(data.frames)) {
        console.warn(`[TtsCache] corrupted or mismatched entry ${key}, ignored`);
        return null;
      }
      const frames = data.frames.map((b64) => Buffer.from(b64, 'base64'));
      this.remember(key, frames);
      return frames;
    } catch (e) {
      console.warn(`[TtsCache] disk read failed for ${key}: ${e.message}`);
      return null;
    }
  }

  /**
   * 写缓存（内存 + 磁盘）。帧转 base64 存 JSON，附带原文与音色便于校验与排查。
   * @param {string} text - 分段文本
   * @param {string} voiceId - 音色标识
   * @param {Buffer[]} frames - Opus 帧数组
   */
  put(text, voiceId, frames) {
    if (!this.enabled || !text || !Array.isArray(frames) || frames.length === 0) return;
    const key = this.key(text, voiceId);
    this.remember(key, frames);
    this.ensureDir();
    try {
      const payload = JSON.stringify({
        key, text, voiceId,
        frames: frames.map((f) => f.toString('base64')),
        createdAt: new Date().toISOString()
      });
      const file = this.fileFor(key);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, file); // atomic replace
      if (++this.putCount % 20 === 0) this.evictFiles();
    } catch (e) {
      console.warn(`[TtsCache] disk write failed for ${key}: ${e.message}`);
    }
  }

  /** 内存 LRU 维护：超限淘汰最旧条目 */
  remember(key, frames) {
    this.memory.delete(key);
    this.memory.set(key, frames);
    while (this.memory.size > this.maxEntries) {
      const oldest = this.memory.keys().next().value;
      this.memory.delete(oldest);
    }
  }

  /** 磁盘文件数淘汰：超过 maxFiles 时按 mtime 删最旧（每 20 次写入检查一遍） */
  evictFiles() {
    try {
      if (!fs.existsSync(this.dir)) return;
      const files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
      if (files.length <= this.maxFiles) return;
      const stat = files.map((f) => ({
        name: f,
        mtime: fs.statSync(path.join(this.dir, f)).mtimeMs
      })).sort((a, b) => a.mtime - b.mtime);
      const removeCount = files.length - this.maxFiles;
      for (const item of stat.slice(0, removeCount)) {
        fs.unlinkSync(path.join(this.dir, item.name));
      }
      console.log(`[TtsCache] evicted ${removeCount} oldest cache file(s)`);
    } catch (e) {
      console.warn(`[TtsCache] file eviction failed: ${e.message}`);
    }
  }
}

export default TtsCache;
