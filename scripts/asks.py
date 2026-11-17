"""
호가(매도 희망가) 갱신.
 
1) 매일 자동: 아실(realty.asil.kr) 매물 목록에서 관심 단지의 15억 이하 매매 호가를 모은다.
2) 수동 보강: config/asks.txt 에 네이버 부동산 매물 목록 화면을 복사해 붙여넣으면,
   그 목록에 있는 단지·평형은 네이버 값을 우선한다(목록 날짜로부터 NAVER_TTL_DAYS 일 동안).
 
결과: docs/data/asks.json
  {"updated_at", "asil": {"ok", "codes_ok", "codes_fail", "rows"}, "naver": {"date", "rows"},
   "complexes": {단지명: {"src": "naver|asil|keep|excel|none", "date", "min", "max", "n",
                         "types": [{"area": 59, "supply": 80.5, "min", "max", "n"}]}}}
가격 단위: 만원.
"""
import json, math, os, re, time, datetime as dt
import urllib.request, urllib.parse
 
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "docs", "data")
KST = dt.timezone(dt.timedelta(hours=9))
MAX_PRICE = 150000          # 15억(만원)
NAVER_TTL_DAYS = 7
RADIUS_M = 350              # 아실 매물 좌표와 단지 좌표 허용 거리
ASIL_URL = "https://realty.asil.kr/api_asil/offers_list.aspx"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0 Safari/537.36", "Referer": "https://asil.kr/"}
 
 
def norm(s):
    s = re.sub(r"\(.*?\)", "", s or "")
    for w in ("아파트", " ", "-", "·"):
        s = s.replace(w, "")
    return s.strip()
 
 
def dist_m(a, b):
    lat1, lng1 = a; lat2, lng2 = b
    k = math.pi / 180
    x = (lng2 - lng1) * k * math.cos((lat1 + lat2) / 2 * k)
    y = (lat2 - lat1) * k
    return math.hypot(x, y) * 6371000
 
 
def name_match(name, c):
    """단지 이름 일치 여부. 정확히 같으면 2, 느슨하게(포함) 같으면 1, 아니면 0."""
    n = norm(name)
    keys = {norm(a) for a in c.get("aliases", [])} | {norm(c["name"])}
    if n in keys:
        return 2
    for k in keys:
        if len(k) >= 3 and (k in n or n in k):
            rest = n.replace(k, "") if k in n else k.replace(n, "")
            if not re.search(r"\d", rest):      # '경남아너스빌' vs '경남아너스빌2차' 같은 다른 단지 방지
                return 1
    return 0
 
 
# ---------------------------------------------------------------- 아실
def asil_page(code, page):
    q = {"srch_sub_rlst": "A01", "srch_dealtype": "A01", "srch_order_by": "3",
         "srch_min_prc": "0", "srch_max_prc": str(MAX_PRICE), "srch_le_min_prc": "0", "srch_le_max_prc": "99999",
         "srch_min_spc": "0", "srch_max_spc": "", "rlsttype_cd": "", "gps_x_max": "", "gps_x_min": "",
         "gps_y_max": "", "gps_y_min": "", "bdong_cd": code, "asil_bldcode": "", "next_flag": "", "now_page": str(page)}
    req = urllib.request.Request(ASIL_URL + "?" + urllib.parse.urlencode(q), headers=UA)
    last = None
    for i in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8")).get("list_result") or []
        except Exception as e:
            last = e
            time.sleep(2 * (i + 1))
    raise last
 
 
def fetch_asil(codes):
    rows, ok, fail = [], [], []
    for code in codes:
        seen = set()
        try:
            for page in range(1, 151):
                lst = asil_page(code, page)
                new = [x for x in lst if x.get("mm_uid") not in seen]
                if not new:
                    break
                for x in new:
                    seen.add(x.get("mm_uid"))
                    x["_code"] = code
                    rows.append(x)
                time.sleep(0.3)
            ok.append(code)
        except Exception as e:
            print(f"아실 {code} 실패: {e}")
            fail.append(code)
    return rows, ok, fail
 
 
def num(s):
    try:
        return float(str(s).replace(",", ""))
    except ValueError:
        return None
 
 
