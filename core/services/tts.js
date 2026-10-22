import BaseService from './base.js';
import { loadMockOpusFrames, MOCK_DEFAULTS } from '../utils/devMode.js';

class TtsService extends BaseService {
  constructor(config = {}) {
    super('TTS', config);
    this.provider = config.provider || 'edge';
    this.voice = config.voice || 'zh-CN-XiaoxiaoNeural';
    // 多语言音色：假名→日语，纯拉丁→英语，汉字→中文；无法判定按
    // defaultLanguage（config.json → language.default）托底
    this.defaultLanguage = config.defaultLanguage || 'zh';
    this.voiceZh = this.voice;
    this.voiceJa = String(config.voicejp || config.voiceJa || 'ja-JP-NanamiNeural').trim();
    this.voiceEn = String(config.voiceEn || 'en-US-JennyNeural').trim();
    this.rate = config.rate || 1.0;
    this.volume = config.volume || 1.0;

    // 标点符号配置（用于文本分段）
    this.punctuations = ['。', '？', '?', '！', '!', '；', ';', '：', '\n'];
    this.firstSentencePunctuations = ['，', '~', '、', ',', '。', '？', '?', '！', '!', '；', ';', '：'];
    // 硬断句标点（在中日英混排统一口径下使用）：半角 . 仅在词后紧跟空白时另判；
    // 半角 , ; : 只作软停顿（不在此集合），避免拆坏 URL/缩写且不符合英文断句习惯
    this.breakingPunctuations = new Set(['。', '．', '？', '！', '；', '：', '?', '!', '\n']);
    
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
    // 移除表情符号：emoji 只是设备端显示层装饰，交给 TTS 引擎会被念成
    // 「微笑的脸」之类的文字描述，语音里没必要，故仅对合成文本剥离
    text = this._stripEmoji(text);

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
   * 将文本拆成不可再分的最小 token（分段/切行的唯一口径）：
   * - URL/邮箱/版本号/文件名（https://x.com, v1.2.3, a.py）整体成 token，禁止拆坏；
   * - 拉丁词/数字（含 it's、O'clock、state-of-the-art 这类带撇号连字符的词）整体成 token，禁止切开；
   * - 其余字符（CJK 汉字/假名/中日标点，一字一义可任意处断，与中文习惯一致）单独成 token；
   * - 空白连续段单独成 token，作为英文词天然的可断边界。
   * @param {string} text - 原始文本
   * @returns {string[]} token 数组
   */
  _tokenize(text) {
    // 注：\p{Script=Latin} 不含数字，拉丁词/数字统一用 [\p{sc=Latin}\p{Nd}]（含全角数字）
    const re = /https?:\/\/\S+|\S+@\S+\.(?:[a-z]{2,})|(?:[\p{sc=Latin}\p{Nd}]+(?:[._-][\p{sc=Latin}\p{Nd}]+)*[._-]\d[._\d]*|\d+(?:[._-]\d+)+)|(?:[\p{sc=Latin}\p{Nd}]+(?:['’-][^\s\p{sc=Latin}\p{Nd}]*|['’-]?[\p{sc=Latin}\p{Nd}]+)*)|\s+|[\s\S]/gu;
    const tokens = [];
    let match;
    while ((match = re.exec(text)) !== null) {
      tokens.push(match[0]);
    }
    return tokens;
  }

  /**
   * 根据标点符号分割文本（多语言安全版）。
   * 断句点用 breakingPunctuations（半角 . 仅在词后紧跟空白/行尾时作句末，避免拆坏 URL/小数）；
   * 拉丁词按整词推进，句末后紧跟的 closing 引号/括号并入本段再断，
   * 保证英文/日文句子不会在单词中间被强行劈开（中文逐字成段的逻辑不受影响）。
   * @param {string} text - 原始文本
   * @returns {Array} - 文本片段数组
   */
  _splitText(text) {
    if (!text) return [];

    const segments = [];
    // 只把无歧义的 closing 符号并入句末（直引号 " 无法区分开闭，不并入）
    const closing = new Set(['”', '」', '』', '）', '）']);
    const opening = new Set(['“', '「', '『', '（', '(']);
    const tokens = this._tokenize(text);
    const atb = (i) => i < tokens.length && !/^\s+$/.test(tokens[i]) ? tokens[i][tokens[i].length - 1] : null;
    let currentSegment = '';

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const lastChar = token[token.length - 1];

      // 换行始终分段（与旧行为一致）
      if (token.includes('\n')) {
        if (currentSegment.trim()) segments.push(currentSegment.trim());
        currentSegment = '';
        continue;
      }

      currentSegment += token;

      // 半角 . 仅在后面是空白/行尾时作句末（与英文排版一致，Hello.World / 1.5 / URL 不拆）；
      // 半角 , ; : 不在此断句（由打包层的软停顿处理），全角标点（含中日逗号、、）直接断句
      const nextIsSpace = i + 1 >= tokens.length || /^\s/.test(tokens[i + 1]);
      const isBreak = this.breakingPunctuations.has(lastChar)
        || (lastChar === '.' && nextIsSpace);
      if (!isBreak) continue;

      // 句末后若紧跟 closing 引号/括号，先并入本段再断（如「終わった。」、“好的。”）；
      // 如「xxx。」这类句末前就有未配对 opening 的（如 “Hello.”）不并入，避免拆坏括号对
      let j = i + 1;
      if (atb(j) && closing.has(atb(j))) {
        let back = i;
        let sawOpening = false;
        while (back >= 0 && (atb(back) === null || opening.has(atb(back)))) {
          if (atb(back) !== null) sawOpening = true;
          back--;
        }
        if (!sawOpening) {
          while (j < tokens.length && /^\s+$/.test(tokens[j])) j++;
          if (j < tokens.length && closing.has(tokens[j][tokens[j].length - 1])) {
            currentSegment += tokens[j];
            i = j;
          }
        }
      }
      if (currentSegment.trim()) segments.push(currentSegment.trim());
      currentSegment = '';
    }

    // 处理最后一段
    if (currentSegment.trim()) {
      segments.push(currentSegment.trim());
    }

    return segments;
  }

