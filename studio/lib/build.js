/**
 * 构建任务管理器：build.py 权威构建 → 注入私有 OTA 地址 → 增量 idf.py build
 * 全过程日志流式回传（SSE），产出纯 app 镜像 build/xiaozhi.bin。
 */
import { randomUUID } from 'crypto';
import { run, shq, SSE } from './util.js';

const jobs = new Map(); // jobId -> job

export function getJob(id) { return jobs.get(id); }
export function listJobs() {
  return [...jobs.values()].map((j) => ({
    id: j.id, status: j.status, board: j.board, name: j.name, type: j.type,
    version: j.version, artifact: j.artifact, startedAt: j.startedAt, endedAt: j.endedAt,
    error: j.error,
  }));
}

/**
 * 启动一个构建任务（非阻塞，立即返回 jobId）。
 * @param {object} cfg
 * @param {{board:string,name:string,type:string,otaUrl?:string}} opts
 */
export function startBuild(cfg, opts) {
  const { board, name, type } = opts;
  if (!board || !name || !type) {
    return { error: '缺少 board / name / type 参数' };
  }
  const otaUrl = opts.otaUrl || cfg.otaUrl;
  const otaUrlFallback = opts.otaUrlFallback ?? cfg.otaUrlFallback ?? '';
  const ww = opts.wakeWord && String(opts.wakeWord.word || '').trim() ? opts.wakeWord : null;
  const flash8 = String(opts.flashSize || '') === '8MB'; // 8MB flash 设备：切 v2/8m 分区表
  const script = [
    'set -o pipefail',
    'set -e',
    `echo "[xz-studio] 环境: 加载 ESP-IDF"` ,
    `export IDF_PYTHON_ENV_PATH=${shq(cfg.idfPythonEnv || (process.env.HOME + '/.espressif/python_env/idf6.1_py3.12_env'))}`,
    `source ${shq(cfg.idfExport)}`,
    `cd ${shq(cfg.repoDir)}`,
    `echo "[xz-studio] 1/3 官方构建 build.py $XZ_BOARD --name $XZ_NAME"`,
    `python scripts/build.py "$XZ_BOARD" --name "$XZ_NAME"`,
    `echo "[xz-studio] 2/3 注入私有 OTA 地址: $XZ_OTA"`,
    `perl -0pi -e 's/^CONFIG_OTA_URL=.*$/CONFIG_OTA_URL="$ENV{XZ_OTA}"/m' sdkconfig || true`,
    `grep -q '^CONFIG_OTA_URL=' sdkconfig || printf '\\nCONFIG_OTA_URL="%s"\\n' "$XZ_OTA" >> sdkconfig`,
    `grep '^CONFIG_OTA_URL=' sdkconfig || echo "[xz-studio] 警告: 未在 sdkconfig 找到 CONFIG_OTA_URL"`,
    `if [ -n \"$XZ_OTA2\" ]; then echo \"[xz-studio] 2b 注入备用 OTA 地址: $XZ_OTA2\"; grep -q '^CONFIG_OTA_URL_FALLBACK=' sdkconfig && perl -0pi -e 's/^CONFIG_OTA_URL_FALLBACK=.*$/CONFIG_OTA_URL_FALLBACK="$ENV{XZ_OTA2}"/m' sdkconfig || printf '\\nCONFIG_OTA_URL_FALLBACK=\"%s\"\\n' \"$XZ_OTA2\" >> sdkconfig; fi`,
    `if [ -n "$XZ_WW" ]; then echo "[xz-studio] 2c 注入自定义唤醒词(Multinet): $XZ_WW"; perl -0pi -e 's/^CONFIG_USE_AFE_WAKE_WORD=y$/# CONFIG_USE_AFE_WAKE_WORD is not set/m; s/^CONFIG_USE_ESP_WAKE_WORD=y$/# CONFIG_USE_ESP_WAKE_WORD is not set/m; s/^CONFIG_WAKE_WORD_DISABLED=y$/# CONFIG_WAKE_WORD_DISABLED is not set/m; s/^# CONFIG_USE_CUSTOM_WAKE_WORD is not set$/CONFIG_USE_CUSTOM_WAKE_WORD=y/m; s/^CONFIG_USE_CUSTOM_WAKE_WORD=.*$/CONFIG_USE_CUSTOM_WAKE_WORD=y/m' sdkconfig || true; grep -q '^CONFIG_USE_CUSTOM_WAKE_WORD=' sdkconfig || echo 'CONFIG_USE_CUSTOM_WAKE_WORD=y' >> sdkconfig; grep -q '^CONFIG_CUSTOM_WAKE_WORD=' sdkconfig && perl -0pi -e 's/^CONFIG_CUSTOM_WAKE_WORD=.*$/CONFIG_CUSTOM_WAKE_WORD="$ENV{XZ_WW}"/m' sdkconfig || printf '\\nCONFIG_CUSTOM_WAKE_WORD="%s"\n' "$XZ_WW" >> sdkconfig; grep -q '^CONFIG_CUSTOM_WAKE_WORD_DISPLAY=' sdkconfig && perl -0pi -e 's/^CONFIG_CUSTOM_WAKE_WORD_DISPLAY=.*$/CONFIG_CUSTOM_WAKE_WORD_DISPLAY="$ENV{XZ_WW_DISP}"/m' sdkconfig || printf '\\nCONFIG_CUSTOM_WAKE_WORD_DISPLAY="%s"\n' "$XZ_WW_DISP" >> sdkconfig; grep -q '^CONFIG_CUSTOM_WAKE_WORD_THRESHOLD=' sdkconfig && perl -0pi -e 's/^CONFIG_CUSTOM_WAKE_WORD_THRESHOLD=.*$/CONFIG_CUSTOM_WAKE_WORD_THRESHOLD=$ENV{XZ_WW_TH}/m' sdkconfig || printf '\\nCONFIG_CUSTOM_WAKE_WORD_THRESHOLD=%s\n' "$XZ_WW_TH" >> sdkconfig; fi`,
    `if [ "$XZ_FLASH8" = "1" ]; then echo "[xz-studio] 2d 切换 8MB flash 布局(partitions/v2/8m.csv)"; perl -0pi -e 's/^CONFIG_ESPTOOLPY_FLASHSIZE_(1MB|2MB|4MB|16MB|32MB|64MB|128MB)=y$/# CONFIG_ESPTOOLPY_FLASHSIZE_$1 is not set/m; s/^# CONFIG_ESPTOOLPY_FLASHSIZE_8MB is not set$/CONFIG_ESPTOOLPY_FLASHSIZE_8MB=y/m; s/^CONFIG_ESPTOOLPY_FLASHSIZE=".*"$/CONFIG_ESPTOOLPY_FLASHSIZE="8MB"/m; s|^CONFIG_PARTITION_TABLE_CUSTOM_FILENAME=.*$|CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="partitions/v2/8m.csv"|m' sdkconfig; grep -q '^CONFIG_ESPTOOLPY_FLASHSIZE_8MB=y' sdkconfig || { echo 'CONFIG_ESPTOOLPY_FLASHSIZE_8MB=y' >> sdkconfig; echo 'CONFIG_ESPTOOLPY_FLASHSIZE="8MB"' >> sdkconfig; echo 'CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="partitions/v2/8m.csv"' >> sdkconfig; }; fi`,
    `idf.py build`,
    `echo "[xz-studio] 3/3 产出纯 app 镜像"`,
    `ls -la build/xiaozhi.bin`,
    `VER=$(sed -nE 's/^set\\(PROJECT_VER "([^"]+)"\\)/\\1/p' CMakeLists.txt | head -1)`,
    `echo "__XZ_ARTIFACT__ $XZ_TYPE \${VER} $(pwd)/build/xiaozhi.bin"`,
  ].join('\n');
  const id = randomUUID();
  const job = {
    id, status: 'running', board, name, type, otaUrl,
    version: null, artifact: null, logs: [],
    startedAt: Date.now(), endedAt: null, error: null,
  };
  jobs.set(id, job);
  // 清理历史，最多保留 30 个
  if (jobs.size > 30) {
    const oldest = [...jobs.values()].filter((j) => j.status !== 'running')
      .sort((a, b) => a.startedAt - b.startedAt)[0];
    if (oldest) jobs.delete(oldest.id);
  }


  const push = (line) => {
    job.logs.push(line);
    if (job.logs.length > 5000) job.logs.shift();
    SSE.send('build:log', { id, line });
  };

  run(script, {
    cwd: cfg.repoDir,
    timeoutMs: cfg.buildTimeoutMs || 1800000,
    onLine: (line) => {
      const m = line.match(/^__XZ_ARTIFACT__ (\S+) (\S+) (.+)$/);
      if (m) { job.artifactType = m[1]; job.version = m[2]; job.artifact = m[3]; }
      push(line);
    },
    env: {
      XZ_BOARD: board, XZ_NAME: name, XZ_TYPE: type, XZ_OTA: otaUrl, XZ_OTA2: otaUrlFallback,
      XZ_WW: ww ? String(ww.word).trim() : '',
      XZ_WW_DISP: ww ? (ww.display || String(ww.word).trim()) : '',
      XZ_WW_TH: ww ? Math.min(99, Math.max(1, Number(ww.threshold) || 20)) : 20,
      XZ_FLASH8: flash8 ? '1' : '',
    },
  }).then((r) => {
    job.endedAt = Date.now();
    if (r.code === 0 && job.artifact) {
      job.status = 'success';
    } else {
      job.status = 'failed';
      job.error = r.code === 0 ? '构建结束但未产出 app 镜像（可能编译报错）' : `退出码 ${r.code}`;
    }
    SSE.send('build:done', { id, status: job.status, version: job.version, artifact: job.artifact, error: job.error });
  });

  return { jobId: id };
}
