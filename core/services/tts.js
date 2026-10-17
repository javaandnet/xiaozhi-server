import BaseService from './base.js';
import { loadMockOpusFrames, MOCK_DEFAULTS } from '../utils/devMode.js';

class TtsService extends BaseService {
  constructor(config = {}) {
    super('TTS', config);
    this.provider = config.provider || 'edge';
    this.voice = config.voice || 'zh-CN-XiaoxiaoNeural';
    this.rate = config.rate || 1.0;
    this.volume = config.volume || 1.0;

    // 标点符号配置（用于文本分段）
    this.punctuations = ['。', '？', '?', '！', '!', '；', ';', '：', '\n'];
    this.firstSentencePunctuations = ['，', '~', '、', ',', '。', '？', '?', '！', '!', '；', ';', '：'];
    
    // 音频文件保存配置
    this.outputDir = config.outputDir || './data/tts-output';
    this.saveAudioFiles = config.saveAudioFiles !== undefined ? config.saveAudioFiles : false;
    
    // 确保输出目录存在
    this._ensureOutputDir();
  }

  async _initialize() {
    // 根据提供商初始化不同的TTS服务
    switch (this.provider) {
      case 'mock':
        // Development mode: no external TTS, replay pre-baked opus frames.
        console.log('✅ TTS mock 模式初始化（开发模式，不调用外部 TTS/不跑 ffmpeg）');
        break;
      case 'edge':
        await this._initEdgeTts();
        break;
      case 'xunfei':
        await this._initXunfeiTts();
        break;
      case 'aliyun':
        await this._initAliyunTts();
        break;
      default:
        throw new Error(`不支持的TTS提供商: ${this.provider}`);
    }
  }

  async _initEdgeTts() {
    // 初始化Edge TTS服务
    try {
      const { EdgeTTS } = await import('node-edge-tts');
      this.edgeTTS = EdgeTTS;
      console.log('✅ Edge TTS服务初始化成功');
    } catch (error) {
      console.error('❌ Edge TTS服务初始化失败:', error.message);
      throw new Error(`Edge TTS初始化失败: ${error.message}`);
    }
  }

  async _initXunfeiTts() {
    // 初始化讯飞TTS服务
    console.log('初始化讯飞TTS服务');
  }

  async _initAliyunTts() {
    // 初始化阿里云TTS服务
    console.log('初始化阿里云TTS服务');
  }

  async synthesize(text, options = {}) {
    if (!this.isEnabled()) {
      throw new Error('TTS服务未启用或未初始化');
    }

    // 清理文本中的Markdown格式
    text = this._cleanMarkdown(text);

    const opts = {
      voice: options.voice || this.voice,
      rate: options.rate || this.rate,
      volume: options.volume || this.volume,
      ...options
    };

    try {
      let audioData;
      switch (this.provider) {
        case 'mock': {
          // Return pre-baked opus frames; the handler sends them directly and
          // skips MP3->Opus (ffmpeg). null frames => handler sends a text-only notice.
          const frames = loadMockOpusFrames((this.config.mock && this.config.mock.opusFile) || MOCK_DEFAULTS.DEFAULT_OPUS_FILE);
          console.log(`[devMode] TTS mock frames: ${frames ? frames.length : 0} (text: ${text.substring(0, 20)})`);
          return {
            mockFrames: frames,
            format: 'opus',
            sampleRate: 16000,
            duration: this._estimateDuration(text),
            provider: 'mock'
          };
        }
        case 'edge':
          audioData = await this._synthesizeWithEdge(text, opts);
          break;
        case 'xunfei':
          audioData = await this._synthesizeWithXunfei(text, opts);
          break;
        case 'aliyun':
          audioData = await this._synthesizeWithAliyun(text, opts);
          break;
        default:
          throw new Error(`不支持的TTS提供商: ${this.provider}`);
      }

      return {
        audio: audioData,
        format: 'opus',
        sampleRate: 16000,
        duration: this._estimateDuration(text),
        provider: this.provider
      };
    } catch (error) {
      console.error('TTS合成失败:', error);
      throw error;
    }
  }

