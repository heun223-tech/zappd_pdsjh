// One-off probe #3: fetch candidate schedule APIs directly and dump their shape.
import { chromium } from 'playwright';
import fs from 'node:fs';
const b = await chromium.launch();
const ctx = await b.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' });
const out = {};
const D = '20261012', DD = '2026-10-12', T = '20261013';
async function grab(name, fn) { try { out[name] = await fn(); } catch (e) { out[name] = { error: String(e.message).slice(0, 300) }; } }
const txt = async res => ({ status: res.status(), ct: res.headers()['content-type'], len: (await res.text()).length, body: (await res.text()).slice(0, 7000) });
await grab('cj_full', async () => { const j = await (await ctx.request.get(`https://display.cjonstyle.com/c/rest/tv/tvSchedule?bdDt=${D}&isMobile=false&broadType=live&isEmployee=false`)).json(); return j.result.programList.map(p => [new Date(p.bdStrDtm + 9 * 3600e3).toISOString().slice(11, 16), new Date(p.bdEndDtm + 9 * 3600e3).toISOString().slice(11, 16), p.pgmNm, (p.itemList || []).map(i => i.itemNm + ' ' + i.salePrice).slice(0, 3)]); });
await grab('cj_tomorrow', async () => { const j = await (await ctx.request.get(`https://display.cjonstyle.com/c/rest/tv/tvSchedule?bdDt=${T}&isMobile=false&broadType=live&isEmployee=false`)).json(); return j.result.programList.length; });
await grab('immall', async () => txt(await ctx.request.post('https://www.gongyoungshop.kr/tvshopping/selectScheduleSub.do', { form: { brcStdDate: D } })));
await grab('lotte', async () => txt(await ctx.request.get(`https://www.lotteimall.com/main/scheduleLive.lotte?bdDate=${D}&date=${DD}`)));
await grab('ns', async () => txt(await ctx.request.get(`https://mapi.nsmall.com/md/api/v1/display/media/schedule/tv/${D}?formDate=${D}&cnnlCd=TV`)));
await grab('hns', async () => txt(await ctx.request.get(`https://www.hnsmall.com/gen/areaCacheView/gca/60000059/8005369?date=${T}`)));
// find schedule links on GS and Hmall pages
for (const [k, u] of [['gs', 'https://www.gsshop.com/shop/tv/tvScheduleMain.gs'], ['gs_home', 'https://www.gsshop.com/index.gs'], ['hmall_home', 'https://www.hmall.com/md/dpl/index']]) {
  await grab(k, async () => {
    const page = await ctx.newPage(); const reqs = [];
    page.on('response', async res => { const ct = res.headers()['content-type'] || ''; if (/json/.test(ct) && /sch|brod|tv|live/i.test(res.url())) { let t = ''; try { t = await res.text(); } catch {} reqs.push([res.url().slice(0, 250), res.status(), t.length, t.slice(0, 600)]); } });
    const r = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 40000 }); await page.waitForTimeout(8000);
    const links = await page.evaluate(() => [...document.querySelectorAll('a,[data-rel]')].filter(a => /편성/.test(a.textContent + (a.dataset.rel || ''))).map(a => [a.textContent.trim().slice(0, 20), a.getAttribute('href'), a.outerHTML.slice(0, 200)]).slice(0, 8));
    const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
    const i = text.search(/\d\d:\d\d\s*[~-]\s*\d\d:\d\d/);
    const res = { status: r && r.status(), at: page.url(), title: await page.title(), links, sample: text.slice(Math.max(0, i - 80), i + 700), reqs: reqs.slice(0, 20) };
    await page.close(); return res;
  });
}
fs.mkdirSync('debug', { recursive: true });
fs.writeFileSync('debug/official.json', JSON.stringify(out, null, 1));
await b.close();
