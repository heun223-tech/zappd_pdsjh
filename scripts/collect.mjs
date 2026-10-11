// Collects home-shopping schedules (hsmoa.com) and broadcast EPG (tv.kt.com)
// for today and tomorrow (KST) and writes them to data/.
//   data/<date>.json    TV home shopping 7 channels + broadcast EPG
//   data/t-<date>.json  data home shopping (T-commerce) channels
//   data/index.json     list of available dates
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const DATA = path.resolve('data');
const KEEP_DAYS = 60;
const TV = ['nsmall', 'gsshop', 'cjmall', 'lotteimall', 'hmall', 'hnsmall', 'immall'];
const TC = ['nsmallplus', 'gsmyshop', 'cjmallplus', 'lotteonetv', 'hmallplus', 'kshop', 'kshopplus', 'bshop', 'ssgshop', 'shopnt', 'wshop'];
const MIN_TV = 80, MIN_TC = 60, MIN_EPG = 100;

const kst = (offsetDays = 0) => new Date(Date.now() + 9 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
const prevDay = d => new Date(Date.parse(d + 'T00:00:00Z') - 86400e3).toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// Runs inside hsmoa.com: walks the React tree and returns the decoded schedule.
const HSMOA_EXTRACT = (sites) => {
  const rootEl = document.getElementById('__next');
  const key = Object.keys(rootEl).find(k => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'));
  let root = rootEl[key]; while (root.return) root = root.return;
  const map = new Map(); const seen = new WeakSet();
  const visit = (v, d) => {
    if (!v || typeof v !== 'object' || d > 6 || seen.has(v)) return; seen.add(v);
    if (Array.isArray(v)) { v.forEach(x => visit(x, d + 1)); return; }
    if (v.pdid && v.start_datetime) { map.set(v.pdid + '|' + v.start_datetime, v); return; }
    for (const k of ['schedules', 'before_live', 'live', 'after_live', 'payload', 'response', 'data', 'beforeLive']) if (v[k]) visit(v[k], d + 1);
  };
  const stack = [root];
  while (stack.length) {
    const f = stack.pop(); const p = f.memoizedProps;
    if (p && typeof p === 'object') for (const k in p) { if (k !== 'children') visit(p[k], 0); }
    if (f.child) stack.push(f.child); if (f.sibling) stack.push(f.sibling);
  }
  const hm = s => (s || '').slice(11, 16);
  return [...map.values()].filter(s => sites.includes(s.tv_channel)).map(s => {
    const pi = s.price_info || {};
    const ifm = ((s.interest_free_info && s.interest_free_info.card_infos) || []).reduce((m, c) => Math.max(m, +c.period || 0), 0);
    const cd = (pi.card_discount_infos || []).map(c => c.card_name + ' ' + c.discount_rate + '%').join(', ');
    const brand = s.brand && !s.brand.startsWith('[') ? s.brand : '';
    return {
      ch: s.tv_channel, d: (s.start_datetime || '').slice(0, 10), s: hm(s.start_datetime), e: hm(s.end_datetime),
      n: s.name, b: brand, c1: s.category1 || '', c2: s.category2 || '', c3: s.category3 || '',
      p: s.price || 0, sp: s.sale_price || 0, mx: pi.max_discount_price || 0, dr: pi.total_discount_rate || 0,
      cp: (s.promotion_info && s.promotion_info.promotion_price) || 0,
      cpw: (s.promotion_info && s.promotion_info.promotion_price_word) || '',
      lp: s.launching_price || 0, cd, ifm,
      pg: (s.show_program_info && s.show_program_info.display_name) || '',
      u: s.url || '', lo: s.live_order || 0,
      op: (s.same_time_products || []).slice(0, 10).map(x => ({ n: x.name, p: x.price || 0, sp: x.sale_price || 0, cp: (x.promotion_info && x.promotion_info.promotion_price) || 0, mx: (x.price_info && x.price_info.max_discount_price) || 0 })),
      opn: s.same_time_products_count || (s.same_time_products || []).length
    };
  });
};

// Runs inside tv.kt.com: fetches one channel's daily schedule.
const KT_EXTRACT = async ({ chans, date }) => {
  const get = async (no) => {
    const fd = new URLSearchParams({ ch_type: '1', service_ch_no: String(no), view_type: '1', seldate: date });
    const r = await fetch('/tv/channel/pSchedule.asp', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: fd.toString() });
    const doc = new DOMParser().parseFromString(new TextDecoder('utf-8').decode(await r.arrayBuffer()), 'text/html');
    const items = [];
    doc.querySelectorAll('table.tb_schedule tbody tr').forEach(tr => {
      const tds = tr.querySelectorAll('td'); if (tds.length < 4) return;
      const hh = tds[0].textContent.trim().padStart(2, '0');
      const mins = [...tds[1].querySelectorAll('p')].map(p => p.textContent.trim());
      const progs = [...tds[2].querySelectorAll('p')].map(p => { const c = p.cloneNode(true); c.querySelectorAll('strong,b,img').forEach(x => x.remove()); return c.textContent.replace(/%26amp;/g, '&').replace(/%26/g, '&').replace(/\s+/g, ' ').trim(); });
      const gens = [...tds[3].querySelectorAll('p')].map(p => p.textContent.trim());
      mins.forEach((m, i) => items.push([hh + ':' + m.padStart(2, '0'), progs[i] || '', gens[i] || '']));
    });
    return items;
  };
  return Promise.all(chans.map(async ([no, name, grp]) => ({ no, name, grp, items: await get(no) })));
};
const EPG_CH = [[9, 'KBS1', '지상파'], [7, 'KBS2', '지상파'], [11, 'MBC', '지상파'], [5, 'SBS', '지상파'], [13, 'EBS', '지상파'],
  [15, 'JTBC', '종편'], [16, 'MBN', '종편'], [18, '채널A', '종편'], [20, 'TV조선', '종편'],
  [1, 'ENA', '케이블'], [3, 'tvN', '케이블'], [23, '연합뉴스TV', '뉴스'], [24, 'YTN', '뉴스']];

function capSize(doc, limit) {
  let s = JSON.stringify(doc);
  for (const cap of [6, 4, 2, 0]) {
    if (Buffer.byteLength(s) <= limit) break;
    for (const i of doc.items) i.op = (i.op || []).slice(0, cap);
    s = JSON.stringify(doc);
  }
  return doc;
}

async function hsmoaDay(page, d) {
  const dd = String(+d.slice(8, 10));
  const url = `https://hsmoa.com/?date=${dd}&time=${d}T03%3A00%3A00.000Z&time_size=24&direction=down&base_hour_datetime=${prevDay(d)}T23%3A59%3A00%2B09%3A00`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(4000);
      const items = (await page.evaluate(HSMOA_EXTRACT, [...TV, ...TC])).filter(i => i.d === d);
      log('hsmoa', d, 'attempt', attempt, 'items', items.length);
      if (items.length) return items;
    } catch (e) { log('hsmoa error', d, attempt, e.message); }
    await page.waitForTimeout(5000 * attempt);
  }
  return [];
}