  async _synthesizeWithEdge(text, options) {
    // Edge TTS实现 - 使用node-edge-tts库
    if (!this.edgeTTS) {
      throw new Error('Edge TTS未初始化');
    }

    try {
      // 创建TTS实例
      const tts = new this.edgeTTS({
        voice: options.voice || this.voice,
        rate: options.rate ? `${options.rate}%` : '+0%',
        volume: options.volume ? `${options.volume}%` : '+0%'
      });

      // 生成临时文件路径
      const fs = await import('fs');
      const path = await import('path');
      const os = await import('os');
      const tempFilePath = path.join(os.tmpdir(), `temp-${Date.now()}.mp3`);

      // 生成音频文件
      await tts.ttsPromise(text, tempFilePath);

      // 读取音频数据
      const audioData = fs.readFileSync(tempFilePath);

      // 保存音频文件（如果启用）
      if (this.saveAudioFiles) {
        await this._saveAudioFile(text, audioData, options);
      }

      // 清理临时文件
      fs.unlinkSync(tempFilePath);

      console.log(`✅ TTS合成完成: ${audioData.length} bytes`);
      return audioData;

    } catch (error) {
      console.error('❌ Edge TTS合成失败:', error.message);
      throw new Error(`TTS合成失败: ${error.message}`);
    }
  }

  async _synthesizeWithXunfei(text, options) {
    // 讯飞TTS实现
    console.log(`使用讯飞TTS合成: ${text}`);
    // 返回模拟的音频数据
    return Buffer.from('mock_audio_data_xunfei');
  }

  async _synthesizeWithAliyun(text, options) {
    // 阿里云TTS实现
    console.log(`使用阿里云TTS合成: ${text}`);
    // 返回模拟的音频数据
    return Buffer.from('mock_audio_data_aliyun');
  }

  _estimateDuration(text) {
    // 更精确的音频时长估算（毫秒）
    // 考虑不同字符类型的发音时长
    let totalChars = 0;
    let chineseChars = 0;
    let englishChars = 0;
    let punctuationChars = 0;
    
    for (const char of text) {
      if (/[一-鿿]/.test(char)) {
        // 中文字符
        chineseChars++;
        totalChars++;
      } else if (/[a-zA-Z]/.test(char)) {
        // 英文字母
        englishChars++;
        totalChars++;
      } else if (/[,.;!?，。；！？]/.test(char)) {
        // 标点符号
        punctuationChars++;
      }
    }
    
    // 估算逻辑：
    // - 中文：每个字符约0.3秒
    // - 英文：每个字母约0.15秒（比中文稍快）
    // - 标点：每个约0.2秒停顿
    const chineseTime = chineseChars * 300;  // 毫秒
    const englishTime = englishChars * 150;  // 毫秒 (每个字母0.15秒)
    const punctuationTime = punctuationChars * 200;  // 毫秒
    
    // 最小时间保障
    const minTime = Math.max(text.length * 100, 500);
    
    const estimatedTime = Math.max(minTime, chineseTime + englishTime + punctuationTime);
    
    console.log(`📊 音频时长估算: 文本长度=${text.length}, 中文=${chineseChars}, 英文=${englishChars}, 标点=${punctuationChars}, 估算时长=${Math.round(estimatedTime)}ms`);
    
    return Math.round(estimatedTime);
  }

