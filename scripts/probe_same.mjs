// One-off probe: what distinguishes the real broadcast line-up inside same_time_products?
import { chromium } from 'playwright';
import fs from 'node:fs';
const d = '2026-10-15', prev = '2026-10-14';
const url = `https://hsmoa.com/?date=15&time=${d}T03%3A00%3A00.000Z&time_size=24&direction=down&base_hour_datetime=${prev}T23%3A59%3A00%2B09%3A00`;
const b = await chromium.launch();
const ctx = await b.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' });
const p = await ctx.newPage();
await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
let out = [];
for (let k = 0; k < 20; k++) {
  await p.waitForTimeout(2000);
  out = await p.evaluate(() => {
    const rootEl = document.getElementById('__next');
    const key = Object.keys(rootEl).find(k => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'));
    let root = rootEl[key]; while (root.return) root = root.return;
    const res = []; const seen = new WeakSet();
    const visit = (v, d) => { if (!v || typeof v !== 'object' || d > 8 || seen.has(v)) return; seen.add(v);
      if (Array.isArray(v)) { v.forEach(x => visit(x, d + 1)); return; }
      if (v.pdid && v.start_datetime && v.same_time_products && ['nsmall', 'gsshop', 'cjmall'].includes(v.tv_channel)) {
        res.push({ ch: v.tv_channel, s: v.start_datetime, n: v.name, rs: v.recent_broadcast_start_datetime, pmt: v.product_meta_type, parent: v.parent_id, entity: v.entity_id,
          same: v.same_time_products.map(x => { const o = {}; for (const k of Object.keys(x)) { const val = x[k]; o[k] = val && typeof val === 'object' ? JSON.stringify(val).slice(0, 120) : val; } return o; }) });
        return; }
      for (const k of ['schedules', 'data', 'payload', 'response', 'live', 'before_live', 'after_live']) if (v[k]) visit(v[k], d + 1); };
    const st = [root]; while (st.length) { const f = st.pop(); const pr = f.memoizedProps; if (pr && typeof pr === 'object') for (const k in pr) if (k !== 'children') visit(pr[k], 0); if (f.child) st.push(f.child); if (f.sibling) st.push(f.sibling); }
    return res;
  });
  if (out.length > 60) break;
}
fs.mkdirSync('debug', { recursive: true });
fs.writeFileSync('debug/same.json', JSON.stringify(out.filter(x => x.same.length > 1).slice(0, 40), null, 1));
await b.close();
