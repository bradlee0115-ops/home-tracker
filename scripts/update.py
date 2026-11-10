"""
국토교통부 아파트 매매 실거래가 + (선택) 한국부동산원 주간 아파트가격동향을 받아
docs/data/*.json 으로 저장한다. GitHub Actions에서 매일 실행된다.

필요한 환경변수 (GitHub Secrets)
  MOLIT_API_KEY   : 공공데이터포털 '국토교통부_아파트 매매 실거래가 상세 자료' 인증키(Decoding 키)
  REB_API_KEY     : (선택) 한국부동산원 R-ONE 오픈API 인증키
  REB_STATBL_ID   : (선택) R-ONE 주간 아파트 매매가격지수 통계표 ID
"""
import json, os, re, sys, time, datetime as dt
import urllib.request, urllib.parse
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, "config", "complexes.json")
DATA = os.path.join(ROOT, "docs", "data")
MONTHS = int(os.environ.get("MONTHS", "13"))          # 최근 몇 개월치를 받을지
MOLIT_URL = os.environ.get(
    "MOLIT_URL",
    "https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev",
)
REB_URL = os.environ.get("REB_URL", "https://www.reb.or.kr/r-one/openapi/SttsApiTblData.do")
KST = dt.timezone(dt.timedelta(hours=9))


def norm(s):
    s = re.sub(r"\(.*?\)", "", s or "")
    s = s.replace("아파트", "").replace(" ", "").replace("-", "")
    return s.strip()


def http_get(url, params, tries=3):
    q = url + "?" + urllib.parse.urlencode(params, safe="%")
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(q, timeout=30) as r:
                return r.read().decode("utf-8")
        except Exception as e:  # 네트워크 일시 오류 재시도
            last = e
            time.sleep(2 * (i + 1))
    raise last


def pick(item, *names):
    for n in names:
        el = item.find(n)
        if el is not None and el.text is not None:
            return el.text.strip()
    return ""


def fetch_month(key, lawd, ym):
    rows, page = [], 1
    while True:
        xml = http_get(MOLIT_URL, {"serviceKey": key, "LAWD_CD": lawd, "DEAL_YMD": ym,
                                   "pageNo": page, "numOfRows": 1000})
        root = ET.fromstring(xml)
        code = pick(root, ".//resultCode")
        if code and code not in ("00", "000"):
            raise RuntimeError(f"API 오류 {lawd} {ym}: {code} {pick(root, './/resultMsg')}")
        items = root.findall(".//item")
        for it in items:
            rows.append({
                "apt": pick(it, "aptNm", "아파트"),
                "dong": pick(it, "umdNm", "법정동"),
                "jibun": pick(it, "jibun", "지번"),
                "area": float(pick(it, "excluUseAr", "전용면적") or 0),
                "floor": pick(it, "floor", "층"),
                "price": int(pick(it, "dealAmount", "거래금액").replace(",", "") or 0),
                "y": int(pick(it, "dealYear", "년") or 0),
                "m": int(pick(it, "dealMonth", "월") or 0),
                "d": int(pick(it, "dealDay", "일") or 0),
                "cancel": bool(pick(it, "cdealType", "해제여부")),
                "built": pick(it, "buildYear", "건축년도"),
            })
        total = int(pick(root, ".//totalCount") or 0)
        if page * 1000 >= total or not items:
            return rows
        page += 1


def months_back(n):
    t = dt.datetime.now(KST).date().replace(day=1)
    out = []
    for _ in range(n):
        out.append(t.strftime("%Y%m"))
        t = (t - dt.timedelta(days=1)).replace(day=1)
    return out


def build_matcher(complexes):
    by_dong = {}
    for c in complexes:
        by_dong.setdefault((c["lawd"], c["dong"]), []).append(c)

    def match(lawd, dong, apt):
        cands = by_dong.get((lawd, dong), [])
        n = norm(apt)
        exact = [c for c in cands if n in {norm(a) for a in c["aliases"]}]
        if len(exact) == 1:
            return exact[0]["name"]
        loose = [c for c in cands
                 if any(len(norm(a)) >= 3 and (norm(a) in n or n in norm(a)) for a in c["aliases"])]
        return loose[0]["name"] if len(loose) == 1 else None
    return match, by_dong


