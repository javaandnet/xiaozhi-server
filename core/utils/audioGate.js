/**
 * 音频有效性判定（环境自适应噪声门）
 *
 * 目标：替代原先的固定绝对阈值（max>=500 || avg>=50）——那种写法对低增益麦克风
 * （如鹿小班 PDM，人声峰值常只有 200~900）不友好：说轻了被误杀，环境噪音偶发尖峰又可能误触发。
 *
 * 思路（无状态、逐段自适应）：把一段 PCM 切成若干窗（默认 100ms/窗），
 * 用本段里"较安静的窗"估计噪声底，再要求：
 *   1) 峰值窗 RMS 超过绝对语音下限（挡纯静音）
 *   2) 峰值窗 / 噪声底 的对比度达到倍数（挡整体均匀的低能量噪音）
 *   3) 至少连续若干个"活动窗"超过活动阈值（挡单点咔哒——点击只有 1 个窗有效）
 * 三条同时满足才判为有效语音。噪声底随每段自身环境浮动，故对安静/嘈杂房间都能自适应。
 *
 * 关闭自适应（adaptive=false）时回退为旧的绝对阈值 OR 逻辑，保证可一键还原。
 */

/** 取中位数（对少量元素足够快） */
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * @param {Buffer} pcmData - 16-bit 小端单声道 PCM
 * @param {Object} opts - 判定参数（全部可配置）
 * @returns {Object} 统计与判定结果
 */
export function analyzeAudioGate(pcmData, opts = {}) {
  const o = {
    adaptive: opts.adaptive !== false, // 默认开启自适应
    sampleRate: opts.sampleRate || 16000,
    windowMs: opts.windowMs || 100,
    // 绝对语音下限：峰值窗 RMS 低于此直接判无效（挡纯静音/极低能量）
    absoluteSpeechFloor: opts.absoluteSpeechFloor ?? 25,
    // 语音/噪声最小对比度：峰值窗 RMS / 噪声底 需达到此倍数
    speechToNoiseMin: opts.speechToNoiseMin ?? 3.0,
    // 估计噪声底时，视为"安静窗"的相对上限（峰值窗的此比例以下）
    noiseFloorWindowRatio: opts.noiseFloorWindowRatio ?? 0.3,
    // 至少多少个活动窗才认定是"持续语音"（而非单点尖峰）
    minActiveWindows: opts.minActiveWindows ?? 2,
    // 旧逻辑（adaptive=false）使用的绝对阈值，也作为自适应下的兜底硬静音地板
    minMaxAmplitude: opts.minMaxAmplitude ?? 500,
    minAvgAmplitude: opts.minAvgAmplitude ?? 50,
  };

  const samples = Math.floor(pcmData.length / 2); // 16-bit = 2 bytes/sample
  if (samples === 0) {
    return {
      isValid: false, mode: o.adaptive ? 'adaptive' : 'absolute',
      maxAmplitude: 0, avgAmplitude: 0, rms: 0,
      peakWinRms: 0, noiseFloorRms: 0, contrast: 0, activeWindows: 0, windows: [],
    };
  }

  // 单次遍历：整体 max/avg/rms + 分窗平方和
  let maxAmplitude = 0;
  let sumAmplitude = 0;
  let sumSq = 0;
  const winSamples = Math.max(1, Math.floor((o.sampleRate * o.windowMs) / 1000));
  const winSq = []; // 每窗平方和
  let curIdx = 0;
  winSq.push(0);
  for (let i = 0; i < samples; i++) {
    const s = pcmData.readInt16LE(i * 2);
    const a = s < 0 ? -s : s;
    if (a > maxAmplitude) maxAmplitude = a;
    sumAmplitude += a;
    const sq = s * s;
    sumSq += sq;
    if (i > 0 && i % winSamples === 0) { curIdx++; winSq.push(0); }
    winSq[curIdx] += sq;
  }
  const avgAmplitude = sumAmplitude / samples;
  const rms = Math.sqrt(sumSq / samples);
  const winCount = winSq.length;
  const windows = winSq.map((acc) => Math.sqrt(acc / winSamples));
  const peakWinRms = Math.max(...windows);

  // 噪声底：取"安静窗"（<= 峰值窗 * ratio）的 RMS 中位数；若无则取最小窗
  const quietThreshold = peakWinRms * o.noiseFloorWindowRatio;
  const quietWins = windows.filter((w) => w <= quietThreshold && w > 0);
  const noiseFloorRms = quietWins.length ? median(quietWins) : Math.min(...windows);

  let isValid;
  if (o.adaptive) {
    const contrast = peakWinRms / Math.max(noiseFloorRms, 1);
    const activeThreshold = Math.max(o.absoluteSpeechFloor, noiseFloorRms * o.speechToNoiseMin);
    const activeWindows = windows.filter((w) => w >= activeThreshold).length;
    isValid =
      rms >= 5 && // 硬静音地板
      peakWinRms >= o.absoluteSpeechFloor &&
      contrast >= o.speechToNoiseMin &&
      activeWindows >= o.minActiveWindows;
    return {
      isValid, mode: 'adaptive',
      maxAmplitude, avgAmplitude, rms,
      peakWinRms, noiseFloorRms, contrast, activeWindows, windows, winCount,
    };
  }

  // 回退：旧的固定绝对阈值 OR 逻辑
  isValid = maxAmplitude >= o.minMaxAmplitude || avgAmplitude >= o.minAvgAmplitude;
  return {
    isValid, mode: 'absolute',
    maxAmplitude, avgAmplitude, rms,
    peakWinRms, noiseFloorRms, contrast: 0, activeWindows: 0, windows, winCount,
  };
}

export default analyzeAudioGate;
