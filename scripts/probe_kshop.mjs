// One-off probe: KT alpha shopping's own TV schedule.
import { chromium } from 'playwright';
import fs from 'node:fs';
const b = await chromium.launch();
const ctx = await b.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' });
const out = { steps: [], reqs: [] };
const page = await ctx.newPage();
page.on('response', async res => { const ct = res.headers()['content-type'] || ''; const u = res.url();
  if (/json/.test(ct) && !/google|facebook|criteo|kakao|naver|amplitude|airbridge|appier/.test(u)) { let t = ''; try { t = await res.text(); } catch {} out.reqs.push([u.slice(0, 250), res.request().method(), (res.request().postData() || '').slice(0, 300), res.status(), t.length, /sch|brod|broad|tv|onair/i.test(u) ? t.slice(0, 6000) : t.slice(0, 300)]); } });
try {
  const r = await page.goto('https://www.kshop.co.kr/', { waitUntil: 'domcontentloaded', timeout: 40000 }); await page.waitForTimeout(6000);
  out.steps.push([page.url(), r && r.status(), await page.title()]);
  out.links = await page.evaluate(() => [...document.querySelectorAll('a')].filter(a => /편성/.test(a.textContent)).map(a => [a.textContent.trim().slice(0, 20), a.href]).slice(0, 10));
  const target = 'https://www.kshop.co.kr/?gnbMenuId=G000000002';
  if (target) { out.reqs.length = 0; const r2 = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 40000 }); await page.waitForTimeout(9000);
    out.steps.push([page.url(), r2 && r2.status(), await page.title()]);
    const t = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
    out.text = t.slice(0, 600); const i = t.search(/14:3\d/); out.around = t.slice(Math.max(0, i - 300), i + 1200); const j = t.search(/21:3\d/); out.around2 = t.slice(Math.max(0, j - 300), j + 1200); }
} catch (e) { out.error = String(e.message).slice(0, 300); }
fs.mkdirSync('debug', { recursive: true }); fs.writeFileSync('debug/kshop.json', JSON.stringify(out, null, 1)); await b.close();