  /**
   * 移除表情符号（仅语音合成前调用，不影响展示文本）
   * 常规：正文里夹带的 emoji 属显示层装饰，直接剥离不念；
   * 兜底：若整段只剩 emoji（无其它可读文字），则念出其语义（如 😊=>“微笑”），
   *       避免纯表情回复被 TTS 吞掉导致设备无声。
   * @param {string} text - 原始文本
   * @returns {string} - 处理后用于合成的文本
   */
  _stripEmoji(text) {
    if (!text) return '';
    // 先抽出图像字符序列：变体选择符/肤色修饰/ZWJ+图象字符合为一个整体，相邻独立 emoji 分开
    const pictographs = text.match(/\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}]|\u200D\p{Extended_Pictographic})*/gu) || [];
    const stripped = text
      .replace(/\p{Emoji_Presentation}/gu, '')
      .replace(/\p{Extended_Pictographic}(?:\uFE0F|\uD83C[\uDFFB-\uDFFF])?/gu, '')
      .replace(/#[\uFE0F]?\u20E3|[0-9*\uFE0F]\u20E3/g, '')
      .replace(/[\u200D\uFE0F]/g, '')
      .replace(/ +([，。！？、；：,!?;:])/g, '$1')
      .trim();
    // 剥离后仍有文字：正常丢弃 emoji
    if (stripped) return stripped;
    // 整段就是纯 emoji：按语义表逐个念出（未命中则仍为空，不瞎编）
    const MEANINGS = {
      '🙂': '微笑', '😊': '微笑', '😀': '笑', '😃': '笑', '😄': '笑',
      '😂': '笑场', '🤣': '大笑', '😉': '眼意', '😍': '喜蛋', '🥰': '喜爱',
      '😘': '亲吻', '😜': '吐舌', '🤪': '鬼脸', '😎': '得意', '🤗': '拥抱',
      '🙃': '反笑', '😌': '安然', '😴': '困了', '🥱': '困了',
      '😡': '生气了', '😠': '生气', '🤬': '生气了', '😱': '吓人', '😨': '害怕',
      '😰': '紧张', '😥': '难过', '😢': '哭了', '😭': '大哭', '😤': '哼',
      '😳': '害羞', '🥺': '央求', '😖': '纠结', '😔': '有点难过', '😞': '失望',
      '😩': '累了', '😪': '累了', '🤤': '馋了', '😷': '不舒服', '🤒': '生病了',
      '🤕': '受伤了', '🙄': '无语', '😑': '无语', '😐': '平静', '🤔': '想想',
      '😬': '尴尬', '🙁': '不高兴', '😕': '疑惑', '🤐': '沉默', '😯': '异', '😲': '惊讶',
      '👍': '点赞', '👎': '点不认同', '👏': '鼓掌', '🙏': '谢谢', '💪': '加油',
      '👋': '挥手', '🤝': '合作', '✌': '胜利', '👌': '好的', '🙌': '万岁',
      '❤': '爱心', '💔': '心碎', '🎉': '庆祝', '✨': '闪光', '🔥': '火热',
      '⭐': '星星', '🌟': '闪亮', '☀': '晴天', '🌙': '晚上', '🌸': '花开'
    };
    const spoken = pictographs
      .map((g) => MEANINGS[g] || MEANINGS[g.replace(/\uFE0F/g, '')] || '')
      .filter(Boolean);
    return [...new Set(spoken)].join('，');
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
    this.voiceZh = voice;
  }

  /** 按文本内容选音色；无实质语种特征时用 defaultLanguage 托底 */
  pickVoice(text, lang = null) {
    const t = String(text || '');
    if (/[\u3040-\u30ff]/.test(t)) return this.voiceJa;   // 假名 => 日语
    if (/[\u4e00-\u9fff]/.test(t)) return this.voiceZh;   // 汉字 => 中文
    if (/[A-Za-z]/.test(t)) return this.voiceEn;          // 拉丁字母 => 英语
    const map = { zh: this.voiceZh, ja: this.voiceJa, en: this.voiceEn };
    return map[lang || this.defaultLanguage] || this.voiceZh;
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
