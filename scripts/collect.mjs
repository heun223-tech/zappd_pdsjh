// Collects home-shopping schedules (hsmoa.com) and broadcast EPG (Daum TV schedule)
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

const HS_LOG = [];
async function hsmoaDay(page, d) {
  const dd = String(+d.slice(8, 10));
  const base = `date=${dd}&time_size=24&direction=down&base_hour_datetime=${prevDay(d)}T23%3A59%3A00%2B09%3A00`;
  const urls = [
    `https://hsmoa.com/?${base.replace('&time_size', `&time=${d}T03%3A00%3A00.000Z&time_size`)}`,
    `https://hsmoa.com/?${base}`,
    `https://hsmoa.com/?${base.replace('&time_size', `&time=${encodeURIComponent(new Date().toISOString())}&time_size`)}`,
  ];
  for (let attempt = 0; attempt < urls.length * 2; attempt++) {
    const url = urls[attempt % urls.length];
    try {
      await page.goto('about:blank');
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(4000 + 2000 * Math.floor(attempt / urls.length));
      const items = (await page.evaluate(HSMOA_EXTRACT, [...TV, ...TC])).filter(i => i.d === d);
      HS_LOG.push(`${d} try${attempt + 1} ${items.length}`);
      if (items.filter(i => TV.includes(i.ch)).length >= MIN_TV) return items;
    } catch (e) { HS_LOG.push(`${d} try${attempt + 1} error ${String(e.message).slice(0, 120)}`); }
    await page.waitForTimeout(3000);
  }
  return [];
}

const EPG_LOG = [];
// Broadcast EPG from Daum search's weekly channel schedule (reachable from overseas runners).
const DAUM_Q = {KBS1: 'KBS1', KBS2: 'KBS2', MBC: 'MBC', SBS: 'SBS', EBS: 'EBS1', JTBC: 'JTBC', MBN: 'MBN', '채널A': '채널A', 'TV조선': 'TV조선', ENA: 'ENA', tvN: 'tvN', '연합뉴스TV': '연합뉴스TV', YTN: 'YTN'};
const decodeHtml = t => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
function guessGenre(title, ch) {
  if (/뉴스|NEWS|브리핑|뉴스특보/i.test(title) || ch === 'YTN' || ch === '연합뉴스TV') return /다큐|스페셜/.test(title) ? '시사/다큐' : '뉴스';
  if (/드라마|미니시리즈|일일|주말극|연속극|시즌\s?\d+\s?\d+회/.test(title)) return '드라마';
  if (/다큐|시사|탐사|추적|스페셜|PD수첩|그것이 알고|인간극장/.test(title)) return '시사/다큐';
  if (/중계|야구|축구|배구|농구|골프|스포츠|씨름|당구/.test(title)) return '스포츠';
  if (/가요|뮤직|음악|노래|트롯|콘서트|열린음악회/.test(title)) return '음악';
  if (/영화|시네마|무비/.test(title)) return '영화';
  if (/방송\s*시간이\s*아닙니다|정파/.test(title)) return '';
  return '';
}
async function daumChannel(name, year) {
  const url = 'https://search.daum.net/search?w=tot&q=' + encodeURIComponent(DAUM_Q[name] + ' 편성표');
  const r = await fetch(url, {headers: {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', 'Accept-Language': 'ko-KR,ko;q=0.9'}, signal: AbortSignal.timeout(30000)});
  const t = await r.text();
  const days = {};
  for (const m of t.matchAll(/id="channelTitle(\d+)"[^>]*>\s*<span class="date">(\d{1,2})\.(\d{1,2})<\/span>/g)) {
    let y = year; const mo = +m[2];
    const nowMo = +kst(0).slice(5, 7);
    if (nowMo === 12 && mo === 1) y = year + 1; else if (nowMo === 1 && mo === 12) y = year - 1;
    days[m[1]] = `${y}-${String(mo).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
  }
  const out = {};
  for (const m of t.matchAll(/<td id="channelBody(\d+)_(\d+)"[^>]*>([\s\S]*?)<\/td>/g)) {
    const hh = String(+m[1]).padStart(2, '0'); const d = days[m[2]]; if (!d) continue;
    for (const e of m[3].matchAll(/<dt class="tit">\s*(\d+)\s*<\/dt>\s*<dd class="cont">([\s\S]*?)<\/dd>/g)) {
      const title = decodeHtml(e[2].replace(/<span class="img_tv[^"]*">[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      if (!title) continue;
      (out[d] = out[d] || []).push([hh + ':' + String(+e[1]).padStart(2, '0'), title, guessGenre(title, name)]);
    }
  }
  for (const d in out) out[d].sort((a, b) => a[0].localeCompare(b[0]));
  return out;
}
async function epgDays(days) {
  const year = +kst(0).slice(0, 4);
  const per = {};
  await Promise.all(EPG_CH.map(async ([no, name, grp]) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { per[name] = await daumChannel(name, year); break; }
      catch (e) { EPG_LOG.push(name + ' ' + attempt + ' ' + String(e).slice(0, 120)); }
    }
  }));
  const out = {};
  for (const d of days) {
    const ch = EPG_CH.map(([no, name, grp]) => ({no, name, grp, items: (per[name] && per[name][d]) || []}));
    const n = ch.reduce((a, c) => a + c.items.length, 0);
    EPG_LOG.push(d + ' programs ' + n + ' | ' + ch.map(c => c.name + ':' + c.items.length).join(' '));
    if (n >= MIN_EPG) out[d] = ch;
  }
  return out;
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  const days = [kst(0), kst(1)];
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' });
  const page = await ctx.newPage();
  const summary = { at: nowIso(), days: {}, hsLog: HS_LOG, epgLog: EPG_LOG };

  const hs = {};
  for (const d of days) hs[d] = await hsmoaDay(page, d);
  await browser.close();
  const epg = await epgDays(days);

  for (const d of days) {
    const items = hs[d].sort((a, b) => (a.s + a.ch).localeCompare(b.s + b.ch));
    const tv = items.filter(i => TV.includes(i.ch));
    const tc = items.filter(i => TC.includes(i.ch));
    const tvFile = path.join(DATA, `${d}.json`), tcFile = path.join(DATA, `t-${d}.json`);
    const prevTv = readJson(tvFile);
    const res = { tv: tv.length, tc: tc.length, epg: !!epg[d] };

    if (tv.length >= MIN_TV) {
      const doc = capSize({ date: d, collectedAt: nowIso(), source: 'hsmoa.com', items: tv }, 200000);
      if (epg[d]) { doc.epg = epg[d]; doc.epgSource = 'search.daum.net'; doc.epgAt = nowIso(); }
      else if (prevTv && prevTv.epg) { doc.epg = prevTv.epg; doc.epgSource = prevTv.epgSource; doc.epgAt = prevTv.epgAt; }
      writeJson(tvFile, doc); res.tvSaved = true;
    } else if (prevTv && epg[d]) {
      prevTv.epg = epg[d]; prevTv.epgSource = 'search.daum.net'; prevTv.epgAt = nowIso(); writeJson(tvFile, prevTv);
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
