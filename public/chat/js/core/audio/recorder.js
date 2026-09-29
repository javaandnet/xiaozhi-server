// Audio recording module - 使用 AudioContext + Opus 编码
import { log } from '../../utils/logger.js?v=0205';
import { checkOpusLoaded, initOpusEncoder } from './opus-codec.js?v=0205';
import { getAudioPlayer } from './player.js?v=0205';

// Audio recorder class - 使用 AudioContext + Opus 编码
export class AudioRecorder {
    constructor() {
        this.isRecording = false;
        this.audioContext = null;
        this.analyser = null;
        this.audioSource = null;
        this.scriptProcessor = null;
        this.mediaStream = null;
        this.pcmBuffer = []; // PCM 数据缓冲区
        this.totalAudioSize = 0;
        this.visualizationRequest = null;
        this.recordingTimer = null;
        this.websocket = null;
        this.opusEncoder = null;
        this.sendQueue = []; // 发送队列
        this.sendIntervalId = null; // 定时发送器ID
        // Callback functions
        this.onRecordingStart = null;
        this.onRecordingStop = null;
        this.onVisualizerUpdate = null;

        // Opus 编码参数 (与 ai-ws-stt-test.js 一致)
        this.sampleRate = 16000;
        this.frameSize = 960; // 60ms @ 16kHz = 960 samples
        this.frameDuration = 60; // 毫秒

        // 录音测试统计
        this.testMode = false; // 测试模式：不发送到服务器，只在本地收集
        this.savedOpusFrames = []; // 保存的 Opus 帧（测试模式下）
        this.savedPcmData = []; // 保存的原始 PCM 数据（测试模式下）
        this.stats = {
            opusFrameCount: 0,      // 发送的 Opus 帧数
            totalOpusBytes: 0,      // 发送的 Opus 总字节数
            pcmBytes: 0,            // 收集的 PCM 字节数
            startTime: null,        // 开始时间
            endTime: null,          // 结束时间
            frameSizes: []          // 每帧大小记录
        };
    }

    // Set WebSocket instance
    setWebSocket(ws) {
        this.websocket = ws;
    }

    // Get AudioContext instance
    getAudioContext() {
        return getAudioPlayer().getAudioContext();
    }



