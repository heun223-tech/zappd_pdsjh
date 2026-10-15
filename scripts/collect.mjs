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
// today and tomorrow are complete on hsmoa; later days fill in gradually, so they are kept with a lower bar
const AHEAD = 7, MIN_FUTURE = 20;
const near = d => d <= kst(1);
const minTvFor = d => near(d) ? MIN_TV : MIN_FUTURE;

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
      // rb = the slot hsmoa says this product is (next) broadcast in; products for other slots are listed too, so this broadcast's own ones go first
      op: (s.same_time_products || []).map(x => ({ n: x.name, p: x.price || 0, sp: x.sale_price || 0, cp: (x.promotion_info && x.promotion_info.promotion_price) || 0, mx: (x.price_info && x.price_info.max_discount_price) || 0, rb: (x.recent_broadcast_start_datetime || '').slice(0, 16) }))
        .sort((a, b) => (b.rb === (s.start_datetime || '').slice(0, 16)) - (a.rb === (s.start_datetime || '').slice(0, 16))).slice(0, 10),
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
  const minTv = minTvFor(d), tries = near(d) ? 6 : 2;
  const dd = String(+d.slice(8, 10));
  const base = `date=${dd}&time_size=24&direction=down&base_hour_datetime=${prevDay(d)}T23%3A59%3A00%2B09%3A00`;
  const urls = [
    `https://hsmoa.com/?${base.replace('&time_size', `&time=${d}T03%3A00%3A00.000Z&time_size`)}`,
    `https://hsmoa.com/?${base}`,
    `https://hsmoa.com/?${base.replace('&time_size', `&time=${encodeURIComponent(new Date().toISOString())}&time_size`)}`,
  ];
  for (let attempt = 0; attempt < tries; attempt++) {
    const url = urls[attempt % urls.length];
    try {
      await page.goto('about:blank');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      // poll the page until the decoded schedule is present and stable (max ~40s)
      let items = [], last = -1;
      for (let k = 0; k < 20; k++) {
        await page.waitForTimeout(2000);
        items = (await page.evaluate(HSMOA_EXTRACT, [...TV, ...TC]).catch(() => [])).filter(i => i.d === d);
        const tvN = items.filter(i => TV.includes(i.ch)).length;
        if (tvN >= minTv && items.length === last) break;
        if (k >= 8 && items.length === last && tvN < minTv) break; // nothing more is coming for this day
        last = items.length;
      }
      HS_LOG.push(`${d} try${attempt + 1} ${items.length}`);
      if (items.filter(i => TV.includes(i.ch)).length >= minTv) return items;
    } catch (e) { HS_LOG.push(`${d} try${attempt + 1} error ${String(e.message).slice(0, 120)}`); }
    await page.waitForTimeout(3000);
  }
  return [];
}

const EPG_LOG = [];

