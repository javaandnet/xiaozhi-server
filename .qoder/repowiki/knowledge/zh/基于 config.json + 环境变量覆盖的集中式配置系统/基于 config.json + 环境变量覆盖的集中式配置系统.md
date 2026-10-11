---
kind: configuration_system
name: 基于 config.json + 环境变量覆盖的集中式配置系统
category: configuration_system
scope:
    - '**'
source_files:
    - config/loader.js
    - config/constants.js
    - .env.example
    - index.js
    - studio/config.js
---

## 1. 采用的方案

仓库使用自实现的 `ConfigLoader`（`config/loader.js`）作为唯一配置入口，从根目录的 `config.json` 加载 JSON 配置，并在内存中用一组环境变量做运行时覆盖。没有引入 dotenv、yaml/toml 解析器或外部配置中心；Secrets（如 `AIBRIDGE_API_KEY`）以明文环境变量形式注入。

## 2. 关键文件与包

- `config/loader.js` — `ConfigLoader` 类，单例导出 `configLoader`，并提供 `getConfig` / `getServerConfig` / `getSttConfig` / `getTtsConfig` / `getFunasrConfig` / `getLlmConfig` / `getChannelInfo` / `validateConfig` 等便捷方法。
- `config/constants.js` — 在模块顶层调用 loader 暴露频道常量（`CHANNEL_ID`、`DEFAULT_CONFIG`、`DEFAULT_SERVICES`、各类枚举），供 `core/` 消费。
- `index.js` — 主进程启动时调用 `getConfig()` / `getServerConfig()` 获取端口、主机、LLM/TTS/STT 配置并初始化服务。
- `.env.example` — 文档化所有支持的环境变量键名及默认值。
- `studio/config.js` — 固件工作台后端共享同一份 `config.json`，读取其中的 `firmware` 段以及 `llm` / `stt.funasr` 派生服务探测地址。

## 3. 架构与约定

### 3.1 配置文件位置与格式

- 配置文件固定路径：`path.join(__dirname, '../config.json')`（即仓库根目录 `config.json`），由 `ConfigLoader.configPath` 硬编码。
- 文件格式为纯 JSON，无 schema 校验（除 `validateConfig` 对必填字段做简单检查）。
- 通过 `reloadConfig()` 清空缓存后重新 `fs.readFileSync` + `JSON.parse`，实现运行时热重载。

### 3.2 加载顺序与覆盖规则

`applyEnvironmentOverrides()` 按以下优先级合并（从高到低）：

1. 环境变量（`process.env.*`）
2. `config.json` 中的对应字段
3. 代码内默认值

当前支持的覆盖项：

| 配置域 | 环境变量 | 覆盖目标 |
|---|---|---|
| 服务器 | `XIAOZHI_PORT` / `PORT` | `config.port`（默认 8003） |
| 服务器 | `XIAOZHI_HOST` / `HOST` | `config.host`（默认 '0.0.0.0'） |
| STT | `STT_PROVIDER` | `config.stt.provider`（默认 'funasr'） |
| STT | `STT_LANGUAGE` | `config.stt.language`（默认 'zh-CN'） |
| TTS | `TTS_PROVIDER` | `config.tts.provider`（默认 'edge'） |
| TTS | `TTS_VOICE` | `config.tts.voice`（默认 'zh-CN-XiaoxiaoNeural'） |
| FunASR | `FUNASR_HOST` / `FUNASR_PORT` / `FUNASR_MODE` | `config.stt.funasr.{host,port,mode}` |

其他在 `.env.example` 中出现但未被 `applyEnvironmentOverrides` 处理的变量（如 `XZ_DB_PATH`、`XZ_LOG_LEVEL`、`XZ_LOG_TO_FILE`、`USE_HTTPS`、`AIBRIDGE_API_KEY`）由业务代码直接读取 `process.env`，不走 ConfigLoader。

### 3.3 单例与惰性加载

- `ConfigLoader` 是 ESM 模块级单例（`export const configLoader = new ConfigLoader()`）。
- `loadConfig()` 内部缓存 `this.config`，重复调用直接返回；`reloadConfig()` 显式置空缓存。
- `constants.js` 在模块顶层立即调用 getter 把配置值“拍平”为常量，因此这些常量反映的是**首次 import 时刻**的配置快照。

### 3.4 验证与默认值

`validateConfig()` 检查：
- 顶层必填：`id`、`name`
- `stt.provider`、`stt.language`
- `tts.provider`、`tts.voice`

未设置时各 getter 提供安全默认值（例如 `getSttConfig()` 返回 `{ provider: 'funasr', language: 'zh-CN', sampleRate: 16000, channels: 1 }`），因此大多数下游调用不会因缺失字段而抛错。

### 3.5 运行时热更新

`index.js` 暴露 `/api/settings/audio`（GET/POST），允许在线修改 VAD/音频阈值：
- POST 写入内存 `this.config.audio` / `this.config.vad`；
- 尝试写回磁盘 `config.json`（失败仅 warn，不阻断响应）；
- 通过 `initializeWebSocketHandler().updateAudioThresholds(...)` 即时生效。

### 3.6 Studio 子模块共享配置

`studio/config.js` 通过 `process.env.XZ_CONFIG || path.join(root, 'config.json')` 定位同一份 `config.json`，读取 `firmware` 段，并从主配置的 `llm.baseUrl` / `stt.funasr.host/port` 派生服务健康检查 URL，保证 voice server 与 firmware studio 共用一份配置源。

## 4. 约定与约束

- **单一配置源**：所有服务端配置来自 `config.json`，通过 `config/loader.js` 访问；禁止各模块各自 `require('config.json')`。
- **环境变量覆盖范围有限**：只有 `port/host/stt/tts/funasr` 五组字段会被 `applyEnvironmentOverrides` 处理；其余环境变量需在各业务模块自行读取 `process.env`。
- **Secrets 不加密**：`AIBRIDGE_API_KEY` 等凭据以明文环境变量注入，仓库未集成任何 secrets manager。
- **配置校验非强制**：`validateConfig()` 存在但未见在启动流程中被调用，因此缺少必填字段只会导致下游 getter 返回默认值而非启动失败。
- **静态常量快照**：`config/constants.js` 在模块加载时取值，后续 `reloadConfig()` 不会刷新已导出的 `CHANNEL_ID` / `DEFAULT_SERVICES` 等常量。
- **Studio 与主服务共享文件**：`studio/config.js` 与 `config/loader.js` 都读同一个 `config.json`，并通过 `XZ_CONFIG` 环境变量可切换路径。