// Idempotent merge: add practice node + practice modeKeywords groups to cloud config.json.
// Usage: node merge-practice-config.js   (run inside xiaozhi-server dir)
const fs = require('fs');
const path = require('path');

const CFG = path.join(process.cwd(), 'config.json');
const raw = fs.readFileSync(CFG, 'utf8');
const cfg = JSON.parse(raw);

// backup once
const bak = CFG + '.bak-practice';
if (!fs.existsSync(bak)) fs.writeFileSync(bak, raw);

// practice defaults (do NOT clobber existing cloud values if present)
if (!cfg.practice) {
  cfg.practice = { enabled: false, endMode: 'manual', silenceTimeoutMs: 120000 };
}
cfg.modeKeywords = cfg.modeKeywords || {};
const add = {
  practiceOn: ['进入口语模式', '练习口语', '口语练习', 'スピーチ練習', 'practice speaking', 'start practice'],
  practiceOff: ['退出口语模式', '结束口语练习', 'スピーチ練習終了', 'end practice'],
  practiceEndManual: ['手动结束', '手動終了', 'manual end'],
  practiceEndAuto: ['自动结束', '自動終了', 'auto end'],
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
console.log('practice=', JSON.stringify(cfg.practice));
console.log('modeKeywords keys=', Object.keys(cfg.modeKeywords).join(','));
