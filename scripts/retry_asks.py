"""
호가 재시도: 직전 정기 실행에서 아실 수집이 실패했을 때만 호가(asks.json)를 다시 받는다.
직전 수집이 성공했으면 아무것도 하지 않는다. 실거래·뉴스는 건드리지 않는다.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import asks

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "docs", "data")


def main():
    try:
        prev = json.load(open(os.path.join(DATA, "asks.json"), encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        prev = {}
    if prev.get("asil", {}).get("ok"):
        print(f"직전 아실 수집 성공({prev.get('updated_at')}) → 재시도 생략")
        return
    print(f"직전 아실 수집 실패({prev.get('updated_at')}) → 재시도")
    complexes = json.load(open(os.path.join(ROOT, "config", "complexes.json"), encoding="utf-8"))["complexes"]
    a = asks.update_asks(complexes)
    mp = os.path.join(DATA, "meta.json")
    try:
        meta = json.load(open(mp, encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        meta = {}
    meta.update(a)
    meta["asks_retry_at"] = json.load(open(os.path.join(DATA, "asks.json"), encoding="utf-8"))["updated_at"]
    with open(mp, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
