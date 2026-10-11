import fs from 'node:fs';
const tries = [
  ['kt', 'https://tv.kt.com/tv/channel/pSchedule.asp', {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'ch_type=1&service_ch_no=9&view_type=1&seldate=20261012'}],
  ['daum', 'https://search.daum.net/search?w=tot&q=KBS1%20%ED%8E%B8%EC%84%B1%ED%91%9C', {}],
  ['naver', 'https://search.naver.com/search.naver?query=KBS1+%ED%8E%B8%EC%84%B1%ED%91%9C', {}],
  ['lgu', 'https://www.lguplus.com/uhdc/fo/prdv/chnlgid/v1/tv-schedule-list?brdCntrTvChnlId=10&dt=20261012', {}],
  ['skb', 'https://m.skbroadband.com/content/realtime/Realtime_List_Ajax.do?package_name=PM50305785&pack=18&key_depth1=5100&key_depth2=14&key_depth3=20261012', {}],
  ['wavve', 'https://apis.wavve.com/live/epgs?enddatetime=2026-10-12%2023%3A59&genre=all&limit=200&offset=0&startdatetime=2026-10-12%2000%3A00&apikey=E5F3E0D30947AA5440556471321BB6D9&credential=none&device=pc&drm=wm&partner=pooq&pooqzone=none&region=kor&targetage=all', {}],
  ['epgpw', 'https://epg.pw/api/epg.xml?lang=en&channel_id=465093', {}],
];
const out = {};
for (const [k, url, opt] of tries) {
  try {
    const r = await fetch(url, {...opt, headers: {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', 'Accept-Language': 'ko-KR,ko;q=0.9', ...(opt.headers || {})}, signal: AbortSignal.timeout(20000)});
    const t = await r.text();
    out[k] = {status: r.status, len: t.length, url: r.url.slice(0, 200), head: t.replace(/\s+/g, ' ').slice(0, 300), hasKBS: /뉴스|KBS|드라마/.test(t), hasTable: t.includes('tb_schedule')};
  } catch (e) { out[k] = {error: String(e).slice(0, 200)}; }
}
fs.mkdirSync('probe', {recursive: true});
fs.writeFileSync('probe/result.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
