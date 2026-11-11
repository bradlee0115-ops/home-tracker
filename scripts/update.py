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


NEWS_CONFIG = os.path.join(ROOT, "config", "news.json")
NEWS_RSS = "https://news.google.com/rss/search"


def fetch_news(query, days=30, limit=8):
    """구글 뉴스 RSS 검색. 제목·출처·링크·날짜만 저장한다."""
    xml = http_get(NEWS_RSS, {"q": f"{query} when:{days}d", "hl": "ko", "gl": "KR", "ceid": "KR:ko"})
    root = ET.fromstring(xml)
    out = []
    for it in root.findall(".//item")[:limit]:
        title = pick(it, "title")
        src = pick(it, "source")
        if src and title.endswith(" - " + src):
            title = title[: -len(" - " + src)]
        pub = pick(it, "pubDate")
        try:
            d = dt.datetime.strptime(pub[:25].strip(), "%a, %d %b %Y %H:%M:%S").date().isoformat()
        except Exception:
            d = ""
        out.append({"title": title, "source": src, "link": pick(it, "link"), "date": d})
    return out


def dedupe(items):
    seen, out = set(), []
    for x in sorted(items, key=lambda x: x["date"], reverse=True):
        k = re.sub(r"\W", "", x["title"])[:40]
        if k in seen:
            continue
        seen.add(k)
        out.append(x)
    return out


ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-5-5")


