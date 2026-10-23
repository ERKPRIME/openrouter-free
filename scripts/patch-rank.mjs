import { readFileSync, writeFileSync } from 'fs';
const p = 'C:/Users/Sistemas01/Opencode-free-Router/opencode-free-router/src/rank.mts';
let s = readFileSync(p, 'utf8');
const old = '  const r = spawnSync("opencode", ["api", "--standalone", "model.list"], {';
const neu = '  const cmd = process.platform === "win32" ? "cmd" : "opencode";\n  const args = process.platform === "win32" ? ["/c", "opencode.cmd", "api", "--standalone", "model.list"] : ["api", "--standalone", "model.list"];\n  const r = spawnSync(cmd, args, {';
if (s.includes(old)) {
  s = s.replace(old, neu);
  writeFileSync(p, s);
  console.log('patched');
} else {
  console.log('already or not found');
}
