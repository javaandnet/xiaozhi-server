/**
 * Xiaozhi Channel Constants
 * 频道相关的常量定义（从config.json动态加载）
 */

import { getChannelInfo, getServerConfig, getSttConfig, getTtsConfig, getLlmConfig } from './loader.js';

// 从配置文件动态获取频道信息
const channelInfo = getChannelInfo();
const serverConfig = getServerConfig();
const sttConfig = getSttConfig();
const ttsConfig = getTtsConfig();
const llmConfig = getLlmConfig();

// 频道标识
export const CHANNEL_ID = channelInfo.id;

// 服务器配置
export const DEFAULT_CONFIG = {
  port: serverConfig.port,
  host: serverConfig.host,
  environment: serverConfig.environment
};

// 服务提供商配置（从config.json读取）
export const DEFAULT_SERVICES = {
  llm: {
    provider: llmConfig.provider,
    model: llmConfig.model,
    temperature: llmConfig.temperature || 0.7,
    maxTokens: llmConfig.maxTokens || 500
  },
  tts: {
    provider: ttsConfig.provider,
    voice: ttsConfig.voice
  },
  stt: {
    provider: sttConfig.provider,
    language: sttConfig.language,
    sampleRate: sttConfig.sampleRate || 16000
  }
};

// 消息类型枚举
export const MESSAGE_TYPES = {
  HELLO: 'hello',
  LISTEN: 'listen',
  ABORT: 'abort',
  IOT: 'iot',
  CHAT: 'chat',
  MCP: 'mcp',
  AUDIO_DATA: 'audio_data',
  WAKE_WORD_DETECTED: 'wake_word_detected',
  START_RECOGNITION: 'start_recognition',
  FRIEND: 'friend'
};

// 服务器消息类型
export const SERVER_MESSAGE_TYPES = {
  CONNECTION_ACK: 'connection_ack',
  HELLO: 'hello',
  STT: 'stt',
  LLM: 'llm',
  TTS: 'tts',
  ERROR: 'error',
  RECOGNITION_STARTED: 'recognition_started',
  WAKE_WORD_ACKNOWLEDGED: 'wake_word_acknowledged',
  AUDIO_RECEIVED: 'audio_received',
  MESSAGE: 'message'
};

// 监听状态
export const LISTEN_STATES = {
  START: 'start',
  STOP: 'stop',
  DETECT: 'detect'
};

// 聊天状态
export const CHAT_STATES = {
  COMPLETE: 'complete',
  PROCESSING: 'processing'
};

// TTS状态
export const TTS_STATES = {
  START: 'start',
  SENTENCE_START: 'sentence_start',
  STOP: 'stop'
};

// 设备类型
export const DEVICE_TYPES = {
  HARD: 'hard',    // 硬件设备
  WEB: 'web',      // Web客户端
  MOBILE: 'mobile' // 移动端
};

// 音频格式
export const AUDIO_FORMATS = {
  OPUS: 'opus',
  PCM: 'pcm',
  MP3: 'mp3'
};