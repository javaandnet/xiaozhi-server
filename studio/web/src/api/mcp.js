/** device-MCP endpoints: provider status, tool list, direct call, action catalog. */
import { apiGet, apiPost } from './http';

export const getMcpStatus = () => apiGet('/api/mcp/status');

export const listDeviceTools = (device) => apiGet(`/api/mcp/tools?device=${encodeURIComponent(device)}`);

export const callDeviceTool = ({ device, tool, args }) => apiPost('/api/mcp/call', { device, tool, args });

export const getRobotActionTypes = () => apiGet('/api/robot/action-types');
