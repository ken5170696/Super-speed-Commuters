#!/usr/bin/env python3
"""Build data/signal_plans.json from Taipei City's open signal timing plans.

Source (free, no key, refreshed daily by 臺北市政府交通局):
  https://tcgbusfs.blob.core.windows.net/dotapp/timing_plan_table.json  (which plan runs when)
  https://tcgbusfs.blob.core.windows.net/dotapp/timing_plan.json        (cycle, offset, phase splits)
Dataset page: https://data.gov.tw/dataset/145720

The plans carry intersection names but no coordinates, so each intersection is
located by finding where its two named roads meet in data/graph.json.

Usage: python3 tools/build_signal_plans.py [--table F] [--plans F] [--graph data/graph.json] [--out data/signal_plans.json]
"""
import argparse, json, os, sys, time, urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from match_ic import Matcher  # noqa: E402

BASE = "https://tcgbusfs.blob.core.windows.net/dotapp/"


def fetch(name, path):
    if path and os.path.exists(path):
        return json.load(open(path, encoding="utf-8"))
    req = urllib.request.Request(BASE + name, headers={"User-Agent": "super-speed-commuters/1.0"})
    return json.loads(urllib.request.urlopen(req, timeout=300).read().decode("utf-8-sig"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--table"); ap.add_argument("--plans")
    ap.add_argument("--graph", default="data/graph.json"); ap.add_argument("--out", default="data/signal_plans.json")
    a = ap.parse_args()
    table, plans = fetch("timing_plan_table.json", a.table), fetch("timing_plan.json", a.plans)
    g = json.load(open(a.graph, encoding="utf-8"))
    m = Matcher(g)

    where, names = {}, {}
    for r in table:
        ic = r["icid"]
        if ic in where:
            continue
        loc = m.locate(r["icname"])
        if loc:
            where[ic] = loc
            names[ic] = " × ".join(p for p in r["icname"].replace("　", " ").split() if p)

    out = {}
    for r in table:
        ic = r["icid"]
        if ic not in where:
            continue
        o = out.setdefault(ic, {"n": names[ic], "x": round(where[ic][0]), "y": round(where[ic][1]), "w": [None] * 7, "p": {}})
        day = int(r["segmenttype"]) - 1           # 1-5 weekdays, 6-7 weekend
        if 0 <= day < 7 and o["w"][day] is None:
            o["w"][day] = [[int(s["time"][:2]) * 60 + int(s["time"][2:]), str(s["planid（SeqNo）"])] for s in r["subsegment"]]
    for r in plans:
        ic = r["icid"]
        if ic not in out:
            continue
        pid = str(r["planid（SeqNo）"])
        out[ic]["p"][pid] = [r["cycletime"], r["offset"], r["direction"], [[s["green"], s["yellow"], s["allred"]] for s in r["subplan"]]]
    # keep only plans that a schedule uses; share identical day schedules
    for o in out.values():
        used = {pid for day in o["w"] if day for _, pid in day}
        o["p"] = {k: v for k, v in o["p"].items() if k in used}
        uniq = []
        for day in o["w"]:
            key = json.dumps(day)
            if key not in uniq:
                uniq.append(key)
        o["s"] = [json.loads(k) for k in uniq]
        o["w"] = [uniq.index(json.dumps(day)) for day in o["w"]]
    info = next((r.get("InfoTime") for r in table if r.get("InfoTime")), None)
    json.dump({"v": 1, "built": time.strftime("%Y-%m-%d"), "infoTime": info, "source": "臺北市政府交通局 路口號誌時制計畫 (data.gov.tw/dataset/145720)", "ic": out},
              open(a.out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"intersections located {len(out)} of {len(set(r['icid'] for r in table))}; size {os.path.getsize(a.out) // 1024} KB")


if __name__ == "__main__":
    main()
