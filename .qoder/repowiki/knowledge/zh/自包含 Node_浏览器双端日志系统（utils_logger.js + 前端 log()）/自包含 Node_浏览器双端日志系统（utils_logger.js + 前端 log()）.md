---
kind: logging_system
name: 自包含 Node/浏览器双端日志系统（utils/logger.js + 前端 log()）
category: logging_system
scope:
    - '**'
source_files:
    - utils/logger.js
    - public/chat/js/utils/logger.js
    - logs/server.log
---

## 1. 使用的系统与框架

本项目没有引入第三方日志库，而是实现了一个**自包含的 logger**（`utils/logger.js`），注释明确说明“不再依赖 galaclaw 的 moduleLogger”。该模块同时承担后端与前端两个运行时的日志职责：

- **Node 服务端**：输出到 `console`（`error` 走 `console.error`，其余走 `console.log`）并可选地追加写入文件。
- **Web 客户端**（`public/chat/js/utils/logger.js`）：将带时间戳的日志条目渲染为 DOM 节点，显示在页面 `#logContainer` 中，同时回退到 `console.log`。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `utils/logger.js` | 服务端唯一日志入口，导出 `logger` 与 `channelLogger` |
| `public/chat/js/utils/logger.js` | 前端日志函数 `log(message, type)` |
| `logs/server.log` | 默认日志文件路径 |
| `.env.example` | 记录 `XZ_LOG_LEVEL`、`XZ_LOG_DIR`、`XZ_LOG_TO_FILE` 三个环境变量 |

被导入的后端模块（18 个）统一通过相对路径 `../../utils/logger.js` 引入：`core/handlers/*`、`core/managers/*`、`core/services/*`、`core/utils/audioConverter.js`。前端各子模块（audio、mcp、network）通过 `../../utils/logger.js?v=0205` 引入前端的 `log()`。

## 3. 架构与约定

### 3.1 日志级别

后端定义五个级别，数值越大优先级越高：

```
verbose: 5, debug: 10, info: 20, warn: 30, error: 40
```

默认最小级别 `MIN = LEVELS[process.env.XZ_LOG_LEVEL || 'info']`，即 `info`。低于 `MIN` 的消息在 `write()` 中直接返回，不产生 I/O。

### 3.2 输出格式

每行形如：

```
[2025-01-01T12:00:00.000Z] [INFO] 模块初始化: device | {"component":"device"}
```

- 时间戳使用 ISO 字符串。
- 级别大写。
- 可选的 `meta` 对象经 `safe()` 处理（undefined/null/空串 → `''`，否则 `JSON.stringify`，失败则 `String(o)`）后以 ` | <json>` 拼接。
- `error` 级别额外把错误对象的 `message` 和 `stack` 注入 meta。

### 3.3 双 API

- `logger.info/debug/warn/error/verbose(message, meta)`：通用结构化日志。
- `channelLogger.logModuleInit/logModuleStart/logModuleStop/logOperation/logModuleError`：面向“模块生命周期”的便捷方法，内部统一拼出“模块初始化 / 模块启动 / 模块停止 / 模块错误”等中文消息头，并把 `component` 或 `module` 字段作为 meta 透出。

### 3.4 文件输出

- 默认目录 `./logs`（由 `path.join(__dirname, '..', 'logs')` 计算）。
- 文件名固定 `server.log`。
- 通过 `fs.mkdirSync(LOG_DIR, { recursive: true })` 自动创建目录。
- 写入使用 `fs.appendFileSync`（同步追加，无轮转）。
- 可通过环境变量关闭：`XZ_LOG_TO_FILE=0`。

### 3.5 前端日志

前端 `log(message, type)` 支持类型 `info` / `debug` / `warning` / `success` / `error`，按类型设置 CSS class `log-entry log-{type}` 和内联颜色（error→red、debug→gray、warning→orange、success→green）。若页面不存在 `#logContainer`，则降级为 `console.log`。

## 4. 约定与约束

- **统一入口**：所有后端业务模块通过 `import { logger } from '../../utils/logger.js'` 使用日志，未见直接使用 `console.log` 的业务日志（仅 `config/loader.js` 中的配置加载调试信息仍用裸 `console.log/console.error`）。
- **环境变量驱动**：
  - `XZ_LOG_LEVEL`：控制最小级别（verbose/debug/info/warn/error），默认 `info`。
  - `XZ_LOG_DIR`：覆盖日志目录，默认 `./logs`。
  - `XZ_LOG_TO_FILE`：值为 `'0'` 时禁用文件输出，默认开启。
- **结构化元数据**：所有日志调用接受第二个参数 `meta` 对象，用于携带上下文（如 `component`、`module`、`deviceId`、`sessionId` 等），由 `safe()` 序列化进同一行。
- **错误堆栈自动注入**：`channelLogger.logModuleError(err, message, meta)` 会把 `err.stack` 合并进 meta，便于排查异常。
- **无日志轮转**：文件始终追加到 `server.log`，代码中未实现任何切割策略。
- **前后端分离实现**：后端基于 Node `fs`/`console`，前端基于 DOM，两者互不共享；这是仓库内两套独立的日志子系统，而非单一模块的双端适配。