def load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def update_trades(complexes):
    key = os.environ.get("MOLIT_API_KEY")
    if not key:
        print("MOLIT_API_KEY가 없어 실거래 갱신을 건너뜁니다.")
        return None
    match, by_dong = build_matcher(complexes)
    lawds = sorted({c["lawd"] for c in complexes})
    tracked = {k for k in by_dong}
    today = dt.datetime.now(KST).date().isoformat()
    seen = load(os.path.join(DATA, "seen.json"), {})
    trades, unmatched, errors = [], {}, []
    for lawd in lawds:
        for ym in months_back(MONTHS):
            try:
                rows = fetch_month(key, lawd, ym)
            except Exception as e:
                errors.append(str(e))
                continue
            for r in rows:
                if (lawd, r["dong"]) not in tracked:
                    continue
                cx = match(lawd, r["dong"], r["apt"])
                date = f"{r['y']:04d}-{r['m']:02d}-{r['d']:02d}"
                tid = "|".join([lawd, r["dong"], r["apt"], r["jibun"], f"{r['area']:.2f}", r["floor"], date, str(r["price"])])
                seen.setdefault(tid, today)
                if cx is None:
                    k = f"{r['dong']}|{r['apt']}"
                    unmatched[k] = unmatched.get(k, 0) + 1
                trades.append({"id": tid, "date": date, "lawd": lawd, "dong": r["dong"], "apt": r["apt"],
                               "complex": cx, "area": r["area"], "floor": r["floor"], "price": r["price"],
                               "cancel": r["cancel"], "first_seen": seen[tid]})
            time.sleep(0.2)
    trades.sort(key=lambda t: (t["date"], t["price"]), reverse=True)
    save(os.path.join(DATA, "trades.json"), trades)
    save(os.path.join(DATA, "seen.json"), seen)
    return {"trades": len(trades), "unmatched": sorted(
        [{"dong": k.split("|")[0], "apt": k.split("|")[1], "count": v} for k, v in unmatched.items()],
        key=lambda x: (-x["count"], x["dong"])), "errors": errors}


def update_weekly(complexes):
    key, sid = os.environ.get("REB_API_KEY"), os.environ.get("REB_STATBL_ID")
    if not (key and sid):
        print("REB_API_KEY/REB_STATBL_ID가 없어 주간 동향을 건너뜁니다.")
        return None
    gus = {c["gu"] for c in complexes}
    try:
        raw = http_get(REB_URL, {"KEY": key, "Type": "json", "STATBL_ID": sid, "DTACYCLE_CD": "WK",
                                 "pIndex": 1, "pSize": 1000})
        js = json.loads(raw)
        rows = []
        for block in js.get("SttsApiTblData", []):
            rows += block.get("row", []) if isinstance(block, dict) else []
        out = {}
        for r in rows:
            name = (r.get("CLS_NM") or r.get("CLS_FULLNM") or "").split(">")[-1].strip()
            if name in gus:
                out.setdefault(name, []).append({"week": r.get("WRTTIME_IDTFR_ID"), "value": r.get("DTA_VAL")})
        for v in out.values():
            v.sort(key=lambda x: x["week"])
        save(os.path.join(DATA, "weekly.json"), out)
        return {"regions": list(out)}
    except Exception as e:
        return {"error": f"주간 동향 수집 실패: {e}"}


def main():
    os.makedirs(DATA, exist_ok=True)
    complexes = json.load(open(CONFIG, encoding="utf-8"))["complexes"]
    save(os.path.join(DATA, "complexes.json"), complexes)
    t = update_trades(complexes)
    w = update_weekly(complexes)
    meta = load(os.path.join(DATA, "meta.json"), {})
    meta.setdefault("first_run", dt.datetime.now(KST).date().isoformat())
    meta.update({"updated_at": dt.datetime.now(KST).isoformat(timespec="minutes"), "months": MONTHS})
    if t is not None:
        meta.update(t)
    if w is not None:
        meta["weekly"] = w
    save(os.path.join(DATA, "meta.json"), meta)
    print(json.dumps({k: v for k, v in meta.items() if k != "unmatched"}, ensure_ascii=False))
    if t and t["errors"] and t["trades"] == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
