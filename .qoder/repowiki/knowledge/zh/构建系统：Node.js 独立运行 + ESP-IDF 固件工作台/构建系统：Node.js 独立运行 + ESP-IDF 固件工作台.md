---
kind: build_system
name: 构建系统：Node.js 独立运行 + ESP-IDF 固件工作台
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - run-server.js
    - studio/config.js
    - studio/lib/build.js
    - studio/lib/install.js
    - studio/lib/env.js
    - studio/lib/util.js
---

## 1. 整体方案

本项目采用**双轨构建**：
- **服务端运行时**：纯 Node.js ESM 单进程应用，通过 `package.json` 的 `scripts.start` (`node run-server.js`) 启动，无 Webpack/Vite 等前端构建步骤。
- **固件工作台（Firmware Studio）**：作为 Express 子模块挂载在同一 HTTP 端口上，提供编译、安装、烧录、源码同步能力，驱动外部 ESP-IDF 工具链完成 ESP32 固件构建与 OTA 镜像生成。

没有 Makefile、Dockerfile、CI pipeline；部署形态是“直接 `npm start` 运行”。

## 2. 关键文件

- `package.json` — 唯一依赖声明与脚本入口（`start` / `dev`），声明 `engines.node >= 18`。
- `run-server.js` — 独立运行入口，加载 `.env` + `config.json`，启动 `XiaozhiChannel`，并挂载 `/firmware` 静态资源与 `/firmware/api` REST/SSE 路由。
- `studio/config.js` — 从主 `config.json` 的 `firmware` 段派生工作台配置，默认值指向本机 ESP-IDF 路径与 `data/bin`。
- `studio/lib/build.js` — 构建任务管理器：非阻塞地调用 `python scripts/build.py` → `perl` 注入 `CONFIG_OTA_URL` → `idf.py build`，产出 `build/xiaozhi.bin`。
- `studio/lib/install.js` — 固件安装/删除、USB 直刷 (`idf.py -p PORT flash`)、源码同步 (`git pull` + `submodule update`)。
- `studio/lib/env.js` — 环境探测：ESP-IDF 健康检查、板型枚举 (`build.py --list-boards --json`)、串口扫描、macOS USB 描述符解析 (`ioreg`)、GitHub Releases 查询。
- `studio/lib/util.js` — 通用工具：`bash -lc` 命令执行封装 (`run`)、shell 引号转义 (`shq`)、SSE 广播、GitHub JSON 抓取。

## 3. 架构与约定

### 3.1 服务端构建
- 无打包器：Vue 3 + Element Plus 的 Studio 前端以 CDN 方式从 `node_modules` 直接 serve（`/firmware/vendor/*` 映射到 `element-plus/dist/*.js`、`vue/dist/vue.global.prod.js` 等）。
- 仅依赖 `dotenv` 加载 `.env`，其余配置来自 `config.json`。
- 进程信号处理：`SIGINT` / `SIGTERM` 触发 `channel.stop()` 后 `process.exit(0)`。

### 3.2 固件构建流水线（ESP-IDF）
构建由 `studio/lib/build.js:startBuild()` 编排，顺序为：
1. 设置 `IDF_PYTHON_ENV_PATH` 并 `source <idfExport>`。
2. 调用 `python scripts/build.py "$XZ_BOARD" --name "$XZ_NAME"`（官方构建脚本）。
3. 用 `perl -0pi` 修改 `sdkconfig`，注入 `CONFIG_OTA_URL`（及可选 `CONFIG_OTA_URL_FALLBACK`）。
4. 可选：根据 `flashSize=8MB` 切换分区表 `partitions/v2/8m.csv`。
5. 可选：启用自定义唤醒词 Multinet 相关 `CONFIG_*` 开关。
6. 执行 `idf.py build`，产物为 `build/xiaozhi.bin`。
7. 从 `CMakeLists.txt` 中 `set(PROJECT_VER "x.y.z")` 提取版本号，通过特殊日志行 `__XZ_ARTIFACT__ <type> <ver> <path>` 回传工件信息。

所有构建任务在内存 `jobs: Map<jobId, job>` 中管理，最多保留 30 条历史，日志上限 5000 行，并通过 SSE 事件 `build:log` / `build:done` 流式推送。

### 3.3 固件安装与命名约定
- 已安装固件存放于 `data/bin/`，文件名格式强制为 `{model}_{version}.bin`（正则 `^[A-Za-z0-9.\-_]+$`）。
- `installFirmware()` 实现版本保护：若目标已存在且版本 ≥ 新传入版本，需显式 `confirm=true` 才覆盖。
- `removeFirmware()` 校验路径不在 `cfg.dataBinDir` 之外（防目录穿越）。

### 3.4 设备识别与板型枚举
- 板型清单通过 `build.py --list-boards --json` 获取，结果缓存 60s。
- 设备注册表读取 SQLite 库 `xz.db`（`sqlite3 -json` 输出）。
- macOS 下通过 `ioreg -p IOUSB -l -w0` 解析 USB 序列号（即 MAC 地址）并与注册表匹配，自动推断当前插接设备的 board/type。
- 串口枚举过滤 Bluetooth/debug-console 设备，默认 glob `/dev/cu.usb*`。

### 3.5 配置来源优先级
Studio 配置按以下优先级合并（从高到低）：
1. 环境变量：`XZ_CONFIG`、`XZ_DATA_BIN`、`XZ_DB_PATH`、`XZS_PORT`、`XZS_HOST`、`XZS_REPO`、`XZS_IDF_EXPORT`、`XZS_IDF_PYTHON`、`XZS_DATA_BIN`、`XZS_DEVICE_DB`、`XZS_OTA_URL`。
2. `config.json` 的 `firmware` 段。
3. 代码内默认值（如 `repoDir` 默认 `/Users/fengleiren/git/xiaozhi-esp32`，`idfExport` 默认 `$HOME/esp/esp-idf/export.sh`）。

## 4. 约定与约束

- **Node 版本要求**：`package.json` 的 `engines.node >= 18`，项目使用 ESM（`"type": "module"`）。
- **构建产物位置固定**：固件构建必须产出 `build/xiaozhi.bin`，否则任务标记为 failed（见 `build.js` 第 51、93 行）。
- **SDK 配置注入规则**：`CONFIG_OTA_URL` 必须存在于 `sdkconfig`，不存在则追加；备用 OTA 地址通过 `CONFIG_OTA_URL_FALLBACK` 注入。
- **危险操作确认机制**：`installFirmware`（覆盖已有固件）、`removeFirmware`（删除固件）、`flashUsb`（USB 直刷改写设备固件）、`syncSource`（git pull/checkout）均返回 `needConfirm`，前端需二次确认才能执行。
- **命令执行安全**：所有 shell 参数经 `shq()` 单引号包裹转义，避免注入；工作目录限定为 `cfg.repoDir`。
- **超时保护**：构建默认 30 分钟 (`buildTimeoutMs || 1800000`)，USB 烧录 10 分钟，源码同步 5 分钟，超时后 `SIGKILL` 子进程。
- **无 CI/Docker**：仓库未包含任何 CI 配置文件或 Dockerfile，发布流程依赖 GitHub Releases API（`checkOfficial` 拉取 `repos/{owner}/releases/latest`）。
- **版本来源**：固件版本号取自 ESP-IDF 工程的 `CMakeLists.txt` 中的 `PROJECT_VER`，与服务端 `package.json` 的版本号无关。