def ask_claude(key, prompt):
    body = json.dumps({"model": CLAUDE_MODEL, "max_tokens": 800,
                       "system": "너는 서울 정비사업(재건축·재개발·리모델링·모아타운) 진행 단계를 판정하는 보수적인 분석가다. 제공된 기사 제목과 기존 판정만 근거로 삼고, 근거가 없으면 단계를 올리지 않는다. 반드시 JSON 하나만 출력한다.",
                       "messages": [{"role": "user", "content": prompt}]}).encode("utf-8")
    req = urllib.request.Request(ANTHROPIC_URL, data=body, method="POST", headers={
        "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        js = json.loads(r.read().decode("utf-8"))
    text = "".join(c.get("text", "") for c in js.get("content", []) if c.get("type") == "text")
    text = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    return json.loads(text)


# 단계별 '완료' 신호 키워드. 제목에 있으면 그 단계가 끝난 것으로 보고 다음 단계로 넘긴다.
DONE_RULES = {
    "조합설립": [r"조합\s*설립\s*인가", r"조합\s*창립총회", r"조합\s*출범"],
    "시공사 선정": [r"시공사\s*(선정|확정)", r"수주", r"시공권\s*(확보|획득)"],
    "안전진단": [r"안전진단\s*(통과|완료)", r"안전성\s*검토\s*(통과|완료)"],
    "심의": [r"(건축|도시계획|통합|건축위원회)?\s*심의\s*(통과|가결|의결)", r"조건부\s*(통과|의결|가결)"],
    "사업계획승인": [r"사업계획\s*승인", r"행위\s*허가"],
    "이주·착공": [r"착공", r"이주\s*(시작|개시)"],
    "입주": [r"준공", r"입주\s*(시작|개시)"],
    "정비구역 지정": [r"정비구역\s*(지정|고시)"],
    "추진위·조합설립": [r"조합\s*설립\s*인가", r"추진위(원회)?\s*(승인|구성)"],
    "사업시행인가": [r"사업시행\s*(계획)?\s*인가"],
    "관리처분인가": [r"관리처분\s*(계획)?\s*인가"],
    "관리계획": [r"관리계획\s*(승인|고시|확정)"],
}
NOT_DONE = r"(추진|예정|준비|앞두|기대|목표|도전|전망|신청)"


def judge_by_rules(p, base_step):
    """무료 판정: 사업명 단어가 들어간 기사 제목에서 '완료' 키워드를 찾아 단계를 올린다(내리지는 않는다)."""
    steps = p.get("steps", [])
    best, ev = base_step, []
    for x in p.get("news", []):
        t = x["title"]
        if not any(m in t for m in p.get("match", [])):
            continue
        for i, st in enumerate(steps):
            pats = DONE_RULES.get(st, [])
            for pat in pats:
                mm = re.search(pat, t)
                if mm and not re.search(NOT_DONE, t[mm.end(): mm.end() + 6]):
                    nxt = min(i + 1, len(steps) - 1)
                    if nxt > best:
                        best, ev = nxt, [t]
    return best, ev


def judge_projects(projects):
    """기사 목록이 바뀐 사업만 Claude에게 단계 판정을 맡긴다. 단계 구분(steps)은 고정."""
    key = os.environ.get("ANTHROPIC_API_KEY")
    store_path = os.path.join(DATA, "ai_stage.json")
    store = load(store_path, {})
    today = dt.datetime.now(KST).date().isoformat()
    errors = []
    for p in projects:
        prev = store.get(p["name"])
        sig = "|".join(sorted(x["title"] for x in p.get("news", [])))
        if not key and (not prev or prev.get("sig") != sig):
            steps = p.get("steps", [])
            base_step = prev["step_now"] if prev else p.get("step_now", 0)
            n, ev = judge_by_rules(p, base_step)
            store[p["name"]] = {"step_now": n,
                                "stage": (f"{steps[n-1]} 완료 기사 확인, 현재 '{steps[n]}' 단계로 추정" if n != base_step
                                          else (prev or {}).get("stage") or p.get("stage")),
                                "stage_date": today[:7] if n != base_step else (prev or {}).get("stage_date") or p.get("stage_date"),
                                "confidence": "규칙 판정", "evidence": ev,
                                "reason": ("기사 제목의 완료 키워드로 판정: " + ev[0]) if ev else "새 기사에 단계 완료 신호 없음, 기존 단계 유지",
                                "judged_at": today, "sig": sig,
                                "changed_from": base_step if n != base_step else (prev or {}).get("changed_from"),
                                "changed_at": today if n != base_step else (prev or {}).get("changed_at")}
        elif key and (not prev or prev.get("sig") != sig):
            steps = p.get("steps", [])
            base_step = prev["step_now"] if prev else p.get("step_now", 0)
            prompt = (
                f"사업명: {p['name']} ({p.get('type')})\n"
                f"단계 구분(이 목록과 순서를 그대로 사용, 0부터 시작): {json.dumps(steps, ensure_ascii=False)}\n"
                f"현재 기준 판정: step_now={base_step} ({steps[base_step] if steps and base_step < len(steps) else ''}), "
                f"설명='{(prev or {}).get('stage') or p.get('stage')}', 기준일={(prev or {}).get('stage_date') or p.get('stage_date')}\n"
                f"사람이 확인한 최초 기준: step_now={p.get('step_now')}, '{p.get('stage')}' ({p.get('stage_source')})\n"
                "최근 기사(날짜 · 언론사 · 제목):\n" +
                "\n".join(f"- {x['date']} · {x['source']} · {x['title']}" for x in p.get("news", [])) +
                "\n\n정의: step_now는 지금 진행 중인 단계의 번호이며, 그 앞 단계들은 완료된 것으로 본다. 어떤 단계가 완료(통과·인가·선정)됐다면 step_now는 그다음 단계다.\n규칙: 1) 기사 제목에 해당 단계의 완료·인가·선정·통과가 명시된 경우에만 step_now를 올린다. "
                "2) '추진', '예정', '준비', '기대'는 완료로 보지 않는다. 3) 사업 중단·해산·재건축 전환 등 명시된 경우만 낮추고 reason에 적는다. "
                "4) 다른 단지·구역 기사는 무시한다. 5) 근거 기사가 없으면 기준 판정을 그대로 유지한다.\n"
                '출력 형식: {"step_now": 정수, "stage": "현재 상태 한 문장(한국어)", "stage_date": "YYYY-MM 또는 빈 문자열", '
                '"confidence": "높음|중간|낮음", "evidence": ["근거 기사 제목", ...], "reason": "판단 이유 한두 문장"}'
            )
            try:
                r = ask_claude(key, prompt)
                n = int(r.get("step_now", base_step))
                n = max(0, min(n, len(steps) - 1)) if steps else 0
                store[p["name"]] = {"step_now": n, "stage": r.get("stage", ""), "stage_date": r.get("stage_date", ""),
                                    "confidence": r.get("confidence", ""), "evidence": r.get("evidence", [])[:3],
                                    "reason": r.get("reason", ""), "judged_at": today, "sig": sig,
                                    "changed_from": base_step if n != base_step else None,
                                    "changed_at": today if n != base_step else (prev or {}).get("changed_at")}
            except Exception as e:
                errors.append(f"{p['name']}: {e}")
            time.sleep(1)
        if p["name"] in store:
            p["ai"] = {k: v for k, v in store[p["name"]].items() if k != "sig"}
    save(store_path, store)
    return errors


def update_news():
    try:
        cfg = json.load(open(NEWS_CONFIG, encoding="utf-8"))
    except FileNotFoundError:
        print("config/news.json이 없어 뉴스 수집을 건너뜁니다.")
        return None
    errors, projects, topics = [], [], []
    for p in cfg.get("projects", []):
        items = []
        for q in p.get("keywords", []):
            try:
                items += fetch_news(q, days=90, limit=6)
            except Exception as e:
                errors.append(f"{q}: {e}")
            time.sleep(0.5)
        projects.append({k: v for k, v in p.items() if k != "keywords"} | {"news": dedupe(items)[:8]})
    for t in cfg.get("topics", []):
        items = []
        for q in t.get("queries", []):
            try:
                items += fetch_news(q, days=14, limit=8)
            except Exception as e:
                errors.append(f"{q}: {e}")
            time.sleep(0.5)
        topics.append({"name": t["name"], "news": dedupe(items)[:15]})
    errors += judge_projects(projects)
    save(os.path.join(DATA, "news.json"), {"projects": projects, "topics": topics,
         "updated_at": dt.datetime.now(KST).isoformat(timespec="minutes"), "errors": errors})
    return {"news_errors": len(errors)}


def main():
    os.makedirs(DATA, exist_ok=True)
    complexes = json.load(open(CONFIG, encoding="utf-8"))["complexes"]
    save(os.path.join(DATA, "complexes.json"), complexes)
    t = update_trades(complexes)
    w = update_weekly(complexes)
    n = update_news()
    meta = load(os.path.join(DATA, "meta.json"), {})
    meta.setdefault("first_run", dt.datetime.now(KST).date().isoformat())
    meta.update({"updated_at": dt.datetime.now(KST).isoformat(timespec="minutes"), "months": MONTHS})
    if t is not None:
        meta.update(t)
    if w is not None:
        meta["weekly"] = w
    if n is not None:
        meta.update(n)
    save(os.path.join(DATA, "meta.json"), meta)
    print(json.dumps({k: v for k, v in meta.items() if k != "unmatched"}, ensure_ascii=False))
    if t and t["errors"] and t["trades"] == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