    // Start recording
    async start() {
        if (this.isRecording) return false;
        try {
            // Check if WebSocketHandler instance exists
            const { getWebSocketHandler } = await import('../network/websocket.js?v=0205');
            const wsHandler = getWebSocketHandler();
            // If machine is speaking, send abort message
            if (wsHandler && wsHandler.isRemoteSpeaking && wsHandler.currentSessionId) {
                const abortMessage = { session_id: wsHandler.currentSessionId, type: 'abort', reason: 'wake_word_detected' };
                if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                    this.websocket.send(JSON.stringify(abortMessage));
                    log('已发送中止消息', 'info');
                }
            }

            log('请至少录制1-2秒音频以确保收集足够的数据', 'info');

            // 初始化 Opus 编码器
            if (!this.opusEncoder) {
                // 确保 Opus 库已加载
                checkOpusLoaded();
                this.opusEncoder = initOpusEncoder();
                if (!this.opusEncoder) {
                    log('Opus 编码器初始化失败，无法录音', 'error');
                    return false;
                }
                log('Opus 编码器初始化成功', 'success');
            }

            // 请求麦克风权限 - 在移动设备上需要用户交互触发
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    sampleRate: 16000,
                    channelCount: 1
                }
            });

            this.audioContext = this.getAudioContext();

            // iOS Safari 需要恢复音频上下文
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
                log('录音前已恢复音频上下文', 'info');
            }

            // 创建音频源和分析器
            this.audioSource = this.audioContext.createMediaStreamSource(this.mediaStream);
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 2048;
            this.audioSource.connect(this.analyser);

            // 创建 ScriptProcessorNode 用于获取 PCM 数据
            // bufferSize: 4096 样本，输入/输出通道数都是 1
            const bufferSize = 4096;
            this.scriptProcessor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

            // 重置缓冲区
            this.pcmBuffer = [];
            this.totalAudioSize = 0;
            this.sendQueue = []; // 重置发送队列

            // 重置保存的数据
            this.savedOpusFrames = [];
            this.savedPcmData = [];

            // 重置统计
            this.stats = {
                opusFrameCount: 0,
                totalOpusBytes: 0,
                pcmBytes: 0,
                startTime: Date.now(),
                endTime: null,
                frameSizes: []
            };

            // 处理音频数据
            this.scriptProcessor.onaudioprocess = (event) => {
                if (!this.isRecording) return;

                const inputData = event.inputBuffer.getChannelData(0); // Float32
                
                // 检查实际采样率
                const actualSampleRate = event.inputBuffer.sampleRate;
                let resampledData = inputData;
                
                // 如果采样率不是 16000Hz，进行重采样
                if (actualSampleRate !== this.sampleRate) {
                    const ratio = actualSampleRate / this.sampleRate;
                    const newLength = Math.floor(inputData.length / ratio);
                    resampledData = new Float32Array(newLength);
                    for (let i = 0; i < newLength; i++) {
                        const srcIndex = Math.floor(i * ratio);
                        resampledData[i] = inputData[srcIndex];
                    }
                }

                // 将 Float32 转换为 Int16 PCM
                const pcmData = new Int16Array(resampledData.length);
                for (let i = 0; i < resampledData.length; i++) {
                    // 将 -1.0 ~ 1.0 的浮点值转换为 -32768 ~ 32767 的整数值
                    const s = Math.max(-1, Math.min(1, resampledData[i]));
                    pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }

                // 将 PCM 数据添加到缓冲区
                for (let i = 0; i < pcmData.length; i++) {
                    this.pcmBuffer.push(pcmData[i]);
                }
                this.totalAudioSize += pcmData.length * 2; // Int16 = 2 bytes
                
                // 测试模式下保存原始 PCM 数据
                if (this.testMode) {
                    for (let i = 0; i < pcmData.length; i++) {
                        this.savedPcmData.push(pcmData[i]);
                    }
                }

                // 当缓冲区中有足够的样本时（frameSize = 960），编码并加入发送队列
                while (this.pcmBuffer.length >= this.frameSize) {
                    // 提取一帧 PCM 数据
                    const frameData = this.pcmBuffer.splice(0, this.frameSize);

                    // 使用 Opus 编码器编码
                    const opusFrame = this.opusEncoder.encode(frameData);
                    
                    if (opusFrame && opusFrame.length > 0) {
                        // 更新统计
                        this.stats.opusFrameCount++;
                        this.stats.totalOpusBytes += opusFrame.length;
                        this.stats.frameSizes.push(opusFrame.length);

                        // 测试模式下保存 Opus 帧
                        if (this.testMode) {
                            this.savedOpusFrames.push(new Uint8Array(opusFrame));
                        }

                        // 非测试模式下，加入发送队列
                        if (!this.testMode) {
                            // 将 Opus 帧加入发送队列
                            this.sendQueue.push(opusFrame);
                        }
                    }
                }
            };

            // 连接 ScriptProcessorNode（需要连接到输出才能工作）
            this.audioSource.connect(this.scriptProcessor);
            this.scriptProcessor.connect(this.audioContext.destination);
            
            // 启动定时发送器（按 frameDuration 间隔发送）
            this.sendQueue = []; // 发送队列
            this.sendIntervalId = setInterval(() => {
                if (this.sendQueue.length > 0 && this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                    const opusFrame = this.sendQueue.shift();
                    try {
                        // 发送 ArrayBuffer，确保数据正确传输
                        let dataToSend;
                        if (opusFrame instanceof Uint8Array) {
                            dataToSend = opusFrame.buffer.slice(
                                opusFrame.byteOffset,
                                opusFrame.byteOffset + opusFrame.byteLength
                            );
                        } else {
                            dataToSend = opusFrame;
                        }
                        this.websocket.send(dataToSend);
                    } catch (error) {
                        log(`WebSocket发送错误: ${error.message}`, 'error');
                    }
                }
            }, this.frameDuration); // 60ms 间隔

            // 开始录音
            this.isRecording = true;

            // Send listening start message
            if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                const listenStartMsg = JSON.stringify({ type: 'listen', state: 'start' });
                this.websocket.send(listenStartMsg);
                log(`已发送录音开始消息: ${listenStartMsg}`, 'info');
            } else {
                log('WebSocket未连接，无法发送开始消息', 'error');
                this.isRecording = false;
                return false;
            }

            // Start visualization
            if (this.onVisualizerUpdate) {
                const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
                this.startVisualization(dataArray);
            }

            // Immediately notify recording start, update button state
            if (this.onRecordingStart) {
                this.onRecordingStart(0);
            }

            // Start recording timer
            let recordingSeconds = 0;
            this.recordingTimer = setInterval(() => {
                recordingSeconds += 0.1;
                if (this.onRecordingStart) {
                    this.onRecordingStart(recordingSeconds);
                }
            }, 100);

            log(`已开始 AudioContext + Opus 录音 (采样率: ${this.audioContext.sampleRate}Hz)`, 'success');
            return true;
        } catch (error) {
            log(`录音启动错误: ${error.message}`, 'error');
            this.isRecording = false;
            return false;
        }
    }

    // Start visualization
    startVisualization(dataArray) {
        const draw = () => {
            this.visualizationRequest = requestAnimationFrame(() => draw());
            if (!this.isRecording) return;
            this.analyser.getByteFrequencyData(dataArray);
            if (this.onVisualizerUpdate) {
                this.onVisualizerUpdate(dataArray);
            }
        };
        draw();
    }

    // Stop recording
    async stop() {
        if (!this.isRecording) return false;
        try {
            this.isRecording = false;

            // 停止定时发送器
            if (this.sendIntervalId) {
                clearInterval(this.sendIntervalId);
                this.sendIntervalId = null;
            }

            // 发送队列中剩余的所有帧
            if (this.sendQueue && this.sendQueue.length > 0 && this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                log(`发送队列中剩余 ${this.sendQueue.length} 帧...`, 'info');
                while (this.sendQueue.length > 0) {
                    const opusFrame = this.sendQueue.shift();
                    try {
                        let dataToSend;
                        if (opusFrame instanceof Uint8Array) {
                            dataToSend = opusFrame.buffer.slice(
                                opusFrame.byteOffset,
                                opusFrame.byteOffset + opusFrame.byteLength
                            );
                        } else {
                            dataToSend = opusFrame;
                        }
                        this.websocket.send(dataToSend);
                    } catch (error) {
                        log(`WebSocket发送错误: ${error.message}`, 'error');
                    }
                }
            }

            // 处理缓冲区中剩余的 PCM 数据（如果有的话）
            if (this.pcmBuffer.length > 0 && this.opusEncoder) {
                // 填充到 frameSize 并编码
                while (this.pcmBuffer.length < this.frameSize) {
                    this.pcmBuffer.push(0); // 用 0 填充
                }
                const frameData = this.pcmBuffer.splice(0, this.frameSize);
                const opusFrame = this.opusEncoder.encode(frameData);
                
                if (opusFrame && opusFrame.length > 0) {
                    // 更新统计
                    this.stats.opusFrameCount++;
                    this.stats.totalOpusBytes += opusFrame.length;
                    this.stats.frameSizes.push(opusFrame.length);
                    
                    // 测试模式下保存 Opus 帧
                    if (this.testMode) {
                        this.savedOpusFrames.push(new Uint8Array(opusFrame));
                    }
                    
                    // 发送到服务器
                    if (!this.testMode && this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                        let dataToSend;
                        if (opusFrame instanceof Uint8Array) {
                            dataToSend = opusFrame.buffer.slice(
                                opusFrame.byteOffset,
                                opusFrame.byteOffset + opusFrame.byteLength
                            );
                        } else {
                            dataToSend = opusFrame;
                        }
                        this.websocket.send(dataToSend);
                        log(`发送最后一个 Opus 帧: ${opusFrame.length} bytes`, 'debug');
                    }
                }
            }

            // 断开并清理 ScriptProcessorNode
            if (this.scriptProcessor) {
                this.scriptProcessor.disconnect();
                this.scriptProcessor.onaudioprocess = null;
                this.scriptProcessor = null;
            }

            // 停止媒体流
            if (this.mediaStream) {
                this.mediaStream.getTracks().forEach(track => track.stop());
                this.mediaStream = null;
            }

            if (this.audioSource) {
                this.audioSource.disconnect();
                this.audioSource = null;
            }

            if (this.visualizationRequest) {
                cancelAnimationFrame(this.visualizationRequest);
                this.visualizationRequest = null;
            }

            if (this.recordingTimer) {
                clearInterval(this.recordingTimer);
                this.recordingTimer = null;
            }

            // Send listen stop message
            if (!this.testMode && this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                const listenStopMsg = JSON.stringify({ type: 'listen', state: 'stop' });
                this.websocket.send(listenStopMsg);
                log('已发送录音停止消息: ' + listenStopMsg, 'info');
            }

            // Send end signal (empty frame)
            if (!this.testMode && this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                const emptyFrame = new Uint8Array(0);
                this.websocket.send(emptyFrame);
                log('已发送空帧作为结束信号', 'info');
            }

            // 更新统计结束时间
            this.stats.endTime = Date.now();
            this.stats.pcmBytes = this.totalAudioSize;
            this.stats.duration = (this.stats.endTime - this.stats.startTime) / 1000; // 秒

            // 计算平均帧大小
            if (this.stats.frameSizes.length > 0) {
                this.stats.avgFrameSize = this.stats.frameSizes.reduce((a, b) => a + b, 0) / this.stats.frameSizes.length;
                this.stats.minFrameSize = Math.min(...this.stats.frameSizes);
                this.stats.maxFrameSize = Math.max(...this.stats.frameSizes);
            }

            if (this.onRecordingStop) {
                this.onRecordingStop();
            }

            // 打印详细统计
            log(`📊 录音统计: ${this.stats.opusFrameCount} 帧, ${Math.floor(this.totalAudioSize / 1024)}KB PCM, ${this.stats.duration.toFixed(1)}秒`, 'info');
            log(`已停止 AudioContext + Opus 录音`, 'success');
            return true;
        } catch (error) {
            log(`录音停止错误: ${error.message}`, 'error');
            return false;
        }
    }

    // Get analyser
    getAnalyser() {
        return this.analyser;
    }

    // 获取录音统计
    getStats() {
        return { ...this.stats };
    }

    // 设置测试模式
    setTestMode(enabled) {
        this.testMode = enabled;
        log(`测试模式: ${enabled ? '开启' : '关闭'}`, 'info');
    }

    // 获取格式化的统计信息
    getFormattedStats() {
        const stats = this.stats;
        if (!stats.startTime) {
            return '暂无录音数据';
        }

        const lines = [
            '📊 录音统计报告',
            '─'.repeat(30),
            `⏱️  录音时长: ${stats.duration ? stats.duration.toFixed(2) : 0} 秒`,
            `🎤 PCM 数据: ${stats.pcmBytes ? (stats.pcmBytes / 1024).toFixed(2) : 0} KB`,
            `📦 Opus 帧: ${stats.opusFrameCount} 帧`,
            `📤 Opus 大小: ${(stats.totalOpusBytes / 1024).toFixed(2)} KB`,
            `📈 平均帧: ${stats.avgFrameSize ? stats.avgFrameSize.toFixed(1) : 0} bytes`,
            `📉 最小帧: ${stats.minFrameSize || 0} bytes`,
            `📈 最大帧: ${stats.maxFrameSize || 0} bytes`,
            '─'.repeat(30),
            `✅ 每秒帧数: ${stats.duration ? (stats.opusFrameCount / stats.duration).toFixed(1) : 0} fps`,
            `✅ 压缩比: ${stats.pcmBytes && stats.totalOpusBytes ? (stats.pcmBytes / stats.totalOpusBytes).toFixed(2) : 0}x`
        ];

        return lines.join('\n');
    }

    // 创建 WAV 文件
    _createWavBuffer(pcmData, sampleRate, numChannels, bitsPerSample) {
        const byteRate = sampleRate * numChannels * bitsPerSample / 8;
        const blockAlign = numChannels * bitsPerSample / 8;
        const dataSize = pcmData.length * 2; // Int16 = 2 bytes
        const buffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buffer);

        // WAV header
        const writeString = (offset, string) => {
            for (let i = 0; i < string.length; i++) {
                view.setUint8(offset + i, string.charCodeAt(i));
            }
        };

        writeString(0, 'RIFF');
        view.setUint32(4, 36 + dataSize, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true); // Subchunk1Size
        view.setUint16(20, 1, true); // AudioFormat (PCM)
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitsPerSample, true);
        writeString(36, 'data');
        view.setUint32(40, dataSize, true);

        // Write PCM data
        const int16Data = new Int16Array(buffer, 44);
        for (let i = 0; i < pcmData.length; i++) {
            int16Data[i] = pcmData[i];
        }

        return buffer;
    }

    // 播放录音
    async playRecording() {
        if (this.savedPcmData.length === 0) {
            log('没有录音数据可播放', 'warning');
            return false;
        }

        try {
            const audioContext = this.getAudioContext();

            // 恢复 AudioContext
            if (audioContext.state === 'suspended') {
                await audioContext.resume();
            }

            // 创建 WAV 文件
            const wavBuffer = this._createWavBuffer(
                this.savedPcmData,
                this.sampleRate,
                1,  // 单声道
                16  // 16-bit
            );

            // 解码 WAV 文件
            const audioBuffer = await audioContext.decodeAudioData(wavBuffer);

            // 创建音频源并播放
            const source = audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(audioContext.destination);

            // 播放完成后清理
            source.onended = () => {
                log('录音播放完成', 'info');
            };

            source.start(0);
            log(`开始播放录音: ${(this.savedPcmData.length / this.sampleRate).toFixed(2)} 秒`, 'success');
            return true;
        } catch (error) {
            log(`播放录音失败: ${error.message}`, 'error');
            return false;
        }
    }

    // 获取录音 Blob (可用于下载)
    getRecordingBlob() {
        if (this.savedPcmData.length === 0) {
            return null;
        }

        const wavBuffer = this._createWavBuffer(
            this.savedPcmData,
            this.sampleRate,
            1,
            16
        );

        return new Blob([wavBuffer], { type: 'audio/wav' });
    }

    // 下载录音
    downloadRecording(filename = 'recording.wav') {
        const blob = this.getRecordingBlob();
        if (!blob) {
            log('没有录音数据可下载', 'warning');
            return false;
        }

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        log(`录音已下载: ${filename}`, 'success');
        return true;
    }
}

