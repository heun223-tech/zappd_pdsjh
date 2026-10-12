// One-off probe: can the GitHub runner reach each home-shopping site's own TV schedule, and which requests carry it?
import { chromium } from 'playwright';
import fs from 'node:fs';
const HOMES = { cjmall: 'https://www.cjonstyle.com/', gsshop: 'https://www.gsshop.com/', lotteimall: 'https://www.lotteimall.com/', hmall: 'https://www.hmall.com/', hnsmall: 'https://www.hnsmall.com/', immall: 'https://www.gongyoungshop.kr/', nsmall: 'https://www.nsmall.com/' };
const b = await chromium.launch();
const ctx = await b.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' });
const out = {};
for (const [ch, home] of Object.entries(HOMES)) {
  const r = out[ch] = { home, steps: [] };
  const page = await ctx.newPage();
  const reqs = [];
  page.on('response', async res => {
    const ct = res.headers()['content-type'] || ''; const u = res.url();
    if (/json|javascript/.test(ct) && !/\.js(\?|$)/.test(u) || /sched|brod|broad|tvshop|tv\/|편성|timetable|onair/i.test(u)) {
      let body = ''; try { body = (await res.text()).slice(0, 300); } catch {}
      reqs.push({ u: u.slice(0, 220), s: res.status(), ct: ct.slice(0, 40), body });
    }
  });
  try {
    const resp = await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 40000 }); await page.waitForTimeout(6000);
    r.steps.push({ at: page.url(), status: resp && resp.status(), title: await page.title() });
    const links = await page.evaluate(() => [...document.querySelectorAll('a')].filter(a => /편성/.test(a.textContent) || /sched|brod|tvshop|timetable/i.test(a.href)).map(a => [a.textContent.trim().slice(0, 30), a.href]).slice(0, 15));
    r.links = links;
    const target = (links.find(l => /편성/.test(l[0])) || links[0] || [])[1];
    if (target && target.startsWith('http')) {
      reqs.length = 0;
      const r2 = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 40000 }); await page.waitForTimeout(9000);
      r.steps.push({ at: page.url(), status: r2 && r2.status(), title: await page.title(), text: (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 1500) });
      r.reqs = reqs.slice(0, 60);
    }
  } catch (e) { r.error = String(e.message).slice(0, 200); }
  await page.close();
}
fs.mkdirSync('debug', { recursive: true });
fs.writeFileSync('debug/official.json', JSON.stringify(out, null, 1));
await b.close();
