/**
 * 默认语言（托底）文案包：config.json → language.default = zh|ja|en
 * - STATUS_TEXTS: 固件屏幕状态文案覆盖表，key = 固件当前中文原文（zh-CN locale），
 *   服务器经 {"type":"i18n","map":{...}} 下发，固件 SetStatus 入口查表替换。
 * - MODE_LABELS / FIXED_TEXTS: 服务器自产文本（模式标签、固定播报）。
 */

export const STATUS_TEXTS = {
  zh: {},  // 固件内置即中文，下发空表=清除覆盖
  ja: {
    '正在初始化...': '初期化中...',
    '检测模组...': 'モジュールを検出中...',
    '等待网络...': 'ネットワーク接続待機中...',
    '检查新版本...': '新しいバージョンを確認中...',
    '激活设备': 'デバイスをアクティベート',
    '登录服务器...': 'サーバーにログイン中...',
    '待命': '待機中',
    '连接中...': '接続中...',
    '聆听中...': 'リスニング中...',
    '说话中...': '話しています...',
    '错误': 'エラー',
    '警告': '警告',
    '信息': '情報',
    '版本 ': 'バージョン ',
    '连接 ': '接続先 '
  },
  en: {
    '正在初始化...': 'Initializing...',
    '检测模组...': 'Detecting module...',
    '等待网络...': 'Waiting for network...',
    '检查新版本...': 'Checking for new version...',
    '激活设备': 'Activation',
    '登录服务器...': 'Logging in...',
    '待命': 'Standby',
    '连接中...': 'Connecting...',
    '聆听中...': 'Listening...',
    '说话中...': 'Speaking...',
    '错误': 'Error',
    '警告': 'Warning',
    '信息': 'Information',
    '版本 ': 'Ver ',
    '连接 ': 'Connect to '
  }
};

/**
 * 口语模式专属状态文案覆盖（在 STATUS_TEXTS 基础上叠加，key 仍为固件中文原文）：
 * 倾听中提示用户开口；作答提交后设备回待机，实际在等评分回调，故显示「分析中」。
 */
export const PRACTICE_STATUS_OVERRIDES = {
  zh: { '聆听中...': '请说话', '待命': '分析中' },
  ja: { '聆听中...': '話してください', '待命': '分析中' },
  en: { '聆听中...': 'Please speak', '待命': 'Analyzing...' }
};

/** 首段已识别后叠加（覆盖 聆听中 文案）：多段作答时提示继续更自然 */
export const PRACTICE_STATUS_CONTINUE = {
  zh: { '聆听中...': '请继续' },
  ja: { '聆听中...': '続けてください' },
  en: { '聆听中...': 'Please continue' }
};

/**
 * 休息模式专属状态文案覆盖（叠加）：固件 idle 态状态栏固定显示「待命」，
 * 与聊天闲置无法区分；休息时把「待命」改显为休息词（需固件状态栏
 * 使用 font_mode_20_4 扩展字体，否则缺字形）。
 * 同时映射「说话中.../聆听中...」：被动放送与重连竞态下固件可能停在
 * speaking 原始串上（idle 刷新被跳过时状态栏不会回到「待命」），而休息
 * 本就是一个展示态：设备在听/在说属于服务端的推流，不该改写屏幕口径。
 * 退出休息（`_clearRestDisplay`）会重发 i18n 覆盖表，这些映射随之解除。
 */
export const REST_STATUS_OVERRIDES = {
  zh: { '待命': '休息', '说话中...': '休息', '聆听中...': '休息' },
  ja: { '待命': '休憩', '说话中...': '休憩', '聆听中...': '休憩' },
  en: { '待命': 'Rest', '说话中...': 'Rest', '聆听中...': 'Rest' }
};

export const MODE_LABELS = {
  zh: { dev: '开发', chat: '聊天', employee: '员工', rest: '休息', practice: '口语' },
  ja: { dev: '開発', chat: 'チャット', employee: 'スタッフ', rest: '休憩', practice: 'スピーチ' },
  en: { dev: 'Dev', chat: 'Chat', employee: 'Staff', rest: 'Rest', practice: 'Practice' }
};

export const FIXED_TEXTS = {
  zh: {
    welcome: '你好！我是小智，有什么可以帮助你的吗？',
    restEnter: '好的，我休息了。需要我的时候请说出唤醒词叫我',
    restExit: '好的，我回来啦，有事随时叫我',
    wakeAnnounce: '好的，我醒啦，随时可以叫我',
    faceFound: '太好了，我找到你啦！',
    faceFoundNamed: '太好了，是 {name} 来啦！',
    practiceEnter: '已进入口语练习模式，请开始讲述。说完请按按钮，或说「自动结束」由我判断',
    practiceExit: '已退出口语练习模式，回到普通聊天',
    practiceEndManual: '已切换为手动结束：讲完请按按钮收卷',
    practiceEndAuto: '已切换为自动结束：我会判断你是否说完',
    practiceNone: '没有听到讲述内容'
  },
  ja: {
    welcome: 'こんにちは、小智です。何をお手伝いしましょうか？',
    restEnter: 'わかりました、休憩します。必要な時はウェイクワードを呼んでください',
    restExit: 'はい、戻りました。用があったらいつでも呼んでください',
    wakeAnnounce: 'はい、起きました。いつでも呼んでください',
    faceFound: '見つけました！',
    faceFoundNamed: '{name}さんを見つけました！',
    practiceEnter: 'スピーチ練習モードに入りました。どうぞ話してください。終了はボタンを押すか、「自動終了」とお伝えください',
    practiceExit: 'スピーチ練習モードを終了しました',
    practiceEndManual: '手動終了に切り替えました。話し終わったらボタンを押してください',
    practiceEndAuto: '自動終了に切り替えました。話し終わった私が判断します',
    practiceNone: 'スピーチ内容が聞こえませんでした'
  },
  en: {
    welcome: 'Hi, I am Xiaozhi. How can I help you?',
    restEnter: 'Okay, taking a rest. When you need me, just say the wake word',
    restExit: 'Alright, I am back. Call me whenever you need',
    wakeAnnounce: 'Okay, I am awake. Call me anytime',
    faceFound: 'Found you!',
    faceFoundNamed: 'Found {name}!',
    practiceEnter: 'Speaking practice mode is on. Please start talking. Press the button when done, or say "auto end" and I will judge',
    practiceExit: 'Left speaking practice mode, back to normal chat',
    practiceEndManual: 'Switched to manual end: press the button when you finish',
    practiceEndAuto: 'Switched to auto end: I will detect when you are done',
    practiceNone: 'I did not hear any speech content'
  }
};

/** 取当前默认语言（ttsService 构造注入/设置端点热更） */
export function currentLang(ttsService) {
  return ttsService?.defaultLanguage || 'zh';
}

export function fixedText(lang, key) {
  return (FIXED_TEXTS[lang] || FIXED_TEXTS.zh)[key] || FIXED_TEXTS.zh[key];
}