def match_asil(rows, complexes, code_map):
    out = {}
    unmatched = {}
    for x in rows:
        nm = x.get("BLDNM") or ""
        if re.search(r"도시형|주상복합|민간임대|오피스텔", nm):
            continue
        lat, lng = num(x.get("MAP_Y")), num(x.get("MAP_X"))
        cands = []
        for c in complexes:
            if x["_code"] not in code_map.get(f"{c['lawd']}|{c['dong']}", []):
                continue
            if lat and c.get("lat") and dist_m((lat, lng), (c["lat"], c["lng"])) > RADIUS_M:
                continue
            s = name_match(nm, c)
            if s:
                cands.append((s, c["name"]))
        best = [n for s, n in cands if s == max((s for s, _ in cands), default=0)]
        if len(best) != 1:
            unmatched[nm] = unmatched.get(nm, 0) + 1
            continue
        price, ex, sp = num(x.get("DEAL_AMT")), num(x.get("EXCLS_SPC")), num(x.get("SPLY_SPC"))
        if not price or not ex:
            continue
        d = x.get("SVC_DATE_STRT") or ""            # '26.11.16'
        out.setdefault(best[0], []).append({"area": ex, "supply": sp, "price": int(price),
                                            "floor": x.get("CORES_FLR_CNT_NM") or "", "date": d})
    return out, unmatched
 
 
# ---------------------------------------------------------------- 네이버 붙여넣기
PRICE_RE = re.compile(r"^매매\s*(.+)$")
AREA_RE = re.compile(r"(\d+(?:\.\d+)?)[A-Z0-9\-]*㎡\s*\(전용\s*(\d+(?:\.\d+)?)")
DATE_RE = re.compile(r"(20\d\d)\.(\d\d)\.(\d\d)")
 
 
def parse_eok(s):
    """'14억 8,000' → 148000, '9억' → 90000, '8,000' → 8000"""
    s = s.strip()
    m = re.match(r"(?:(\d+)억)?\s*([\d,]+)?", s)
    if not m or (not m.group(1) and not m.group(2)):
        return None
    return int(m.group(1) or 0) * 10000 + int((m.group(2) or "0").replace(",", ""))
 
 
def parse_naver(text, complexes):
    """네이버 매물 목록 복사 텍스트 → {단지명: [매물]}, 기준일.
    '# 당산' 처럼 '#'으로 시작하는 줄을 넣으면 그 아래 매물은 해당 지역 단지에서만 찾는다."""
    lines = [l.strip() for l in text.splitlines()]
    region, out, dates, skipped = None, {}, [], {}
    regions = {c["region"] for c in complexes}
    for i, l in enumerate(lines):
        if l.startswith("#"):
            r = l.lstrip("#").strip()
            hit = [g for g in regions if r and (r == g or r in g.split("·"))]
            region = hit[0] if len(hit) == 1 else None
            continue
        m = PRICE_RE.match(l)
        if not m or i == 0:
            continue
        name_line = lines[i - 1]
        nm = re.sub(r"\s+\S+동$", "", name_line).strip()          # '성원 101동' → '성원'
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        am = AREA_RE.search(nxt)
        if not am:
            continue
        parts = [parse_eok(p) for p in m.group(1).replace("변동상승내역 보기", "").replace("변동하락내역 보기", "").split("~")]
        parts = [p for p in parts if p]
        if not parts:
            continue
        supply, ex = float(am.group(1)), float(am.group(2))
        fl = re.search(r"\)\s*([^/\s]+)/(\d+)층", nxt)
        dm = None
        for j in range(i + 1, min(i + 6, len(lines))):
            dm = DATE_RE.search(lines[j])
            if dm:
                break
        if dm:
            dates.append(dt.date(*map(int, dm.groups())))
        pool = [c for c in complexes if region is None or c["region"] == region]
        cands = [(name_match(nm, c), c) for c in pool]
        top = max((s for s, _ in cands), default=0)
        best = [c for s, c in cands if s and s == top]
        k = str(math.floor(ex))
        sup_ok = lambda c: bool(c.get("supply", {}).get(k)) and abs(c["supply"][k] - supply) <= 1.5
        if len(best) > 1 or region is None:
            # 이름이 같은 단지(예: 성원 2곳, 사당·양평 경남아너스빌)는 공급면적 대응표로 구분.
            # 지역 머리말('# 당산')이 없으면 오매칭을 막기 위해 항상 이 확인을 거친다.
            best = [c for c in best if sup_ok(c)]
        if len(best) != 1:
            skipped[nm] = skipped.get(nm, 0) + 1
            continue
        out.setdefault(best[0]["name"], []).append({
            "area": ex, "supply": supply, "price": parts[0], "price_hi": parts[-1],
            "floor": fl.group(1) if fl else "", "date": dm.group(0) if dm else ""})
    return out, (max(dates) if dates else None), skipped
 
 
