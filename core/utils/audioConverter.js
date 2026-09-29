import { spawn } from 'child_process';
import opusPkg from 'opusscript';
const OpusEncoder = opusPkg.default || opusPkg;
import { logger } from '../../utils/logger.js';

/**
 * 音频转换工具类
 * 移植自xiaozhi项目的完整音频转换逻辑
 * 支持多种格式到Opus的转换
 */
class AudioConverter {
  constructor() {
    // Opus编码器配置 - 严格按照标准
    this.sampleRate = 16000;  // 采样率
    this.channels = 1;        // 单声道
    this.frameDuration = 60;  // 帧时长(ms)
    this.frameSize = Math.floor(this.sampleRate * this.frameDuration / 1000); // 每帧采样数(960)
  }

  /**
   * 将MP3 Buffer转换为Opus帧数组
   * @param {Buffer} mp3Buffer - MP3音频数据
   * @returns {Promise<Buffer[]>} - Opus帧数组
   */
  async mp3ToOpusFrames(mp3Buffer) {
    return new Promise((resolve, reject) => {
      try {
        const opusFrames = [];

        // 创建Opus编码器
        const encoder = new OpusEncoder(this.sampleRate, this.channels);

        // 使用FFmpeg将MP3转换为PCM
        const ffmpegProcess = spawn('ffmpeg', [
          '-i', 'pipe:0',        // 从stdin读取
          '-f', 's16le',         // 输出格式: 16位有符号小端PCM
          '-ar', '16000',        // 采样率: 16000Hz
          '-ac', '1',            // 声道数: 1
          'pipe:1'               // 输出到stdout
        ]);

        let pcmBuffer = Buffer.alloc(0);
        let stderrData = '';

        ffmpegProcess.stdout.on('data', (chunk) => {
          pcmBuffer = Buffer.concat([pcmBuffer, chunk]);

          // 当PCM数据足够一帧时，进行Opus编码
          const frameBytes = this.frameSize * 2; // 16bit = 2 bytes per sample

          while (pcmBuffer.length >= frameBytes) {
            const frame = pcmBuffer.slice(0, frameBytes);
            pcmBuffer = pcmBuffer.slice(frameBytes);

            try {
              const opusFrame = encoder.encode(frame, this.frameSize);
              opusFrames.push(opusFrame);
            } catch (err) {
              logger.debug('Opus编码帧失败:', err.message);
            }
          }
        });

        ffmpegProcess.stderr.on('data', (data) => {
          stderrData += data.toString();
        });

        ffmpegProcess.on('close', (code) => {
          if (code !== 0) {
            logger.error('FFmpeg错误:', stderrData);
            reject(new Error(`FFmpeg进程退出码: ${code}`));
            return;
          }

          // 处理剩余的PCM数据（最后一帧，可能不足）
          if (pcmBuffer.length > 0) {
            // 补齐到frameSize
            const frameBytes = this.frameSize * 2;
            const paddedBuffer = Buffer.alloc(frameBytes, 0);
            pcmBuffer.copy(paddedBuffer);

            try {
              const opusFrame = encoder.encode(paddedBuffer, this.frameSize);
              opusFrames.push(opusFrame);
            } catch (err) {
              logger.error('Opus编码最后一帧失败:', err.message);
            }
          }

          logger.debug(`MP3到Opus转换完成: ${mp3Buffer.length} bytes -> ${opusFrames.length} 帧`);
          resolve(opusFrames);
        });

        ffmpegProcess.on('error', (err) => {
          reject(new Error(`FFmpeg进程错误: ${err.message}`));
        });

        // 写入MP3数据
        ffmpegProcess.stdin.write(mp3Buffer);
        ffmpegProcess.stdin.end();

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 将音频Buffer直接转换为Opus帧（使用FFmpeg处理任何格式）
   * @param {Buffer} audioBuffer - 音频数据(MP3等)
   * @param {Object} options - 配置选项
   * @returns {Promise<Buffer[]>} - Opus帧数组
   */
  async convertToOpusFrames(audioBuffer, options = {}) {
    const sampleRate = options.sampleRate || this.sampleRate;
    const channels = options.channels || this.channels;
    const frameDuration = options.frameDuration || this.frameDuration;
    const frameSize = Math.floor(sampleRate * frameDuration / 1000);

    return new Promise((resolve, reject) => {
      try {
        const opusFrames = [];
        const encoder = new OpusEncoder(sampleRate, channels);

        const ffmpegProcess = spawn('ffmpeg', [
          '-i', 'pipe:0',
          '-f', 's16le',
          '-ar', String(sampleRate),
          '-ac', String(channels),
          'pipe:1'
        ]);

        let pcmBuffer = Buffer.alloc(0);
        let stderrData = '';

        ffmpegProcess.stdout.on('data', (chunk) => {
          pcmBuffer = Buffer.concat([pcmBuffer, chunk]);
          const frameBytes = frameSize * 2;

          while (pcmBuffer.length >= frameBytes) {
            const frame = pcmBuffer.slice(0, frameBytes);
            pcmBuffer = pcmBuffer.slice(frameBytes);

            try {
              const opusFrame = encoder.encode(frame, frameSize);
              opusFrames.push(opusFrame);
            } catch (err) {
              logger.error('Opus编码帧失败:', err.message);
            }
          }
        });

        ffmpegProcess.stderr.on('data', (data) => {
          stderrData += data.toString();
        });

        ffmpegProcess.on('close', (code) => {
          if (code !== 0) {
            logger.error('FFmpeg错误:', stderrData);
            reject(new Error(`FFmpeg进程退出码: ${code}`));
            return;
          }

          // 处理剩余数据
          if (pcmBuffer.length > 0) {
            const frameBytes = frameSize * 2;
            const paddedBuffer = Buffer.alloc(frameBytes, 0);
            pcmBuffer.copy(paddedBuffer);

            try {
              const opusFrame = encoder.encode(paddedBuffer, frameSize);
              opusFrames.push(opusFrame);
            } catch (err) {
              logger.error('Opus编码最后一帧失败:', err.message);
            }
          }

          logger.debug(`音频到Opus转换完成: ${audioBuffer.length} bytes -> ${opusFrames.length} 帧`);
          resolve(opusFrames);
        });

        ffmpegProcess.on('error', (err) => {
          reject(new Error(`FFmpeg进程错误: ${err.message}`));
        });

        // 写入音频数据
        ffmpegProcess.stdin.write(audioBuffer);
        ffmpegProcess.stdin.end();

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 将PCM Buffer编码为Opus帧（内部使用）
   * @param {Buffer} pcmBuffer - PCM音频数据
   * @returns {Buffer[]} Opus帧数组
   */
  encodePcmToOpus(pcmBuffer) {
    const encoder = new OpusEncoder(this.sampleRate, this.channels);
    const bytesPerFrame = this.frameSize * this.channels * 2; // 16-bit samples
    const opusFrames = [];

    logger.debug(`开始Opus编码: 输入${pcmBuffer.length}字节, 帧大小${bytesPerFrame}字节`);

    for (let i = 0; i < pcmBuffer.length; i += bytesPerFrame) {
      const chunk = pcmBuffer.slice(i, i + bytesPerFrame);
      
      // 如果不是完整帧，填充静音数据
      let frameData = chunk;
      if (chunk.length < bytesPerFrame) {
        frameData = Buffer.alloc(bytesPerFrame, 0);
        chunk.copy(frameData);
      }
      
      try {
        const encoded = encoder.encode(frameData, this.frameSize);
        opusFrames.push(encoded);
      } catch (error) {
        logger.error(`Opus编码失败 (帧${i/bytesPerFrame}):`, error.message);
      }
    }

    logger.debug(`Opus编码完成: ${pcmBuffer.length} bytes PCM -> ${opusFrames.length} Opus 帧`);
    return opusFrames;
  }
}

// 导出单例实例
export const audioConverter = new AudioConverter();