// Create singleton instance
let audioRecorderInstance = null;

export function getAudioRecorder() {
    if (!audioRecorderInstance) {
        audioRecorderInstance = new AudioRecorder();
    }
    return audioRecorderInstance;
}

/**
 * Check if microphone is available
 * @returns {Promise<boolean>} Returns true if available, false if not available
 */
export async function checkMicrophoneAvailability() {
    // Check if browser supports getUserMedia API
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        log('浏览器不支持getUserMedia API', 'warning');
        return false;
    }
    try {
        // Try to access microphone
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000, channelCount: 1 } });
        // Immediately stop all tracks to release microphone
        stream.getTracks().forEach(track => track.stop());
        log('麦克风可用性检查成功', 'success');
        return true;
    } catch (error) {
        log(`麦克风不可用: ${error.message}`, 'warning');
        return false;
    }
}

/**
 * Check if it is HTTP non-localhost access
 * @returns {boolean} Returns true if it is HTTP non-localhost access
 */
export function isHttpNonLocalhost() {
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    // Check if it is HTTP protocol
    if (protocol !== 'http:') {
        return false;
    }
    // localhost and 127.0.0.1 can use microphone
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return false;
    }
    // Private IP addresses can also use microphone (browser allows)
    if (hostname.startsWith('192.168.') || hostname.startsWith('10.') || hostname.startsWith('172.')) {
        return false;
    }
    // Other HTTP access is considered non-localhost
    return true;
}
