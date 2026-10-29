#!/usr/bin/env node
/**
 * Xiaozhi Server 独立运行入口（standalone，不依赖 galaclaw）
 * 启动：node run-server.js   或   npm start
 * 设备端 OTA 地址：http://<HOST>:<PORT>/xiaozhi/ota/   WebSocket 由服务端下发
 */
import { XiaozhiChannel } from './index.js';
import { EventEmitter } from 'events';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import crypto from 'crypto';
import { createStudioRouter, createManageAuth, consoleSessionUser } from './studio/routes.js';
import { studioConfig } from './studio/config.js';
import { streamStart, streamStop, streamStatus, facesList } from './studio/lib/masterpi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

/** standalone 无 gala 总线：用空实现保证 publish/监听安全 no-op */
class SimpleBus extends EventEmitter {
  async publish(message) { /* 独立模式：不外发到主智能体；LLM 由 config.llm.provider=openai/dsh 承担 */ }
}

async function main() {
  console.log('🚀 Xiaozhi Server (standalone) 启动中…');
  let config = {};
  const configPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  config.port = Number(process.env.XIAOZHI_PORT || process.env.PORT || config.port || 8003);
  config.host = process.env.XIAOZHI_HOST || process.env.HOST || config.host || '0.0.0.0';

  const channel = new XiaozhiChannel(config, new SimpleBus());
  await channel.start();

  // Mount the Firmware Studio onto the SAME server (single process, single port).
  if (channel.app) {
    // Console login: config.json manage.password (empty = open access, local default)
    studioConfig.managePassword = (config.manage && config.manage.password) || process.env.XIAOZHI_MANAGE_PASSWORD || '';
    channel.app.use('/firmware', createManageAuth(studioConfig));

    // Cloud-edge auth gate for the public /api/homekit relay (hub role only; no-op on branch).
    // Primary: studio console session cookie (browser, same-origin). Compat: X-Xiaozhi-Key ==
    // voiceFlow.token so the native iOS app keeps working until it gains a login flow.
    const keyOk = (a, b) => {
      if (!a || !b) return false;
      const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
      return x.length === y.length && crypto.timingSafeEqual(x, y);
    };
    channel.homekitGuard = (req) => {
      if (consoleSessionUser(studioConfig, req)) return true;
      const got = req.headers['x-xiaozhi-key'] || (req.body && req.body.token) || '';
      return keyOk(got, channel.config && channel.config.voiceFlow && channel.config.voiceFlow.token);
    };

    // Login page: the built Element Plus console login (studio/web) when present,
    // otherwise the standalone legacy login.html.
    const appDir = path.join(__dirname, 'studio', 'public', 'app');
    const builtLogin = path.join(appDir, 'login.html');
    const nsOf = (req) => (String(req.originalUrl || '').startsWith('/xiaozhi') ? '/xiaozhi' : '');
    channel.app.get('/firmware/login', (req, res) => {
      if (fs.existsSync(builtLogin)) {
        const back = req.query.redirect ? `?redirect=${encodeURIComponent(String(req.query.redirect))}` : '';
        return res.redirect(`${nsOf(req)}/firmware/app/login.html${back}`);
      }
      return res.sendFile(path.join(__dirname, 'studio', 'public', 'login.html'));
    });

    // Canonical console is the built SFC app (studio/web -> public/app).
    // The legacy single-file console (studio/public/index.html) is retired; keep
    // old entry URLs and bookmarks redirecting to the SFC build.
    channel.app.get(['/firmware', '/firmware/', '/firmware/index.html'], (req, res) => {
      res.redirect(`${nsOf(req)}/firmware/app/`);
    });

    // Vendor assets for the no-build Vue 3 + Element Plus workbench UI.
    const nm = path.join(__dirname, 'node_modules');
    const vendorFiles = {
      '/vue.js': 'vue/dist/vue.global.prod.js',
      '/element-plus.js': 'element-plus/dist/index.full.min.js',
      '/element-plus.css': 'element-plus/dist/index.css',
      '/element-plus-dark.css': 'element-plus/theme-chalk/dark/css-vars.css',
      '/icons.js': '@element-plus/icons-vue/dist/index.iife.min.js',
      '/locale-zh-cn.js': 'element-plus/dist/locale/zh-cn.min.js',
      '/esptool.js': 'esptool-js/bundle.js',
    };
    for (const [u, rel] of Object.entries(vendorFiles)) {
      channel.app.get(`/firmware/vendor${u}`, (req, res) => res.sendFile(path.join(nm, rel)));
    }
    channel.app.use('/firmware', express.static(path.join(__dirname, 'studio', 'public')));
    channel.app.use('/firmware/api', createStudioRouter(studioConfig, {
      // Interface-management page writes the SAME config.json the running server
      // loaded, then asks it to re-resolve/re-compile in place (no restart).
      configPath,
      onInterfacesChanged: () => channel.reloadInterfaces(),
    }));

    // MasterPi 人脸登记 LAN 控制口（免鉴权，与 /api/homekit/* /api/mcp/call 同级可信）：
    // 摄像头 MJPEG 预览的启停/状态 + 人脸库列表。登记/云台微调/登录走 /api/mcp/call 直调身体。
    channel.app.get('/api/masterpi/stream/status', (_req, res) => { try { res.json(streamStatus(studioConfig)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
    channel.app.post('/api/masterpi/stream/start', (_req, res) => { try { res.json(streamStart(studioConfig)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
    channel.app.post('/api/masterpi/stream/stop', (_req, res) => { try { res.json(streamStop(studioConfig)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
    channel.app.get('/api/masterpi/faces', (_req, res) => { try { res.json(facesList(studioConfig)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });

    console.log(`   工作台 : http://localhost:${config.port}/firmware/  (data/bin -> ${studioConfig.dataBinDir})`);
    console.log(`   工作台(工程版 Vue+ElementPlus) : http://localhost:${config.port}/firmware/app/${fs.existsSync(builtLogin) ? '' : '  [not built: pnpm --dir studio/web build]'}`);
  }

  console.log('\n==================================================');
  console.log(`✅ 运行中   HTTP : http://${config.host}:${config.port}`);
  console.log(`   OTA    : http://<本机LAN_IP>:${config.port}/xiaozhi/ota/`);
  console.log(`   WS     : ws://<本机LAN_IP>:${config.port}/xiaozhi/v1/`);
  console.log(`   健康   : http://localhost:${config.port}/health`);
  console.log('   LLM 走 bridge（config.llm.provider=openai|dsh），不依赖 gala');
  console.log('==================================================\n');

  const bye = async (sig) => {
    console.log(`\n🛑 收到 ${sig}，正在停止…`);
    try { await channel.stop(); } catch (e) { console.error('停止异常:', e.message); }
    process.exit(0);
  };
  process.on('SIGINT', () => bye('SIGINT'));
  process.on('SIGTERM', () => bye('SIGTERM'));
}

main().catch((e) => { console.error('❌ 启动失败:', e); process.exit(1); });