async function epgDays(page, days) {
  const out = {};
  try {
    await page.goto('https://tv.kt.com/tv/channel/pSchedule.asp?ch_type=1&service_ch_no=9&view_type=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (const d of days) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const ch = await page.evaluate(KT_EXTRACT, { chans: EPG_CH, date: d.replaceAll('-', '') });
          const n = ch.reduce((a, c) => a + c.items.length, 0);
          log('epg', d, 'programs', n);
          if (n >= MIN_EPG) { out[d] = ch; break; }
        } catch (e) { log('epg error', d, attempt, e.message); }
      }
    }
  } catch (e) { log('epg page error', e.message); }
  return out;
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  const days = [kst(0), kst(1)];
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' });
  const page = await ctx.newPage();
  const summary = { at: nowIso(), days: {} };

  const hs = {};
  for (const d of days) hs[d] = await hsmoaDay(page, d);
  const epg = await epgDays(page, days);
  await browser.close();

  for (const d of days) {
    const items = hs[d].sort((a, b) => (a.s + a.ch).localeCompare(b.s + b.ch));
    const tv = items.filter(i => TV.includes(i.ch));
    const tc = items.filter(i => TC.includes(i.ch));
    const tvFile = path.join(DATA, `${d}.json`), tcFile = path.join(DATA, `t-${d}.json`);
    const prevTv = readJson(tvFile);
    const res = { tv: tv.length, tc: tc.length, epg: !!epg[d] };

    if (tv.length >= MIN_TV) {
      const doc = capSize({ date: d, collectedAt: nowIso(), source: 'hsmoa.com', items: tv }, 200000);
      if (epg[d]) { doc.epg = epg[d]; doc.epgSource = 'tv.kt.com'; doc.epgAt = nowIso(); }
      else if (prevTv && prevTv.epg) { doc.epg = prevTv.epg; doc.epgSource = prevTv.epgSource; doc.epgAt = prevTv.epgAt; }
      writeJson(tvFile, doc); res.tvSaved = true;
    } else if (prevTv && epg[d]) {
      prevTv.epg = epg[d]; prevTv.epgSource = 'tv.kt.com'; prevTv.epgAt = nowIso(); writeJson(tvFile, prevTv);
    }
    if (tc.length >= MIN_TC) {
      writeJson(tcFile, capSize({ date: d, collectedAt: nowIso(), source: 'hsmoa.com', set: 'tcommerce', items: tc }, 220000));
      res.tcSaved = true;
    }
    summary.days[d] = res;
  }

  // index + retention
  const files = fs.readdirSync(DATA);
  const dates = [...new Set(files.map(f => (f.match(/^(\d{4}-\d{2}-\d{2})\.json$/) || [])[1]).filter(Boolean))].sort().reverse();
  const keep = new Set(dates.slice(0, KEEP_DAYS));
  for (const f of files) {
    const m = f.match(/^(?:t-)?(\d{4}-\d{2}-\d{2})\.json$/);
    if (m && !keep.has(m[1])) fs.unlinkSync(path.join(DATA, f));
  }
  const tdates = fs.readdirSync(DATA).map(f => (f.match(/^t-(\d{4}-\d{2}-\d{2})\.json$/) || [])[1]).filter(Boolean).sort().reverse();
  writeJson(path.join(DATA, 'index.json'), { dates: [...keep].sort().reverse(), tdates, updatedAt: nowIso(), last: summary });
  log('summary', JSON.stringify(summary));
  const ok = Object.values(summary.days).some(r => r.tvSaved);
  if (!ok) { console.error('No TV data saved this run'); process.exitCode = 1; }
}

main().catch(e => { console.error(e); process.exit(1); });