  /**
   * 流式合成语音（支持回调方式）
   * @param {string} text - 要转换的文本
   * @param {Function} callback - 音频数据回调函数
   */
  async synthesizeStream(text, callback) {
    if (!this.isEnabled()) {
      throw new Error('TTS服务未启用或未初始化');
    }

    // 清理文本
    text = this._cleanMarkdown(text);

    // 分段处理
    const segments = this._splitText(text);

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const isFirst = i === 0;
      const isLast = i === segments.length - 1;

      try {
        const audioData = await this.synthesize(segment);
        callback({
          audio: audioData,
          text: segment,
          isFirst,
          isLast
        });
      } catch (error) {
        console.error(`分段TTS生成失败: ${error.message}`);
      }
    }
  }

  /**
   * 根据标点符号分割文本
   * @param {string} text - 原始文本
   * @returns {Array} - 文本片段数组
   */
  _splitText(text) {
    if (!text) return [];

    const segments = [];
    let currentSegment = '';

    for (const char of text) {
      currentSegment += char;

      if (this.punctuations.includes(char)) {
        if (currentSegment.trim()) {
          segments.push(currentSegment.trim());
        }
        currentSegment = '';
      }
    }

    // 处理最后一段
    if (currentSegment.trim()) {
      segments.push(currentSegment.trim());
    }

    return segments;
  }

  /**
   * 清理Markdown格式
   * @param {string} text - 原始文本
   * @returns {string} - 清理后的文本
   */
  _cleanMarkdown(text) {
    if (!text) return '';

    return text
      .replace(/#{1,6}\s/g, '')  // 移除标题标记
      .replace(/\*\*([^*]+)\*\*/g, '$1')  // 移除粗体
      .replace(/\*([^*]+)\*/g, '$1')  // 移除斜体
      .replace(/`{1,3}[^`]*`{1,3}/g, '')  // 移除代码块
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // 移除链接，保留文字
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')  // 移除图片
      .replace(/\n{3,}/g, '\n\n')  // 减少多余换行
      .trim();
  }

  async _healthCheck() {
    // 测试TTS服务健康状态
    try {
      const testText = '健康检查测试';
      const result = await this.synthesize(testText);
      return {
        message: 'TTS服务运行正常',
        provider: this.provider,
        voice: this.voice,
        outputSize: result.length
      };
    } catch (error) {
      throw new Error(`TTS服务健康检查失败: ${error.message}`);
    }
  }

  getSupportedVoices() {
    // 返回支持的语音列表
    return [
      { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', gender: 'female', language: 'zh-CN' },
      { id: 'zh-CN-YunyangNeural', name: '云扬', gender: 'male', language: 'zh-CN' },
      { id: 'en-US-JennyNeural', name: 'Jenny', gender: 'female', language: 'en-US' }
    ];
  }

  updateVoice(voice) {
    this.voice = voice;
  }

  updateProvider(provider) {
    this.provider = provider;
    // 重新初始化服务
    this.initialized = false;
    return this.initialize();
  }

  /**
   * 确保输出目录存在
   * @private
   */
  _ensureOutputDir() {
    if (this.saveAudioFiles) {
      import('fs').then(fsModule => {
        const fs = fsModule.default || fsModule;
        import('path').then(pathModule => {
          const path = pathModule.default || pathModule;
          if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
            console.log(`📁 创建TTS输出目录: ${this.outputDir}`);
          }
        });
      });
    }
  }

  /**
   * 保存音频文件
   * @param {string} text - 合成的文本
   * @param {Buffer} audioData - 音频数据
   * @param {Object} options - 合成选项
   * @private
   */
  async _saveAudioFile(text, audioData, options) {
    try {
      const fs = await import('fs');
      const path = await import('path');
      
      // 生成安全的文件名
      const safeText = text.substring(0, 30).replace(/[<>:"/\\|?*]/g, '_');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${safeText}_${timestamp}.mp3`;
      const filepath = path.join(this.outputDir, filename);
      
      // 保存文件
      fs.writeFileSync(filepath, audioData);
      
      // 记录文件信息
      const stats = fs.statSync(filepath);
      console.log(`💾 音频文件已保存: ${filepath}`);
      console.log(`📊 文件大小: ${stats.size} bytes`);
      console.log(`📝 原始文本: "${text}"`);
      console.log(`🗣️ 语音: ${options.voice || this.voice}`);
      
    } catch (error) {
      console.error('❌ 保存音频文件失败:', error.message);
    }
  }

  /**
   * 获取保存的音频文件列表
   * @returns {Array} 文件信息数组
   */
  getSavedAudioFiles() {
    try {
      // 使用同步方式导入fs和path模块
      const fs = eval('require')('fs');
      const path = eval('require')('path');
      
      if (!fs.existsSync(this.outputDir)) {
        return [];
      }
      
      const files = fs.readdirSync(this.outputDir);
      return files
        .filter(file => file.endsWith('.mp3'))
        .map(file => {
          const filepath = path.join(this.outputDir, file);
          const stats = fs.statSync(filepath);
          return {
            filename: file,
            filepath: filepath,
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime
          };
        })
        .sort((a, b) => b.created - a.created); // 按创建时间倒序排列
        
    } catch (error) {
      console.error('❌ 读取音频文件列表失败:', error.message);
      return [];
    }
  }

  /**
   * 删除指定的音频文件
   * @param {string} filename - 文件名
   * @returns {boolean} 是否删除成功
   */
  deleteAudioFile(filename) {
    try {
      // 使用同步方式导入fs和path模块
      const fs = eval('require')('fs');
      const path = eval('require')('path');
      const filepath = path.join(this.outputDir, filename);
      
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
        console.log(`🗑️ 已删除音频文件: ${filename}`);
        return true;
      }
      return false;
    } catch (error) {
      console.error('❌ 删除音频文件失败:', error.message);
      return false;
    }
  }
}

export default TtsService;
