"""Prepare the Claude board's database payload from data/ and detect notable changes.

usage: python3 -I scripts/db_payload.py --data data --prev <dir with previous days/ and tdays/ docs> --out <dir>

Writes to --out:
  days-<date>.json, tdays-<date>.json   documents trimmed to fit the database's per-document size limit
  meta.json                             {"dates", "tdates", "updatedAt"}
  report.json                           {"stale": bool, "ageHours", "last", "changes": [...]} for alerts
"""
import argparse, datetime, json, os

LIMIT = 150_000  # raw UTF-8 bytes; stored size is larger because Korean text is escaped
OWN = {'days': 'nsmall', 'tdays': 'nsmallplus'}
NAMES = {'nsmall': 'NS홈쇼핑', 'gsshop': 'GS샵', 'cjmall': 'CJ온스타일', 'lotteimall': '롯데홈쇼핑', 'hmall': '현대홈쇼핑', 'hnsmall': '홈앤쇼핑', 'immall': '공영쇼핑',
         'nsmallplus': 'NS Shop+', 'gsmyshop': 'GS마이샵', 'cjmallplus': 'CJ온스타일+', 'lotteonetv': '롯데OneTV', 'hmallplus': '현대홈쇼핑+샵', 'bshop': 'SK스토아',
         'kshop': 'KT알파쇼핑', 'kshopplus': 'KT알파쇼핑+', 'ssgshop': '신세계쇼핑', 'shopnt': '쇼핑엔티', 'wshop': 'W쇼핑'}


def size(o):
    return len(json.dumps(o, ensure_ascii=False, separators=(',', ':')).encode())


def trim(doc):
    doc = json.loads(json.dumps(doc))
    for cap in (6, 4, 2, 0):
        if size(doc) <= LIMIT:
            return doc
        for i in doc['items']:
            i['op'] = (i.get('op') or [])[:cap]
    for field in ('u', 'cd', 'pg', 'cpw', 'c3'):
        if size(doc) <= LIMIT:
            break
        for i in doc['items']:
            i.pop(field, None)
    return doc


def best(i):
    return i.get('sp') or i.get('p') or 0


def changes(prev, new, coll, now_min, today):
    """Schedule/price changes for broadcasts that have not started yet today."""
    if not prev or new.get('date') != today:
        return []
    key = lambda i: (i['ch'], i['n'])
    to_min = lambda s: int(s[:2]) * 60 + int(s[3:5])
    p = {key(i): i for i in prev.get('items', []) if to_min(i['s']) >= now_min}
    n = {key(i): i for i in new.get('items', []) if to_min(i['s']) >= now_min}
    out = []
    for k, i in n.items():
        o = p.get(k)
        if not o:
            out.append({'set': coll, 'kind': '추가', 'ch': NAMES.get(i['ch'], i['ch']), 'own': i['ch'] == OWN[coll], 's': i['s'], 'n': i['n']})
        elif o['s'] != i['s']:
            out.append({'set': coll, 'kind': '시간 변경', 'ch': NAMES.get(i['ch'], i['ch']), 'own': i['ch'] == OWN[coll], 's': f"{o['s']}→{i['s']}", 'n': i['n']})
        elif best(o) and best(i) and abs(best(i) - best(o)) / best(o) >= 0.10:
            out.append({'set': coll, 'kind': '가격 변경', 'ch': NAMES.get(i['ch'], i['ch']), 'own': i['ch'] == OWN[coll], 's': i['s'], 'n': i['n'], 'price': f"{best(o):,}원→{best(i):,}원"})
    for k, o in p.items():
        if k not in n:
            out.append({'set': coll, 'kind': '취소/변경', 'ch': NAMES.get(o['ch'], o['ch']), 'own': o['ch'] == OWN[coll], 's': o['s'], 'n': o['n']})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='data')
    ap.add_argument('--prev', default='')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    idx = json.load(open(os.path.join(a.data, 'index.json')))
    now = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=9)
    today, now_min = now.strftime('%Y-%m-%d'), now.hour * 60 + now.minute
    sync = [d for d in sorted(set(idx.get('dates', [])) | set(idx.get('tdates', []))) if d >= today]
    report = {'changes': [], 'written': []}
    for d in sync:
        for coll, fname in (('days', f'{d}.json'), ('tdays', f't-{d}.json')):
            src = os.path.join(a.data, fname)
            if not os.path.exists(src):
                continue
            doc = trim(json.load(open(src)))
            json.dump(doc, open(os.path.join(a.out, f'{coll}-{d}.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
            report['written'].append(f'{coll}/{d}')
            prev_path = os.path.join(a.prev, coll, f'{d}.json') if a.prev else ''
            prev = None
            if prev_path and os.path.exists(prev_path):
                raw = json.load(open(prev_path))
                prev = raw.get('data', raw) if isinstance(raw, dict) else None
            report['changes'] += changes(prev, doc, coll, now_min, today)
    json.dump({'dates': idx.get('dates', []), 'tdates': idx.get('tdates', []), 'updatedAt': idx.get('updatedAt')},
              open(os.path.join(a.out, 'meta.json'), 'w'), ensure_ascii=False)
    upd = datetime.datetime.fromisoformat(idx['updatedAt'].replace('Z', '+00:00'))
    age = (datetime.datetime.now(datetime.timezone.utc) - upd).total_seconds() / 3600
    report.update({'ageHours': round(age, 1), 'stale': age > 6, 'last': idx.get('last', {}).get('days')})
    json.dump(report, open(os.path.join(a.out, 'report.json'), 'w'), ensure_ascii=False, indent=1)
    print(json.dumps({k: report[k] for k in ('written', 'ageHours', 'stale')}, ensure_ascii=False), 'changes:', len(report['changes']))


if __name__ == '__main__':
    main()
