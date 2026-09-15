
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const root = 'C:/Users/A/.dsh/sessions';
const out = [];
function walk(dir, depth) {
  if (depth > 4) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p, depth + 1); continue; }
    if (!e.name.endsWith('.zstd')) continue;
    let text;
    try { text = zlib.zstdDecompressSync(fs.readFileSync(p)).toString('utf8'); } catch (err) { out.push('DECOMPRESS FAIL ' + p + ' :: ' + err.message); continue; }
    const lines = text.split(/\r?\n/).filter(Boolean);
    let retries = 0, upstream524 = 0, hits = [];
    for (const line of lines) {
      if (line.includes('llm/retry')) { retries++; if (hits.length < 6) hits.push('RETRY ' + line.slice(0, 320)); }
      if (line.includes('524') || line.includes('server_error')) { upstream524++; if (hits.length < 12) hits.push('524   ' + line.slice(0, 320)); }
    }
    if (retries || upstream524) {
      const st = fs.statSync(p);
      out.push('=== ' + p.replace(root, '') + ' size=' + st.size + ' mtime=' + st.mtime.toISOString() + ' retries=' + retries + ' upstreamHits=' + upstream524);
      out.push(...hits);
    }
  }
}
walk(root, 0);
console.log(out.join('\n'));
