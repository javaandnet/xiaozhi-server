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
import { createStudioRouter } from './studio/routes.js';
import { studioConfig } from './studio/config.js';

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
    // Vendor assets for the no-build Vue 3 + Element Plus workbench UI.
    const nm = path.join(__dirname, 'node_modules');
    const vendorFiles = {
      '/vue.js': 'vue/dist/vue.global.prod.js',
      '/element-plus.js': 'element-plus/dist/index.full.min.js',
      '/element-plus.css': 'element-plus/dist/index.css',
      '/element-plus-dark.css': 'element-plus/theme-chalk/dark/css-vars.css',
      '/icons.js': '@element-plus/icons-vue/dist/index.iife.min.js',
      '/locale-zh-cn.js': 'element-plus/dist/locale/zh-cn.min.js',
    };
    for (const [u, rel] of Object.entries(vendorFiles)) {
      channel.app.get(`/firmware/vendor${u}`, (req, res) => res.sendFile(path.join(nm, rel)));
    }
    channel.app.use('/firmware', express.static(path.join(__dirname, 'studio', 'public')));
    channel.app.use('/firmware/api', createStudioRouter(studioConfig));
    console.log(`   工作台 : http://localhost:${config.port}/firmware/  (data/bin -> ${studioConfig.dataBinDir})`);
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
