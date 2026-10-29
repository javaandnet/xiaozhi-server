# MasterPi 故障排查档案

按案例记录已查明的硬件/链路故障：证据、根因、处置、复发判定标准。以后再遇同类现象先对照这里，别从应用层重猜。

---

## 案例 1：摄像头频繁黑屏 "no frame (retrying)"（2026-10-23 定案）

### 现象
- 预览画面高频出现黑底红字 `no frame (retrying)`，一旦显示约持续一分钟才恢复。
- stream 进程活着、server/网页链路正常，重连按钮能立刻恢复但过会儿又黑。

### 取证（关键三步，按序做）
1. **stream 自身日志**（派上 `/tmp/vstream.log`，由 server SSH 拉起时重定向）：
   ```
   [ WARN] cap_v4l.cpp:889 requestBuffers VIDEOIO(V4L2:...icspring...):
           failed VIDIOC_REQBUFS: errno=19 (No such device)
   ERROR camera grab stuck >60s; self-restarting
   ```
   `errno=19 No such device` = 设备节点已从内核消失，不是被占用（占用是 EBUSY=16）。
2. **内核 USB 日志**（一锤定音）：
   ```
   dmesg | grep -iE "usb|video" | tail -25
   ```
   实测：`usb 1-2: USB disconnect, device number 4` → 数秒内 `new high-speed USB
   device number 5/6/7` 反复重枚举；**开机 19 分钟掉 5 次**，全部是相机
   （icSpring UVC，`idVendor=32e6 idProduct=9005`）。
3. **挂起配置**：`cat /sys/module/usbcore/parameters/autosuspend` → 默认 `2`（秒）。

### 根因
相机在 **USB 总线层物理掉盘**（断开→重枚举），与 web/server/stream 软件逻辑无关。
两大嫌疑：
1. **usbcore autosuspend=2**：内核把短暂空闲的 USB 设备挂起，廉价 UVC 相机易被误伤。
2. **供电/线材**：电池经扩展板供电时舵机/电机浪涌拉低 5V 轨（相机最先掉）；
   或排线接触不良（机器人本体抖动）。注意 Pi 5 不一定留 under-voltage 日志，
   dmesg 无欠压记录不能排除供电问题。

### 已做处置（三层）
| 层 | 措施 | 位置 |
|---|---|---|
| 防掉盘 | `echo -1 > /sys/module/usbcore/parameters/autosuspend`（运行时） | 派，重启失效 |
| 防掉盘（持久） | udev 规则：该相机 `power/control=on` | 派 `/etc/udev/rules.d/99-icspring-no-suspend.rules` |
| 加速自愈 | `STUCK_RESTART_SEC 60 → 10`：黑屏窗口从 ~65s 缩到 ~12s | `masterpi/vision_stream.py`（已同步派 `~/masterpi_client/`） |
| 手动兜底 | 页面告警条 +「🔄 重连摄像头」按钮（meta.status 透传 no frame） | CameraPreview.vue / useFaceStream.js |

### 复发判定
- autosuspend 关闭后不再掉/极少掉 → 结案（软件挂起误伤）。
- **仍然周期性掉** → 硬件，按序排除：①相机排线重新插紧/换线；②换适配器供电对比
  （大动作瞬间掉盘=供电浪涌实锤）；③换 Pi 另一 USB 口。
- 快速自检命令：`dmesg | grep -c "USB disconnect"`（对比开机时长算掉盘频率）。

---

## 案例 2：底盘四方向整体旋转 90°（2026-10-23 定案）

- 现象：点"前进"机器右移、点"左移"机器后退，前端多轮翻符号无法修复。
- 根因：`masterpi/robot.py drive()` 的 `set_velocity(velocity, deg, ang)` 角度映射与
  本机硬件实际差 90°；且 SDK `common/mecanum.py` 文档注释与实测也相反，不可信。
- 实测定版口径：**180°=前进、0°=后退、90°=右移、270°=左移**（turn 只传 angular_rate）。
- 教训：方向屡翻不对时停止下游试错，回查最底层库的坐标约定并**受控实测逐轴定版**。

## 案例 3：MCP 僵尸连接致工具调用超时（2026-10-23 定案）

- 现象：设备断电重启后，云台/底盘指令全部"工具调用请求超时"。
- 根因：server 收不到旧 ws 的 close，`deviceClients` 留死条目；超时清理路径
  只删条目**不关底层 socket**，派侧持半开连接永不重连。
- 修复：`core/services/mcp.js` 清理时 `conn.close(1011, ...)` 与删条目成对执行。
- 应急：`sudo systemctl restart masterpi-client`（派侧强制重连）。
- 特征识别：派 journalctl 在某时刻后完全无输出 = 半开连接静默。