# ---------------------------------------------------------------- 집계
def summarize(listings):
    uniq = {}
    for l in listings:          # 같은 매물을 여러 중개사가 올린 경우 하나로
        key = (round(l["area"], 1), l["floor"], l["price"], l.get("price_hi", l["price"]))
        uniq[key] = l
    ls = list(uniq.values())
    types = {}
    for l in ls:
        t = types.setdefault(math.floor(l["area"]), {"area": math.floor(l["area"]), "supply": l.get("supply"),
                                                     "min": l["price"], "max": l.get("price_hi", l["price"]), "n": 0})
        t["min"] = min(t["min"], l["price"]); t["max"] = max(t["max"], l.get("price_hi", l["price"])); t["n"] += 1
    tl = sorted(types.values(), key=lambda t: t["area"])
    return {"min": min(t["min"] for t in tl), "max": max(t["max"] for t in tl), "n": len(ls), "types": tl}
 
 
def update_asks(complexes):
    today = dt.datetime.now(KST).date()
    path = os.path.join(DATA, "asks.json")
    try:
        prev = json.load(open(path, encoding="utf-8")).get("complexes", {})
    except (FileNotFoundError, ValueError):
        prev = {}
    code_map = json.load(open(os.path.join(ROOT, "config", "asil_codes.json"), encoding="utf-8"))["codes"]
    codes = sorted({c for k in code_map.values() for c in k})
 
    rows, ok, fail = fetch_asil(codes)
    asil, unmatched = match_asil(rows, complexes, code_map)
 
    naver, ndate, skipped = {}, None, {}
    tpath = os.path.join(ROOT, "config", "asks.txt")
    if os.path.exists(tpath):
        naver, ndate, skipped = parse_naver(open(tpath, encoding="utf-8").read(), complexes)
    naver_fresh = bool(ndate and (today - ndate).days <= NAVER_TTL_DAYS)
 
    result = {}
    for c in complexes:
        n = c["name"]
        if naver_fresh and naver.get(n):
            result[n] = {"src": "naver", "date": ndate.isoformat(), **summarize(naver[n])}
        elif asil.get(n):
            result[n] = {"src": "asil", "date": today.isoformat(), **summarize(asil[n])}
        elif prev.get(n) and prev[n].get("src") in ("asil", "naver", "keep") and prev[n].get("date") \
                and (today - dt.date.fromisoformat(prev[n]["date"])).days <= 14:
            result[n] = {**prev[n], "src": "keep"}       # 오늘 못 찾음 → 최근 14일 내 값 유지(날짜는 원래 날짜)
        elif c.get("min_ask"):
            result[n] = {"src": "excel", "date": None, "min": int(c["min_ask"] * 10000),
                         "max": int(c["max_ask"] * 10000), "n": None, "types": []}
        else:
            result[n] = {"src": "none", "date": None, "n": 0}
 
    out = {"updated_at": dt.datetime.now(KST).isoformat(timespec="minutes"),
           "asil": {"ok": not fail, "codes_ok": len(ok), "codes_fail": fail, "rows": len(rows),
                    "unmatched": sorted(unmatched.items(), key=lambda x: -x[1])[:30]},
           "naver": {"date": ndate.isoformat() if ndate else None, "fresh": naver_fresh,
                     "rows": sum(len(v) for v in naver.values()), "skipped": sorted(skipped.items(), key=lambda x: -x[1])[:30]},
           "complexes": result}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"호가: 아실 {len(rows)}건(실패 코드 {len(fail)}), 네이버 {out['naver']['rows']}건 기준일 {out['naver']['date']}")
    return {"asks_asil_ok": not fail, "asks_asil_rows": len(rows)}
 
