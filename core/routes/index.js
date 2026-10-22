/**
 * API routes orchestrator.
 *
 * setupRoutes() in the channel builds a live-reference context (services are
 * hot-replaced after start, so ctx exposes getters, not snapshots) and calls
 * registerApiRoutes, which mounts each feature module in order.
 *
 * Kept in the channel (not here): /health, OTA endpoints (device protocol face),
 * the /xiaozhi prefix-stripping middleware, and the WebSocket upgrade.
 */
import { registerDeviceRoutes } from './deviceRoutes.js';
import { registerBroadcastRoutes } from './broadcastRoutes.js';
import { registerVoiceFlowRoutes } from './voiceFlowRoutes.js';
import { registerMcpRoutes } from './mcpRoutes.js';
import { registerVisionRoutes } from './visionRoutes.js';
import { registerHomeKitRoutes } from './homekitRoutes.js';

export function registerApiRoutes(app, ctx) {
  registerDeviceRoutes(app, ctx);
  registerBroadcastRoutes(app, ctx);
  registerVoiceFlowRoutes(app, ctx);
  registerMcpRoutes(app, ctx);
  registerVisionRoutes(app, ctx);
  registerHomeKitRoutes(app, ctx);
}