// ---------- official channel schedules: fill what hsmoa is missing ----------
// GS SHOP and Hmall block requests from overseas servers, so only these channels are checked.
const OFFICIAL_LOG = [];
const ymd = d => d.replace(/-/g, '');
const kstOf = ms => new Date(ms + 9 * 3600e3).toISOString();
const xmlTag = (blk, t) => { const m = blk.match(new RegExp('<' + t + '>([\\s\\S]*?)</' + t + '>')); return m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : ''; };
const num = v => +String(v || '').replace(/[^\d]/g, '') || 0;
const firstPerSlot = list => { const seen = new Set(); return list.filter(x => x.s && x.n && !seen.has(x.d + x.s) && seen.add(x.d + x.s)); };
const OFFICIAL = {
  cjmall: async (req, d) => {
    const j = await (await req.get(`https://display.cjonstyle.com/c/rest/tv/tvSchedule?bdDt=${ymd(d)}&isMobile=false&broadType=live&isEmployee=false`, { timeout: 30000 })).json();
    return ((j.result && j.result.programList) || []).map(p => { const it = (p.itemList || [])[0] || {}; const a = kstOf(p.bdStrDtm), z = kstOf(p.bdEndDtm);
      return { d: a.slice(0, 10), s: a.slice(11, 16), e: z.slice(11, 16), n: it.itemNm || '', p: it.salePrice || 0, sp: it.hpSalePrice || 0, pg: p.pgmNm || '' }; });
  },
  immall: async (req, d) => {
    const x = await (await req.post('https://www.gongyoungshop.kr/tvshopping/selectScheduleSub.do', { form: { brcStdDate: ymd(d) }, timeout: 30000 })).text();
    return firstPerSlot([...x.matchAll(/<prdList>([\s\S]*?)<\/prdList>/g)].map(m => { const b = m[1], a = xmlTag(b, 'brcBgnDtm'), z = xmlTag(b, 'brcEndDtm');
      return { d: `${a.slice(0, 4)}-${a.slice(4, 6)}-${a.slice(6, 8)}`, s: `${a.slice(8, 10)}:${a.slice(10, 12)}`, e: `${z.slice(8, 10)}:${z.slice(10, 12)}`, n: xmlTag(b, 'prdNm'), p: num(xmlTag(b, 'prdPrc')), sp: 0, pg: xmlTag(b, 'brcPgmNm') }; }));
  },
  lotteimall: async (req, d) => {
    const j = await (await req.get(`https://www.lotteimall.com/main/scheduleLive.lotte?bdDate=${ymd(d)}&date=${d}`, { timeout: 30000 })).json();
    return firstPerSlot(((j.body && j.body.prod) || []).map(p => ({ d, s: p.stime || '', e: p.etime || '', n: p.name || '', p: num(p.price_orig) || num(p.price_disc), sp: num(p.price_disc), pg: '' })));
  },
  nsmall: async (req, d) => {
    const j = await (await req.get(`https://mapi.nsmall.com/md/api/v1/display/media/schedule/tv/${ymd(d)}?formDate=${ymd(d)}&cnnlCd=TV`, { timeout: 30000 })).json();
    const l = (j.data && j.data.resultData && j.data.resultData.totalOrgan) || [];
    return firstPerSlot(l.map(o => { const g = o.goods || {}, a = String(o.startDtm || ''), z = String(o.endDtm || '');
      return { d: `${a.slice(0, 4)}-${a.slice(4, 6)}-${a.slice(6, 8)}`, s: `${a.slice(8, 10)}:${a.slice(10, 12)}`, e: `${z.slice(8, 10)}:${z.slice(10, 12)}`, n: (g.productNm || '').trim(), p: g.salePrice || 0, sp: g.dcPrice || 0, pg: o.pgmNm || '' }; }));
  },
};
const hmMin = hm => +hm.slice(0, 2) * 60 + +hm.slice(3, 5);
const span = x => { const a = hmMin(x.s); let z = hmMin(x.e); if (z <= a) z += 1440; return [a, z]; };
async function fillFromOfficial(req, d, items) {
  const added = [];
  for (const [ch, fetchOfficial] of Object.entries(OFFICIAL)) {
    let list = null;
    for (let attempt = 1; attempt <= 3 && !list; attempt++) {
      try { list = (await fetchOfficial(req, d)).filter(x => x.d === d && /^\d\d:\d\d$/.test(x.s) && /^\d\d:\d\d$/.test(x.e)); }
      catch (e) { OFFICIAL_LOG.push(`${d} ${ch} try${attempt} ${String(e.message).split('\n')[0].slice(0, 80)}`); await new Promise(r => setTimeout(r, 5000 * attempt)); }
    }
    const mine = items.filter(i => i.ch === ch).map(span);
    if (!list) {
      // site unreachable this run: keep what an earlier run already took from it
      const prev = ((readJson(path.join(DATA, `${d}.json`)) || {}).items || []).filter(i => i.ch === ch && i.src === 'o');
      const kept = prev.filter(o => { const [a, z] = span(o); return !mine.some(([b, y]) => Math.min(z, y) - Math.max(a, b) >= 5); });
      added.push(...kept); OFFICIAL_LOG.push(`${d} ${ch} unreachable, kept ${kept.length} from earlier run`); continue;
    }
    let n = 0;
    for (const o of list) {
      const [a, z] = span(o);
      // keep only official broadcasts that hsmoa has nothing for (less than 5 minutes of overlap)
      if (mine.some(([b, y]) => Math.min(z, y) - Math.max(a, b) >= 5)) continue;
      added.push({ ch, d, s: o.s, e: o.e, n: o.n || o.pg || '방송', b: '', c1: '', c2: '', c3: '', p: o.p || 0, sp: o.sp && o.sp !== o.p ? o.sp : 0, mx: 0, dr: 0, cp: 0, cpw: '', lp: 0, cd: '', ifm: 0, pg: o.pg || '', u: '', lo: 0, op: [], opn: 0, src: 'o' });
      n++;
    }
    OFFICIAL_LOG.push(`${d} ${ch} official ${list.length} added ${n}`);
  }
  return added;
}
// Broadcast EPG from Daum search's weekly channel schedule (reachable from overseas runners).
const DAUM_Q = {KBS1: 'KBS1', KBS2: 'KBS2', MBC: 'MBC', SBS: 'SBS', EBS: 'EBS1', JTBC: 'JTBC', MBN: 'MBN', '채널A': '채널A', 'TV조선': 'TV조선', ENA: 'ENA', tvN: 'tvN', '연합뉴스TV': '연합뉴스TV', YTN: 'YTN'};
const decodeHtml = t => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
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
      (out[d] = out[d] || []).push([hh + ':' + String(+e[1]).padStart(2, '0'), title, '']);
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
  const days = Array.from({ length: AHEAD + 1 }, (_, i) => kst(i));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' });
  const page = await ctx.newPage();
  const summary = { at: nowIso(), days: {}, hsLog: HS_LOG, epgLog: EPG_LOG, officialLog: OFFICIAL_LOG };

  const hs = {};
  for (const d of days) hs[d] = await hsmoaDay(page, d);
  for (const d of days) if (hs[d].filter(i => TV.includes(i.ch)).length >= minTvFor(d)) hs[d] = hs[d].concat(await fillFromOfficial(ctx.request, d, hs[d]));
  await browser.close();
  const epg = await epgDays(days);

  // once a broadcast has started hsmoa points its products at their next airing, so keep the line-up captured before it aired
  const nowKst = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16);
  const keepAiredLineup = (list, prev) => {
    if (!prev) return;
    const old = new Map((prev.items || []).map(i => [i.ch + '|' + i.s + '|' + i.n, i]));
    for (const i of list) {
      if (`${i.d}T${i.s}` > nowKst) continue;
      const o = old.get(i.ch + '|' + i.s + '|' + i.n);
      if (o && (o.op || []).some(x => x.rb)) { i.op = o.op; i.opn = o.opn; }
    }
  };
  for (const d of days) {
    const items = hs[d].sort((a, b) => (a.s + a.ch).localeCompare(b.s + b.ch));
    const tv = items.filter(i => TV.includes(i.ch));
    const tc = items.filter(i => TC.includes(i.ch));
    const tvFile = path.join(DATA, `${d}.json`), tcFile = path.join(DATA, `t-${d}.json`);
    const prevTv = readJson(tvFile);
    const res = { tv: tv.length, tc: tc.length, epg: !!epg[d] };

    const prevTc = readJson(tcFile);
    keepAiredLineup(tv, prevTv); keepAiredLineup(tc, prevTc);
    // a later day may only be partly published: never replace a fuller earlier copy with a much thinner one
    const enough = (n, min, prev) => near(d) ? n >= min : n >= MIN_FUTURE && (!prev || n >= 0.7 * (prev.items || []).length);
    if (enough(tv.length, MIN_TV, prevTv)) {
      const doc = capSize({ date: d, collectedAt: nowIso(), source: 'hsmoa.com + official (cjmall, immall, lotteimall, nsmall) for missing slots', items: tv }, 200000);
      if (epg[d]) { doc.epg = epg[d]; doc.epgSource = 'search.daum.net'; doc.epgAt = nowIso(); }
      else if (prevTv && prevTv.epg) { doc.epg = prevTv.epg; doc.epgSource = prevTv.epgSource; doc.epgAt = prevTv.epgAt; }
      writeJson(tvFile, doc); res.tvSaved = true;
    } else if (prevTv && epg[d]) {
      prevTv.epg = epg[d]; prevTv.epgSource = 'search.daum.net'; prevTv.epgAt = nowIso(); writeJson(tvFile, prevTv);
    }
    if (enough(tc.length, MIN_TC, prevTc)) {
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
