"""
관심 지역 지하철·경전철 노선과 역을 OpenStreetMap(Overpass API)에서 받아 docs/data/subway.json으로 저장한다.
노선 색은 OSM 노선 정보의 colour 태그(각 호선 공식 색)를 그대로 쓴다.
한 달에 한 번만 새로 받는다(노선이 자주 바뀌지 않음).
"""
import json, os, time, datetime as dt
import urllib.request, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "data", "subway.json")
ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
UA = {"User-Agent": "home-tracker/1.0 (+https://github.com/bradlee0115-ops/home-tracker)",
      "Content-Type": "application/x-www-form-urlencoded"}
REFRESH_DAYS = 30


def bbox_of(complexes, pad=0.025):
    la = [c["lat"] for c in complexes if c.get("lat")]
    ln = [c["lng"] for c in complexes if c.get("lng")]
    return (round(min(la) - pad, 4), round(min(ln) - pad, 4), round(max(la) + pad, 4), round(max(ln) + pad, 4))


def overpass(q):
    last = None
    for url in ENDPOINTS:
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": q}).encode(), headers=UA)
            with urllib.request.urlopen(req, timeout=200) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            last = e
            print(f"Overpass {url} 실패: {e}")
            time.sleep(5)
    raise last


def update_subway(complexes, force=False):
    try:
        old = json.load(open(OUT, encoding="utf-8"))
        age = (dt.date.today() - dt.date.fromisoformat(old.get("updated", "2000-01-01"))).days
        if not force and age < REFRESH_DAYS:
            return {"subway": f"skip({age}일 전 갱신)"}
    except (FileNotFoundError, ValueError):
        pass
    s, w, n, e = bbox_of(complexes)
    bb = f"{s},{w},{n},{e}"
    q = f"""[out:json][timeout:180];
(
  relation["route"~"^(subway|light_rail)$"]({bb});
  relation["route"="train"]["colour"]({bb});
);
out geom;
node["railway"="station"]({bb});
out body;"""
    js = overpass(q)
    inside = lambda la, lo: s - .01 <= la <= n + .01 and w - .01 <= lo <= e + .01
    lines, seen = {}, set()
    stations = {}
    for el in js.get("elements", []):
        t = el.get("tags", {})
        if el["type"] == "relation":
            colour = t.get("colour") or "#888888"
            name = t.get("name:ko") or t.get("name") or t.get("ref") or ""
            key = t.get("ref") or colour
            ln = lines.setdefault(key, {"name": name, "ref": t.get("ref", ""), "colour": colour, "paths": []})
            if len(name) < len(ln["name"]) or not ln["name"]:
                ln["name"] = name                       # 방향별 노선 중 가장 짧은 이름(예: '2호선')
            for m in el.get("members", []):
                if m.get("type") != "way" or not m.get("geometry"):
                    continue
                if (key, m["ref"]) in seen:
                    continue
                pts = [[round(p["lat"], 5), round(p["lon"], 5)] for p in m["geometry"]]
                if not any(inside(a, b) for a, b in pts):
                    continue
                seen.add((key, m["ref"]))
                ln["paths"].append(pts)
        elif el["type"] == "node":
            nm = t.get("name:ko") or t.get("name")
            if nm and inside(el["lat"], el["lon"]):
                k = nm.split("(")[0].strip()
                stations.setdefault(k, {"name": nm, "lat": round(el["lat"], 5), "lng": round(el["lon"], 5)})
    out = {"updated": dt.date.today().isoformat(), "bbox": [s, w, n, e],
           "lines": [v for v in lines.values() if v["paths"]], "stations": list(stations.values()),
           "source": "© OpenStreetMap contributors (Overpass API)"}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"지하철: 노선 {len(out['lines'])}개, 역 {len(out['stations'])}개")
    return {"subway": f"노선 {len(out['lines'])} · 역 {len(out['stations'])}"}


if __name__ == "__main__":
    cx = json.load(open(os.path.join(ROOT, "config", "complexes.json"), encoding="utf-8"))["complexes"]
    print(update_subway(cx, force=True))
