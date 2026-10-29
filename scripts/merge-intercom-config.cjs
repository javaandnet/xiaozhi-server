// Idempotent merge: add intercom node + intercom modeKeywords groups to config.json.
// Usage: node scripts/merge-intercom-config.cjs   (run inside xiaozhi-server dir)
const fs = require('fs');
const path = require('path');

const CFG = path.join(process.cwd(), 'config.json');
const raw = fs.readFileSync(CFG, 'utf8');
const cfg = JSON.parse(raw);

// backup once
const bak = CFG + '.bak-intercom';
if (!fs.existsSync(bak)) fs.writeFileSync(bak, raw);

// intercom defaults (do NOT clobber existing values if present)
if (!cfg.intercom) {
  cfg.intercom = {
    enabled: true,
    silenceReleaseMs: 1200,
    maxFloorMs: 60000,
    tailGraceMs: 300,
    releaseGraceMs: 800,
    idleExitMs: 180000,
  };
}
cfg.modeKeywords = cfg.modeKeywords || {};
const add = {
  intercomOn: ['进入对讲模式', '对讲模式', '开启对讲', 'インターホン', 'intercom'],
  intercomOff: ['退出对讲模式', '结束对讲', '关闭对讲', '通話終了', 'end intercom'],
  intercomCall: ['呼叫', '对讲', 'call'],
};
for (const [k, v] of Object.entries(add)) {
  if (!Array.isArray(cfg.modeKeywords[k]) || cfg.modeKeywords[k].length === 0) {
    cfg.modeKeywords[k] = v;
  }
}

// atomic write
const tmp = CFG + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
fs.renameSync(tmp, CFG);

console.log('MERGED_OK');
console.log('intercom=', JSON.stringify(cfg.intercom));
console.log('modeKeywords keys=', Object.keys(cfg.modeKeywords).join(','));
