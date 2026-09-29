/**
 * WebSocket 消息类型常量定义
 * 集中管理所有通信消息类型，便于维护和统一管理
 */

// ==================== 客户端发送的消息类型 ====================
export const CLIENT_MESSAGE_TYPES = {
    // 协议握手消息
    HELLO: 'hello',           // 设备握手消息
    LISTEN: 'listen',         // 监听控制消息
    ABORT: 'abort',           // 中断/终止消息
    IOT: 'iot',               // IoT设备控制消息
    CHAT: 'chat',             // 聊天消息

    // 功能消息
    MCP: 'mcp',               // MCP协议消息
    START_RECOGNITION: 'start_recognition', // 开始语音识别
    AUDIO_DATA: 'audio_data', // 音频数据上传
    WAKE_WORD_DETECTED: 'wake_word_detected', // 唤醒词检测通知
    FRIEND: 'friend',         // 好友消息（客户端间通信）

    // 管理消息
    ECHO: 'echo',             // 回显测试消息
};

// ==================== 服务端发送的消息类型 ====================
export const SERVER_MESSAGE_TYPES = {
    // 连接相关
    CONNECTION_ACK: 'connection_ack',     // 连接确认
    ERROR: 'error',                       // 错误消息

    // 协议响应
    HELLO: 'hello',                       // 握手响应
    RECOGNITION_STARTED: 'recognition_started', // 识别开始确认

    // 语音处理流程
    STT: 'stt',                           // 语音识别结果
    LLM: 'llm',                           // 大语言模型回复
    TTS: 'tts',                           // 文本转语音状态
    TTS_FALLBACK: 'tts_fallback',         // TTS降级文本
    TTS_DISABLED: 'tts_disabled',         // TTS未启用
    MCP: 'mcp',
    SLEEP: 'sleep',                       // 设备休眠指令（息屏，仅本地唤醒词可唤醒）
    // 音频处理
    AUDIO_RECEIVED: 'audio_received',     // 音频接收确认
    WAKE_WORD_ACKNOWLEDGED: 'wake_word_acknowledged', // 唤醒词确认

    // 好友消息
    FRIEND: 'friend',                     // 好友消息转发
    FRIEND_ACK: 'friend_ack',             // 好友消息确认

    // 管理界面消息
    STATUS: 'status',                     // 状态更新
    MESSAGE: 'message',                   // 消息通知

    // 用户界面显示
    USER: 'user',                         // 用户消息
    BOT: 'bot',                           // 机器人消息
    SYSTEM: 'system',                     // 系统消息
};

// ==================== TTS子状态类型 ====================
export const TTS_STATES = {
    START: 'start',           // 开始合成
    SENTENCE_START: 'sentence_start', // 句子开始（带文本）
    PLAYING: 'playing',       // 正在播放
    STOP: 'stop',             // 停止播放
};

// ==================== 监听状态类型 ====================
export const LISTEN_STATES = {
    START: 'start',           // 开始监听
    STOP: 'stop',             // 停止监听
    DETECT: 'detect',         // 检测模式
};

// ==================== 聊天状态类型 ====================
export const CHAT_STATES = {
    COMPLETE: 'complete',     // 消息完整
    PROCESSING: 'processing', // 处理中
    COMPLETED: 'completed',
};

// ==================== MCP消息类型 ====================
export const MCP_MESSAGE_TYPES = {
    INITIALIZE: 'initialize', // 初始化消息
    CALL_TOOL: 'call_tool',   // 调用工具
    RESULT: 'result',         // 执行结果
    ERROR: 'error',           // 错误响应
};

// ==================== 好友消息数据类型 ====================
export const FRIEND_MESSAGE_TYPES = {
    TEXT: 'text',             // 文本消息
    COMMAND: 'command',       // 命令消息
    DATA: 'data',             // 数据消息
};

// ==================== 导出便捷访问 ====================
// 合并所有消息类型供外部使用
export const MESSAGE_TYPES = {
    ...CLIENT_MESSAGE_TYPES,
    ...SERVER_MESSAGE_TYPES,
    TTS_STATES,
    LISTEN_STATES,
    CHAT_STATES,
    MCP_MESSAGE_TYPES,
    FRIEND_MESSAGE_TYPES
};

// ==================== 类型验证辅助函数 ====================
export const isValidMessageType = (type) => {
    return Object.values(MESSAGE_TYPES).some(category =>
        typeof category === 'object'
            ? Object.values(category).includes(type)
            : category === type
    );
};

export const isClientMessageType = (type) => {
    return Object.values(CLIENT_MESSAGE_TYPES).includes(type);
};

export const isServerMessageType = (type) => {
    return Object.values(SERVER_MESSAGE_TYPES).includes(type);
};

// ==================== 反向查找函数 ====================
export const getMessageTypeName = (typeValue) => {
    for (const [categoryName, category] of Object.entries(MESSAGE_TYPES)) {
        if (typeof category === 'object') {
            for (const [name, value] of Object.entries(category)) {
                if (value === typeValue) {
                    return `${categoryName}.${name}`;
                }
            }
        } else if (category === typeValue) {
            return categoryName;
        }
    }
    return 'UNKNOWN';
};

export default MESSAGE_TYPES;