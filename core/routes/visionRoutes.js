/**
 * Vision explain route: device camera -> server -> vision model.
 *
 * Protocol contract (firmware main/boards/common/esp32_camera.cc Explain()):
 *   POST multipart/form-data
 *     field  "question"      : plain text
 *     field  "file"          : camera.jpg, image/jpeg (chunked)
 *     header "Authorization" : Bearer <token> (only when token was delivered)
 *     header "Device-Id" / "Client-Id"
 *   Response: 200 body is read whole by the firmware and returned verbatim
 *     as the self.camera.take_photo tool result, so plain text or JSON both
 *     work for the downstream LLM.
 *
 * The URL itself is handed to the device through the MCP initialize
 * capabilities.vision payload (see core/services/mcp.js); without it the
 * firmware refuses capture with "Image explain URL or token is not set".
 *
 * Model backend (config.vision, all optional):
 *   endpoint    : OpenAI-compatible /chat/completions base URL
 *                 (e.g. http://127.0.0.1:3300/v1 -> appends /chat/completions)
 *   model       : vision-capable model id (gemma4:31b is NOT one)
 *   apiKey      : bearer key for the endpoint
 *   system      : optional system prompt override
 * While unconfigured the route still completes the capture/upload leg and
 * answers with a placeholder, so the whole chain is testable end to end and
 * wiring a real model is a pure config change.
 */
import fs from 'fs';
import path from 'path';
import { getConfig } from '../../config/loader.js';

/** Minimal multipart/form-data parser for the two fixed camera fields. */
function parseMultipart(buf, boundary) {
  const delim = Buffer.from('--' + boundary);
  const fields = {};
  let file = null;
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    const start = pos + delim.length;
    const next = buf.indexOf(delim, start);
    if (next === -1) break;
    // Part body: skip CRLF (or "--" terminator), headers up to blank line.
    let part = buf.slice(start, next);
    if (part.slice(0, 2).toString() === '--') break; // closing boundary
    if (part[0] === 0x0d && part[1] === 0x0a) part = part.slice(2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) { pos = next; continue; }
    const headers = part.slice(0, headerEnd).toString('latin1');
    let body = part.slice(headerEnd + 4);
    if (body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) body = body.slice(0, -2);
    const nameMatch = headers.match(/name="([^"]*)"/i);
    const name = nameMatch ? nameMatch[1] : '';
    if (/Content-Disposition:.*filename=/i.test(headers)) {
      const typeMatch = headers.match(/Content-Type:\s*([^\r\n;]+)/i);
      file = { name, filename: (headers.match(/filename="([^"]*)"/i) || [, ''])[1], contentType: typeMatch ? typeMatch[1].trim() : 'image/jpeg', buf: body };
    } else {
      fields[name] = body.toString('utf8');
    }
    pos = next;
  }
  return { fields, file };
}

export function registerVisionRoutes(app, ctx) {
  // The device-facing URL carries the /xiaozhi prefix (matching the delivered
  // vision.url), while index.js's prefix-stripping middleware rewrites it to
  // the bare path before routing -- so register both shapes.
  app.post(['/xiaozhi/vision/explain', '/vision/explain'], async (req, res) => {
    const config = getConfig() || {};
    const token = config.sharedToken || '';
    if (token) {
      const auth = String(req.headers.authorization || '');
      if (auth !== `Bearer ${token}`) {
        return res.status(401).json({ answer: 'unauthorized' });
      }
    }

    const ctype = String(req.headers['content-type'] || '');
    const boundaryMatch = ctype.match(/boundary=(?:"([^"]+)"|([^;]+))/);
    if (!ctype.startsWith('multipart/form-data') || !boundaryMatch) {
      return res.status(400).json({ answer: 'expected multipart/form-data with question + file fields' });
    }
    const boundary = boundaryMatch[1] || boundaryMatch[2];

    // Collect the chunked upload (camera JPEGs are tens of KB; cap at 8MB).
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of req) {
        total += chunk.length;
        if (total > 8 * 1024 * 1024) {
          return res.status(413).json({ answer: 'image too large' });
        }
        chunks.push(chunk);
      }
    } catch (e) {
      console.error('[Vision] upload read failed:', e.message);
      return res.status(400).json({ answer: 'upload read failed' });
    }

    const { fields, file } = parseMultipart(Buffer.concat(chunks), boundary);
    const question = String(fields.question || '').trim();
    const deviceId = String(req.headers['device-id'] || req.headers.clientID || '').trim();
    if (!file || file.buf.length === 0) {
      return res.status(400).json({ answer: 'no image received' });
    }
    console.log(`[Vision] photo received: device=${deviceId || '?'} question="${question}" bytes=${file.buf.length} type=${file.contentType}`);

    // Persist the latest capture for visual inspection (pixel order / mirroring
    // faults on ESP32 cams are only judgeable by eye). Overwritten in place, so
    // it costs at most one frame.
    try {
      const dumpDir = path.join(process.cwd(), 'data', 'vision');
      fs.mkdirSync(dumpDir, { recursive: true });
      fs.writeFileSync(path.join(dumpDir, 'latest.jpg'), file.buf);
    } catch (e) {
      console.warn('[Vision] latest capture dump failed:', e.message);
    }

    const vision = config.vision || {};
    if (!vision.endpoint || !vision.model) {
      // Plumbing-only mode: capture + upload leg verified, model leg pending.
      return res.json({ answer: '【拍照链路正常】照片已拍摄并成功上传到服务器（' + question + '）。当前服务端未配置视觉模型（config.vision.endpoint/model），无法看图回答。' });
    }

    // OpenAI-compatible vision call (base URL may or may not carry /v1).
    const base = String(vision.endpoint).replace(/\/+$/, '');
    const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (vision.apiKey) headers.Authorization = `Bearer ${vision.apiKey}`;
    const payload = {
      model: vision.model,
      max_tokens: vision.maxTokens || 300,
      messages: [
        { role: 'system', content: vision.system || '你是一个专业的图像理解助手。请只根据图片中实际可见的内容回答，不要编造图片中不存在的信息。' },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:${file.contentType};base64,${file.buf.toString('base64')}` } },
          { type: 'text', text: question || '请描述这张图片的内容。' }
        ] }
      ]
    };
    try {
      const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(vision.timeoutMs || 60000) });
      const j = await r.json();
      const answer = j?.choices?.[0]?.message?.content ?? j?.message?.content ?? '';
      if (!r.ok || !answer) {
        console.error(`[Vision] model call failed: status=${r.status} ${JSON.stringify(j).slice(0, 200)}`);
        return res.status(502).json({ answer: '视觉模型调用失败：' + JSON.stringify(j?.error || j).slice(0, 160) });
      }
      console.log(`[Vision] model answered: ${answer.slice(0, 80)}...`);
      res.json({ answer: String(answer).trim() });
    } catch (e) {
      console.error('[Vision] model call error:', e.message);
      res.status(502).json({ answer: '视觉模型连接失败：' + e.message });
    }
  });
}
