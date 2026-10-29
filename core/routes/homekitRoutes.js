/**
 * HomeKit (方案A) LAN dev routes: status / pair / control / scan / rename / settings.
 * Extracted verbatim from index.js setupRoutes; behavior unchanged.
 */
import fs from 'fs';
import { channelLogger } from '../../utils/logger.js';

export function registerHomeKitRoutes(app, ctx) {
  const configPath = ctx.configPath;

  // Peer-link federation (hub/cloud): HomeKit accessories are only reachable on
  // the home LAN, so while the branch is online every /api/homekit/* request is
  // executed at home and relayed back verbatim. Branch-offline or already-via
  // requests fall through to the local handlers below (empty local result).
  const hlink = ctx.peerLink;
  if (hlink && hlink.isHub) {
    // Cloud-edge auth gate: on the public hub /api/homekit must never run anonymously
    // (branch LAN keeps the open behavior — this block only registers when role=hub).
    // Guard is injected by run-server; when unset (legacy mounts) preserve open flow.
    app.use('/api/homekit', (req, res, next) => {
      const guard = ctx.homekitGuard;
      if (!guard) return next();
      if (req.headers['x-peer-via']) return next(); // internal relay is already trusted
      if (guard(req)) return next();
      return res.status(401).json({ ok: false, error: 'login required' });
    });
    app.use('/api/homekit', async (req, res, next) => {
      if (req.headers['x-peer-via'] || !hlink.branchOnline()) return next();
      const slow = req.path === '/scan' || req.path === '/pair'; // discovery/pairing can exceed 15s
      const r = await hlink.dispatch(req.method, '/api/homekit' + req.path, req.body ?? null, slow ? 45000 : 15000);
      if (r.error) {
        console.warn(`[xiaozhi] homekit peer forward failed (${req.path}): ${r.error}`);
        return next();
      }
      return res.status(r.httpStatus).json({ ...(r.body || {}), via: 'home' });
    });
  }

  // HomeKit（方案A）局域网开发口：状态 / 配对 / 直控（绕过 LLM，方便联调）。
  app.get('/api/homekit/status', (_req, res) => {
    try {
      const status = ctx.homekitService ? ctx.homekitService.getStatus() : { enabled: false, paired: [], lights: [] };
      // 启动时的历史名称键迁移（挂错配件）顺手持久化，保持 config.json 与内存映射一致
      if (ctx.homekitService && JSON.stringify(ctx.config?.homekit?.names || {}) !== JSON.stringify(ctx.homekitService.names)) {
        try {
          const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          fs.writeFileSync(configPath + '.bak', JSON.stringify(raw, null, 2));
          raw.homekit = { ...(raw.homekit || {}), names: ctx.homekitService.names };
          fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
          ctx.config.homekit = raw.homekit;
          channelLogger.info('config.json homekit.names updated by legacy key migration');
        } catch (e) {
          channelLogger.warn(`config.json homekit.names migration persist failed: ${e.message}`);
        }
      }
      res.json({ ok: true, ...status });
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
      const { light, accessoryId, power, brightness, color_temp } = req.body || {};
      if (!ctx.homekitService) return res.json({ ok: false, error: 'HomeKit 服务未初始化' });
      const result = await ctx.homekitService.applyControl(light, { power, brightness, color_temp }, accessoryId || null);
      res.json({ ok: true, result });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // 批量读取已接入灯具的实时状态（并行+超时保护，供控制区回填开关/亮度）。
  // states 为 { [accessoryId]: { [lightKey]: state } }，灯具键只在配件内唯一。
  app.post('/api/homekit/state', async (_req, res) => {
    try {
      if (!ctx.homekitService) return res.json({ ok: false, error: 'HomeKit 服务未初始化' });
      res.json({ ok: true, states: await ctx.homekitService.getStates() });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // 扫描局域网 HomeKit 配件（不配对，供家庭设备页展示）；附带本机已索引的可控灯具供行选中联动。
  app.post('/api/homekit/scan', async (_req, res) => {
    try {
      if (!ctx.homekitService) return res.json({ ok: false, error: 'HomeKit 服务未初始化' });
      const devices = await ctx.homekitService.scan();
      for (const d of devices) d.lights = ctx.homekitService.getLightsForAccessory(d.id).map((l) => ({ key: l.key, name: l.name }));
      res.json({ ok: true, devices });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // 灯具重命名：热更新内存映射 + 持久化 config.json → homekit.names（语音播报/工具描述同步生效）。
  app.post('/api/homekit/rename', (req, res) => {
    try {
      const { light, name, accessoryId } = req.body || {};
      if (!ctx.homekitService) return res.json({ ok: false, error: 'HomeKit 服务未初始化' });
      if (!light) return res.json({ ok: false, error: 'light 必填' });
      const names = ctx.homekitService.renameLight(light, name, accessoryId || null);
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
