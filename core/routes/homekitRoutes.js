/**
 * HomeKit (方案A) LAN dev routes: status / pair / control / scan / rename / settings.
 * Extracted verbatim from index.js setupRoutes; behavior unchanged.
 */
import fs from 'fs';
import { channelLogger } from '../../utils/logger.js';

export function registerHomeKitRoutes(app, ctx) {
  const configPath = ctx.configPath;

  // HomeKit（方案A）局域网开发口：状态 / 配对 / 直控（绕过 LLM，方便联调）。
  app.get('/api/homekit/status', (_req, res) => {
    try {
      res.json({ ok: true, ...(ctx.homekitService ? ctx.homekitService.getStatus() : { enabled: false, paired: [], lights: [] }) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post('/api/homekit/pair', async (req, res) => {
    try {
      const { pin, deviceName } = req.body || {};
      if (!ctx.homekitService) return res.json({ ok: false, error: 'HomeKit 服务未初始化' });
      const status = await ctx.homekitService.pairNow(pin, deviceName);
      ctx.mcpService.setHomeKitService(ctx.homekitService); // 刷新工具池
      res.json({ ok: true, ...status });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/homekit/control', async (req, res) => {
    try {
      const { light, power, brightness, color_temp } = req.body || {};
      if (!ctx.homekitService) return res.json({ ok: false, error: 'HomeKit 服务未初始化' });
      const result = await ctx.homekitService.applyControl(light, { power, brightness, color_temp });
      res.json({ ok: true, result });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // 批量读取已接入灯具的实时状态（并行+超时保护，供控制区回填开关/亮度）。
  app.post('/api/homekit/state', async (_req, res) => {
    try {
      if (!ctx.homekitService) return res.json({ ok: false, error: 'HomeKit 服务未初始化' });
      res.json({ ok: true, states: await ctx.homekitService.getStates() });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // 扫描局域网 HomeKit 配件（不配对，供家庭设备页展示）。
  app.post('/api/homekit/scan', async (_req, res) => {
    try {
      if (!ctx.homekitService) return res.json({ ok: false, error: 'HomeKit 服务未初始化' });
      const devices = await ctx.homekitService.scan();
      res.json({ ok: true, devices });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // 灯具重命名：热更新内存映射 + 持久化 config.json → homekit.names（语音播报/工具描述同步生效）。
  app.post('/api/homekit/rename', (req, res) => {
    try {
      const { light, name } = req.body || {};
      if (!ctx.homekitService) return res.json({ ok: false, error: 'HomeKit 服务未初始化' });
      if (!light) return res.json({ ok: false, error: 'light 必填' });
      const names = ctx.homekitService.renameLight(light, name);
      let persisted = false;
      try {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        fs.writeFileSync(configPath + '.bak', JSON.stringify(raw, null, 2)); // 备份原文件
        raw.homekit = { ...(raw.homekit || {}), names };
        fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
        ctx.config.homekit = raw.homekit;
        persisted = true;
      } catch (e) {
        channelLogger.warn(`config.json homekit.names persist failed: ${e.message}`);
      }
      ctx.mcpService.refreshTools(); // 工具描述里的灯名刷新
      res.json({ ok: true, light, name, persisted });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // 家庭设备设置：读取 + 热更新 + 持久化 config.json → homekit（enabled/deviceName/discoveryTimeoutMs）。
  app.get('/api/homekit/settings', (_req, res) => {
    const hk = ctx.config.homekit || {};
    res.json({ ok: true, settings: { enabled: hk.enabled === true, deviceName: hk.deviceName || '', discoveryTimeoutMs: hk.discoveryTimeoutMs || 15000 } });
  });
  app.post('/api/homekit/settings', (req, res) => {
    try {
      const s = req.body || {};
      const next = {
        enabled: !!s.enabled,
        deviceName: String(s.deviceName || ''),
        discoveryTimeoutMs: Number(s.discoveryTimeoutMs) > 0 ? Number(s.discoveryTimeoutMs) : 15000
      };
      if (ctx.homekitService) ctx.homekitService.saveSettings(next);
      let persisted = false;
      try {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        fs.writeFileSync(configPath + '.bak', JSON.stringify(raw, null, 2)); // 备份原文件
        raw.homekit = { ...(raw.homekit || {}), ...next };
        fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
        ctx.config.homekit = raw.homekit;
        persisted = true;
      } catch (e) {
        channelLogger.warn(`config.json homekit persist failed: ${e.message}`);
      }
      res.json({ ok: true, settings: next, persisted });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
}
