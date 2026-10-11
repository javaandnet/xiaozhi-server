---
kind: error_handling
name: 错误处理：基于原生 Error 与 try/catch 的分散式处理模式
category: error_handling
scope:
    - '**'
source_files:
    - utils/logger.js
    - core/services/base.js
    - config/loader.js
    - core/handlers/websocket.js
    - core/handlers/ota.js
    - core/managers/device.js
    - index.js
---

## 1. 总体方案

仓库没有统一的错误类型体系、错误码枚举或全局中间件。错误处理采用 **Node.js 原生 `Error` + 局部 `try/catch`** 的分散式模式，辅以自研 `utils/logger.js` 作为结构化日志输出。

- 未定义自定义错误类（如 `AppError`、业务错误码常量）。
- 未使用 `process.on('uncaughtException' | 'unhandledRejection')` 等全局捕获。
- Express 路由层没有统一 error middleware；每个路由自行 `try/catch` 并返回 JSON。
- WebSocket 层在连接/消息回调内包裹 try/catch，避免单条消息异常拖垮进程。

## 2. 关键文件与位置

| 文件 | 职责 |
|---|---|
| `utils/logger.js` | 唯一日志门面，提供 `logger` 与 `channelLogger`，支持 `XZ_LOG_LEVEL` / `XZ_LOG_TO_FILE` / `XZ_LOG_DIR` 环境变量 |
| `config/loader.js` | 配置加载与校验，失败时抛 `Error` 并记录日志 |
| `core/services/base.js` | 所有服务的基类，封装 `initialize/destroy/healthCheck` 的错误边界 |
| `core/handlers/websocket.js` | WebSocket 连接/消息/断开的错误边界 |
| `core/handlers/ota.js` | OTA 升级流程的错误处理 |
| `core/managers/device.js` | 设备注册/更新/批量更新的错误抛出与收集 |
| `index.js` | Express 路由层的错误响应与启动/停止阶段的全局 catch |

## 3. 架构与约定

### 3.1 服务基类错误边界 (`core/services/base.js`)

`BaseService.initialize()` / `destroy()` 包裹子类 `_initialize()` / `_destroy()`，catch 后 `console.error` 再 `throw error`，保证初始化失败能向上传播给 `XiaozhiChannel.initializeServices()`。

`healthCheck()` 是例外：它 catch 内部 `_healthCheck()` 的异常，返回 `{ status: 'unhealthy', error }` 而非抛错，用于对外暴露健康状态。

### 3.2 配置加载错误 (`config/loader.js`)

- `loadConfig()` 在配置文件缺失时 `throw new Error('Configuration file not found: ...')`，并在 catch 中 `console.error` 后重新抛出。
- `validateConfig()` 收集多个字段缺失信息，最后一次性 `throw new Error('Configuration validation failed:\n...')`。

### 3.3 WebSocket 层 (`core/handlers/websocket.js`)

- `handleConnection` 中 `dm.addDevice` 调用被 try/catch 包裹，失败时通过 `this.sendError(ws, '设备注册失败')` 发送 WS 错误帧，然后 `ws.close(1008, 'device registration failed')`，注释明确说明“禁止让异常冒泡到 ws upgrade 回调拖垮整个服务进程”。
- `ws.on('message', ...)` 对每条消息包裹 try/catch，失败时 `logger.error` 并 `sendError(ws, '消息处理失败')`。
- `ws.on('error', ...)` 仅记录日志，不重抛。

### 3.4 OTA 处理器 (`core/handlers/ota.js`)

- `refreshBinCache()` 对文件系统 I/O 做 try/catch，失败返回空对象 `{}` 而非抛错。
- `generatePasswordSignature()` 对 crypto 操作 try/catch，失败返回空字符串 `''`。
- `_notifyDeviceReport()` 包装上层回调，吞掉异常并记录日志，确保 OTA 主流程不受设备上报副作用影响。

### 3.5 设备管理器 (`core/managers/device.js`)

- 验证失败、容量超限、设备不存在等场景直接 `throw new Error(...)`，由调用方决定如何响应。
- `batchUpdate()` 对每个设备的更新单独 try/catch，将失败累积到 `results.errors[]`，实现“部分成功”语义。

### 3.6 Express 路由层 (`index.js`)

- 启动阶段 `start()` 用 try/catch 包裹全部初始化步骤，失败时 `channelLogger.logModuleError(error, '频道启动失败')` 后重新 throw。
- 停止阶段 `stop()` 和 `cleanupServices()` 各自 try/catch，避免清理过程抛错导致进程退出。
- HTTP 路由（如 `/xiaozhi/ota/` POST、`/xiaozhi/ota/download/:filename`）各自 try/catch，失败时返回 `res.status(500).json({ success: false, message: 'request error' })` 之类的 JSON。
- 参数校验失败直接 `return res.status(400).json({ ok: false, error: '...' })`，不走异常路径。

### 3.7 日志系统 (`utils/logger.js`)

- 双门面：`logger`（info/warn/error/debug/verbose）和 `channelLogger`（logModuleInit/logModuleStart/logModuleStop/logOperation/logModuleError）。
- 默认输出到 `logs/server.log`，可通过 `XZ_LOG_DIR`、`XZ_LOG_LEVEL`、`XZ_LOG_TO_FILE=0` 控制。
- `channelLogger.logModuleError(err, msg)` 会同时写入 `err.message` 与 `err.stack`。

## 4. 观察到的约定与约束

- **业务异常以原生 `Error` 表示**，消息体为中文描述（如 `设备数据验证失败: ...`、`设备数量已达上限: 10000`、`设备不存在: ${clientId}`），未见错误码枚举。
- **可恢复的 I/O 错误倾向于 catch 后降级返回**（OTA 缓存为空对象、签名返回空串、配置持久化失败只 warn），而不是向上抛错中断请求。
- **不可恢复的初始化错误（配置缺失、服务初始化失败）向上抛出**，由 `XiaozhiChannel.start()` 顶层 catch 统一记录。
- **WebSocket 消息处理绝不向外抛错**：每条消息 try/catch，错误通过 `sendError` 回推客户端，防止单条消息崩溃整个服务器。
- **Express 没有全局 error handler**：每个路由自行判断并返回 JSON，错误格式不统一（有的用 `{ ok: false, error }`，有的用 `{ success: false, error }`，有的用 `{ error }`）。
- **无 `panic/recover` 等价物**：代码中没有 `process.on('uncaughtException')` 或类似的全局兜底，依赖 Node 默认的未捕获异常行为。
- **日志与错误分离**：`logger` 负责记录，`Error` 负责传播；两者不耦合，但 `channelLogger.logModuleError` 会把 `stack` 一并写入元数据。