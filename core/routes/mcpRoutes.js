/**
 * Device-MCP (robot body) routes: status / tools / call / dev call-tool.
 * Extracted verbatim from index.js setupRoutes; behavior unchanged.
 */
import { vfAuthorized } from './auth.js';

export function registerMcpRoutes(app, ctx) {
  // 机器人硬件（device-MCP 工具提供方）在线状态：管理平台展示“硬件是否在线 / 可用工具数”
  app.get('/api/mcp/status', (req, res) => {
    try {
      if (!ctx.mcpService || typeof ctx.mcpService.getDeviceProviderStatus !== 'function') {
        return res.json({ ok: true, providers: [], readyProviders: 0, totalTools: 0 });
      }
      res.json({ ok: true, ...ctx.mcpService.getDeviceProviderStatus() });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // 管理平台：对某台在线硬件“定向”直调 device-MCP 工具（绕过 LLM，方便测试）。
  // 与 /api/mcp/status 同为局域网开发口；device 取行的 device_id/mac/clientId（_findDeviceClient 大小写不敏感）。
  app.get('/api/mcp/tools', (req, res) => {
    try {
      const key = String(req.query.device || '');
      if (!key) return res.json({ ok: false, error: 'device 必填' });
      const list = (ctx.mcpService.getFunctionDescriptionsForProvider(key) || [])
        .map((t) => ({ name: t.function && t.function.name, description: t.function && t.function.description, parameters: (t.function && t.function.parameters) || {} }));
      res.json({ ok: true, device: key, tools: list });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post('/api/mcp/call', async (req, res) => {
    try {
      const { device, tool, args } = req.body || {};
      if (!device || !tool) return res.json({ ok: false, error: 'device 与 tool 必填' });
      const stubConn = { clientId: '__http_cmd__', features: { mcp: true }, send: () => {} };
      // 传入 boundProviderKey=device：仅路由到该硬件，不回退全局
      const result = await ctx.mcpService.callDeviceMcpTool(stubConn, tool, args || {}, 30, String(device));
      res.json({ ok: true, device: String(device), tool, result: result == null ? null : String(result) });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // Dev/test: 直接触发某设备的 device-MCP 工具（绕过 LLM），用于联调工具路由/执行闭环。
  // 仅当配置了 voiceFlow.token 时注册，且端点自身走 vfAuthorized（X-Xiaozhi-Key）二次鉴权。
  if (ctx.config.voiceFlow && ctx.config.voiceFlow.token) {
    app.post('/api/mcp/call-tool', async (req, res) => {
      const auth = vfAuthorized(ctx.config, req);
      if (!auth.ok) return res.status(auth.code).json({ success: false, error: auth.error });
      try {
        const { tool, args } = req.body || {};
        if (!tool) return res.json({ success: false, error: 'missing tool' });
        // 归属设备由 callDeviceMcpTool 内部按 hasTool 路由；此处传占位连接即可
        const stubConn = { clientId: '__http_dev__', features: { mcp: true }, send: () => {} };
        const result = await ctx.mcpService.callDeviceMcpTool(stubConn, tool, args || {});
        res.json({ success: true, tool, result: result == null ? null : String(result) });
      } catch (e) {
        res.json({ success: false, error: e.message });
      }
    });
  }
}
