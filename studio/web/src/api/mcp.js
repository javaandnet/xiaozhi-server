/** device-MCP endpoints: provider status, tool list, direct call, action catalog. */
import { apiGet, apiPost } from './http';

export const getMcpStatus = () => apiGet('/api/mcp/status');

export const listDeviceTools = (device) => apiGet(`/api/mcp/tools?device=${encodeURIComponent(device)}`);

export const callDeviceTool = ({ device, tool, args }) => apiPost('/api/mcp/call', { device, tool, args });

export const getRobotActionTypes = () => apiGet('/api/robot/action-types');

/* MasterPi MJPEG preview over the main channel (peer-forwarded on the cloud). */
export const getStreamStatusXz = () => apiGet('/api/masterpi/stream/status');
export const startStreamXz = (mode) => apiPost('/api/masterpi/stream/start', mode ? { mode } : {});
export const stopStreamXz = () => apiPost('/api/masterpi/stream/stop', {});
export const setStreamModeXz = (mode) => apiPost('/api/masterpi/stream/mode', { mode });

/* 看家(watch)模式:事件列表/快照/播报开关;快照图 URL 直接给 <img> 用。 */
export const getWatchEventsXz = (since = 0) => apiGet(`/api/masterpi/stream/watch/events?since=${since}`);
export const getAnnounceXz = () => apiGet('/api/masterpi/stream/watch/announce');
export const setAnnounceXz = (announce) => apiPost('/api/masterpi/stream/watch/announce', { announce });

/* 底盘安全开关（派侧 robot.allowChassis，默认 false=轮子锁定）；云端经 peer 转发家里读写。 */
export const getSafetyXz = () => apiGet('/api/masterpi/safety');
export const setSafetyXz = (allowChassis) => apiPost('/api/masterpi/safety', { allowChassis });

/* 机器人软关机（SSH shutdown -h）；关机后需按物理电源才能再开。 */
export const shutdownRobotXz = () => apiPost('/api/masterpi/shutdown', {});
export const speakRobotVoiceXz = (body) => apiPost('/api/masterpi/speak', body);
// IK 微调：基准由 server 统一维护（Web/iOS 共用），dir 为方向语义
export const ikJogXz = ({ body, dir }) => apiPost('/api/masterpi/ik/jog', { body, dir });
// 重连身体：SSH 重启派侧 client（僵尸连接假在线时一键自愈）
export const reconnectRobotXz = () => apiPost('/api/masterpi/reconnect', {});
