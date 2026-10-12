// One-off probe: why is CJ 11:35-12:35 on 2026-10-12 missing? Prints findings to the log.
import { chromium } from 'playwright';
const d = process.argv[2] || '2026-10-12';
const prev = new Date(Date.parse(d + 'T00:00:00Z') - 86400e3).toISOString().slice(0, 10);
const url = `https://hsmoa.com/?date=${+d.slice(8)}&time=${d}T03%3A00%3A00.000Z&time_size=24&direction=down&base_hour_datetime=${prev}T23%3A59%3A00%2B09%3A00`;
const b = await chromium.launch(); const p = await b.newPage();
await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); let out;
for (let k = 0; k < 25; k++) { await p.waitForTimeout(3000); out = await p.evaluate(() => {
  const res = { text: [], hits: [], noPdid: [], cjAll: [], total: 0, len: document.body.innerText.length };
  const t = document.body.innerText; let i = -1;
  for (const w of ['하스카프', '허니베리']) { i = t.indexOf(w); if (i >= 0) res.text.push(t.slice(Math.max(0, i - 120), i + 80)); }
  const rootEl = document.getElementById('__next');
  const key = Object.keys(rootEl).find(k => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'));
  let root = rootEl[key]; while (root.return) root = root.return;
  const seen = new WeakSet();
  const visit = (v, path, d) => {
    if (!v || typeof v !== 'object' || d > 14 || seen.has(v)) return; seen.add(v);
    if (Array.isArray(v)) { v.forEach((x, j) => visit(x, path + '[' + j + ']', d + 1)); return; }
    if (v.start_datetime && v.tv_channel) {
      res.total++;
      if (v.tv_channel === 'cjmall' && ['10','11','12'].includes(String(v.start_datetime).slice(11,13))) res.cjAll.push([v.start_datetime, v.end_datetime, v.pdid, (v.name || '').slice(0, 40), path.slice(-80)]);
      if (!v.pdid) res.noPdid.push([v.tv_channel, v.start_datetime, (v.name || '').slice(0, 40), Object.keys(v).slice(0, 25).join(',')]);
    }
    for (const k of Object.keys(v)) {
      const x = v[k];
      if (typeof x === 'string' && (x.includes('하스카프') || x.includes('허니베리'))) res.hits.push([path + '.' + k, x.slice(0, 80), v.tv_channel, v.tv_channel_type, v.start_datetime, v.end_datetime, v.pdid, Object.keys(v).join(',')]);
      else if (x && typeof x === 'object' && k !== '_owner' && k !== 'children') visit(x, path + '.' + k, d + 1);
    }
  };
  const stack = [root];
  while (stack.length) { const f = stack.pop(); if (f.memoizedProps && typeof f.memoizedProps === 'object') visit(f.memoizedProps, 'props', 0); if (f.memoizedState && typeof f.memoizedState === 'object') visit(f.memoizedState, 'state', 0); if (f.child) stack.push(f.child); if (f.sibling) stack.push(f.sibling); }
  res.hits = res.hits.slice(0, 20); res.noPdid = res.noPdid.slice(0, 40); res.cjAll.sort();
  return res;
}); if (out.total >= 300) break; }
console.log(JSON.stringify(out, null, 1));
await b.close();
