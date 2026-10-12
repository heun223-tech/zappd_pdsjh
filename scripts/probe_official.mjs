// One-off probe #2: schedule data shapes per site.
import { chromium } from 'playwright';
import fs from 'node:fs';
const b = await chromium.launch();
const ctx = await b.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' });
const out = {};
const skip = /google|facebook|criteo|kakao|naver|amplitude|moloco|twitter|t\.co|daum|adnxs|widerplanet|cloudflare|hackle|mediacategory|log\./;
async function watch(name, url, click) {
  const r = out[name] = { reqs: [] }; const page = await ctx.newPage();
  page.on('response', async res => {
    const u = res.url(); if (skip.test(u)) return; const ct = res.headers()['content-type'] || '';
    if (!/json|html/.test(ct) || res.request().resourceType() === 'document' && !click) return;
    let body = ''; try { body = await res.text(); } catch {}
    r.reqs.push({ u: u.slice(0, 300), m: res.request().method(), post: (res.request().postData() || '').slice(0, 300), s: res.status(), ct: ct.slice(0, 30), len: body.length, body: body.slice(0, 1500) });
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }); await page.waitForTimeout(5000);
    if (click) { const el = page.getByText('편성표', { exact: false }).first(); await el.click({ timeout: 8000 }).catch(e => r.clickErr = String(e.message).slice(0, 150)); await page.waitForTimeout(8000); }
    r.at = page.url(); r.title = await page.title();
    r.html = (await page.content()).length;
    r.sample = await page.evaluate(() => { const t = document.body.innerText; const i = t.search(/\d\d:\d\d\s*~\s*\d\d:\d\d/); return t.slice(Math.max(0, i - 100), i + 900).replace(/\s+/g, ' '); });
    r.dom = await page.evaluate(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { if (/\d\d:\d\d\s*~\s*\d\d:\d\d/.test(n.textContent)) { let e = n.parentElement; for (let k = 0; k < 4 && e.parentElement; k++) e = e.parentElement; return e.outerHTML.slice(0, 2500); } } return ''; });
  } catch (e) { r.error = String(e.message).slice(0, 200); }
  await page.close();
}
// CJ JSON API
try { const res = await ctx.request.get('https://display.cjonstyle.com/c/rest/tv/tvSchedule?bdDt=20261012&isMobile=false&broadType=live&isEmployee=false'); const j = await res.json(); const l = j.result.programList || []; out.cj = { status: res.status(), n: l.length, keys: Object.keys(j.result), first: JSON.stringify(l[0]).slice(0, 3000), around: l.filter(p => /11:3|12:/.test(new Date(p.bdStrDtm + 9 * 3600e3).toISOString())).map(p => JSON.stringify(p).slice(0, 1500)) }; } catch (e) { out.cj = { error: String(e.message) }; }
await watch('immall', 'https://www.gongyoungshop.kr/tvshopping/tvSchedule.do', false);
await watch('hnsmall', 'https://www.hnsmall.com/display/tvschedule', false);
await watch('gsshop', 'https://www.gsshop.com/', true);
await watch('lotteimall', 'https://www.lotteimall.com/', true);
await watch('hmall', 'https://www.hmall.com/', true);
await watch('nsmall', 'https://m.nsmall.com/store/fixed/schedule', false);
fs.mkdirSync('debug', { recursive: true });
fs.writeFileSync('debug/official.json', JSON.stringify(out, null, 1));
await b.close();
