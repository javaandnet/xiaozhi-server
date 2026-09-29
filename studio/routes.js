/**
 * Firmware Studio — API router for the standalone xiaozhi-server.
 * Mounted by run-server.js at /firmware/api.
 * Contract mirrors studio/public/index.html: raw library results (NOT wrapped),
 * build logs via the global util.SSE at /events, sync/flash as per-request SSE.
 */
import express from 'express';
import { SSE } from './lib/util.js';
import { probeEnv, listBoards, listDevices, detectBoard, checkOfficial } from './lib/env.js';
import { startBuild, getJob, listJobs } from './lib/build.js';
import { listInstalled, installFirmware, removeFirmware, flashUsb, syncSource } from './lib/install.js';

function sseHead(res) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders?.();
}
function sse(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }

function streamAction(res, fn) {
  sseHead(res);
  const onLine = (line) => sse(res, { line });
  Promise.resolve()
    .then(() => fn(onLine))
    .then((r) => sse(res, { done: true, ok: r?.ok, code: r?.code, error: r?.error, message: r?.message, needConfirm: r?.needConfirm }))
    .catch((e) => sse(res, { done: true, ok: false, error: e.message }))
    .finally(() => res.end());
}

export function createStudioRouter(cfg) {
  const router = express.Router();
  router.use(express.json());

  router.get('/env', async (req, res, next) => { try { res.json(await probeEnv(cfg)); } catch (e) { next(e); } });
  router.get('/config', (req, res) => res.json(cfg));
  router.get('/boards', async (req, res, next) => { try { res.json(await listBoards(cfg, { refresh: req.query.refresh === '1' })); } catch (e) { next(e); } });
  router.get('/devices', async (req, res, next) => { try { res.json(await listDevices(cfg, Number(req.query.limit) || 10)); } catch (e) { next(e); } });
  router.get('/detect', async (req, res, next) => { try { res.json(await detectBoard(cfg)); } catch (e) { next(e); } });
  router.get('/releases', async (req, res, next) => { try { res.json(await checkOfficial(cfg, req.query.type)); } catch (e) { next(e); } });
  router.get('/firmware', (req, res) => { try { res.json(listInstalled(cfg)); } catch (e) { res.status(500).json({ error: e.message }); } });

  router.post('/build', (req, res) => {
    const { board, name, type, otaUrl, otaUrlFallback, wakeWord, flashSize } = req.body || {};
    try {
      res.json(startBuild(cfg, { board, name, type, otaUrl, otaUrlFallback, wakeWord, flashSize }));
    } catch (e) { res.status(500).json({ error: '编译启动失败: ' + e.message }); } // {jobId} or {error}
  });
  router.get('/builds', (req, res) => res.json({ items: listJobs() }));
  router.get('/build/:id', (req, res) => {
    const j = getJob(req.params.id);
    if (!j) return res.status(404).json({ error: 'job not found' });
    const { logs, ...rest } = j;
    res.json(rest);
  });

  router.get('/events', (req, res) => {
    sseHead(res);
    SSE.add(res);
    res.write('retry: 3000\n\n');
  });

  router.post('/install', async (req, res) => { try { res.json(await installFirmware(cfg, req.body || {})); } catch (e) { res.status(500).json({ error: e.message }); } });
  router.post('/firmware/delete', (req, res) => { try { res.json(removeFirmware(cfg, req.body || {})); } catch (e) { res.status(500).json({ error: e.message }); } });

  router.post('/sync', (req, res) => streamAction(res, (onLine) => syncSource(cfg, req.body || {}, onLine)));
  router.post('/flash', (req, res) => streamAction(res, (onLine) => flashUsb(cfg, req.body || {}, onLine)));

  return router;
}
