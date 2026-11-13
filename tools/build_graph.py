#!/usr/bin/env python3
"""Build data/graph.json: the motorcycle-legal road network used for on-phone routing.

Usage:
  python3 tools/build_graph.py --tiles DIR [--out data/graph.json]

DIR holds OpenStreetMap API map extracts (*.osm). If it is empty, the script
downloads the commute area from api.openstreetmap.org in 0.01° tiles.

The graph is contracted: only intersections, signals and restriction vias are
kept as nodes; the road shape between them is stored as polyline points.
"""
import argparse, glob, json, math, os, time, urllib.error, urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict

BBOX = (121.506, 24.992, 121.548, 25.054)  # W, S, E, N — Yonghe to Zhongshan with margin
LAT0, LON0 = 25.02, 121.52
KX, KY = 111320 * math.cos(math.radians(LAT0)), 110540
ROADS = ["primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link",
         "unclassified", "residential", "living_street", "service", "trunk", "trunk_link"]
CLS = {"primary": 0, "secondary": 1, "tertiary": 2, "unclassified": 3, "residential": 4,
       "living_street": 5, "service": 5, "primary_link": 6, "secondary_link": 6, "tertiary_link": 6,
       "trunk": 0, "trunk_link": 6}


def download(d):
    os.makedirs(d, exist_ok=True)
    W, S, E, N = BBOX
    y = S
    while y < N - 1e-9:
        x = W
        while x < E - 1e-9:
            fn = f"{d}/{x:.3f}_{y:.3f}.osm"
            if not os.path.exists(fn):
                url = f"https://api.openstreetmap.org/api/0.6/map?bbox={x:.4f},{y:.4f},{min(x + .01, E):.4f},{min(y + .01, N):.4f}"
                for i in range(4):
                    try:
                        req = urllib.request.Request(url, headers={"User-Agent": "super-speed-commuters/1.0"})
                        open(fn, "wb").write(urllib.request.urlopen(req, timeout=120).read())
                        break
                    except Exception as e:
                        print("retry", url, e); time.sleep(3 * (i + 1))
                time.sleep(.5)
            x += .01
        y += .01


import re
DAYS = {"Mo": 0, "Tu": 1, "We": 2, "Th": 3, "Fr": 4, "Sa": 5, "Su": 6}


def parse_conditional(v):
    """'no @ (Mo-Fr 07:00-09:00; Sa 10:00-12:00)' -> [(value, day_mask, start_min, end_min), ...]
    Public/school-holiday parts are ignored."""
    out = []
    for m in re.finditer(r"([A-Za-z]+|-1)\s*@\s*(\([^()]*\)|[^;()]+)", v or ""):
        val = m.group(1).lower()
        for part in m.group(2).strip("() ").split(";"):
            part = re.sub(r"\s*-\s*", "-", part.strip()).replace(": ", ":")
            if not part or part.startswith(("PH", "SH")):
                continue
            mask = 127
            dm = re.match(r"((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:,(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)\s+", part)
            if dm:
                mask = 0
                for rng in dm.group(1).split(","):
                    a, _, b = rng.partition("-")
                    a, b = DAYS[a], DAYS[b or a]
                    d = a
                    while True:
                        mask |= 1 << d
                        if d == b: break
                        d = (d + 1) % 7
                part = part[dm.end():]
            for tm in re.finditer(r"(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})", part):
                h1, m1, h2, m2 = map(int, tm.groups())
                out.append((val, mask, h1 * 60 + m1, h2 * 60 + m2))
    return out


BAD_NAME = re.compile(r"公車專用道|大客車專用道|計程車專用道|接客|洗車|停車場|地下道|椰林大道")


def allowed(t):
    """Can a 155 cc motorcycle (white plate) legally ride this way?"""
    h = t.get("highway")
    if h not in CLS:
        return False
    mc = t.get("motorcycle")
    mcc = t.get("motorcycle:conditional", "")
    if "cc" in mcc:                         # e.g. 'no @ <=250 cc' bans our 155 cc bike
        return False
    if mc in ("no", "private"):
        return False
    if mc in ("yes", "designated"):
        return True
    for k in ("access", "vehicle", "motor_vehicle"):
        if t.get(k) in ("no", "private", "permit", "destination", "customers", "delivery", "agricultural", "forestry"):
            return False
    if t.get("area") == "yes":
        return False
    if h in ("trunk", "trunk_link") or t.get("motorroad") == "yes":
        return False
    nm = t.get("name", "") + "|" + t.get("alt_name", "")
    if any(k in nm for k in ("高架", "快速", "匝道", "交流道")) or BAD_NAME.search(nm):
        return False
    if any(t.get(k) == "designated" for k in ("bus", "psv", "taxi")) and (t.get("motorcar") == "no" or t.get("motor_vehicle") == "no" or h == "service"):
        return False
    if t.get("motorcar") == "no" and t.get("bus") in ("yes", "designated"):
        return False
    if t.get("service") in ("parking_aisle", "driveway", "drive-through", "emergency_access", "driving_learning", "bus"):
        return False
    if h == "service" and t.get("tunnel") == "building_passage":
        return False
    # banned for (almost) the whole day, e.g. 'no @ (06:00-23:00)'
    for val, mask, a, b in parse_conditional(mcc):
        if val == "no" and (b - a) % 1440 >= 12 * 60:
            return False
    return True


def conditions(t):
    """Time-dependent rules for a way: closures and one-way changes.
    Returns [(kind, mask, start, end)]: kind 0 closed, 1 one-way forward, 2 one-way backward, 3 two-way."""
    rules = []
    for k in ("motorcycle:conditional", "motor_vehicle:conditional", "vehicle:conditional", "access:conditional"):
        for val, mask, a, b in parse_conditional(t.get(k)):
            if val in ("no", "private", "destination"):
                rules.append((0, mask, a, b))
    for val, mask, a, b in parse_conditional(t.get("oneway:conditional")):
        kind = {"yes": 1, "-1": 2, "no": 3}.get(val)
        if kind:
            rules.append((kind, mask, a, b))
    return rules


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tiles", required=True)
    ap.add_argument("--out", default="data/graph.json")
    a = ap.parse_args()
    if not glob.glob(a.tiles + "/*.osm"):
        download(a.tiles)
    nodes, ways, rels = {}, {}, {}
    for fn in sorted(glob.glob(a.tiles + "/*.osm")):
        for _, el in ET.iterparse(fn):
            if el.tag == "node":
                i = int(el.get("id"))
                if i not in nodes:
                    t = {c.get("k"): c.get("v") for c in el.findall("tag")}
                    sig = t.get("highway") == "traffic_signals" or t.get("crossing") == "traffic_signals"
                    nodes[i] = (float(el.get("lat")), float(el.get("lon")), sig)
                el.clear()
            elif el.tag == "way":
                i = int(el.get("id"))
                if i not in ways:
                    t = {c.get("k"): c.get("v") for c in el.findall("tag")}
                    if allowed(t):
                        ways[i] = ([int(n.get("ref")) for n in el.findall("nd")], t)
                el.clear()
            elif el.tag == "relation":
                i = int(el.get("id"))
                t = {c.get("k"): c.get("v") for c in el.findall("tag")}
                if t.get("type") == "restriction" and i not in rels:
                    rels[i] = ([(m.get("type"), int(m.get("ref")), m.get("role")) for m in el.findall("member")], t)
                el.clear()

    # which nodes must survive contraction
    use = defaultdict(int)
    for nd, t in ways.values():
        for k, n in enumerate(nd):
            use[n] += 1 if 0 < k < len(nd) - 1 else 2
    via = set()
    restr = []
    for mem, t in rels.values():
        r = t.get("restriction") or t.get("restriction:motorcycle")
        if not r or "motorcycle" in (t.get("except") or ""):
            continue
        fr = [m[1] for m in mem if m[2] == "from" and m[0] == "way"]
        vi = [m[1] for m in mem if m[2] == "via" and m[0] == "node"]
        to = [m[1] for m in mem if m[2] == "to" and m[0] == "way"]
        if fr and vi and to and fr[0] in ways and to[0] in ways:
            via.add(vi[0]); restr.append((fr[0], vi[0], to[0], 1 if r.startswith("only_") else 0))
    keep = lambda n: use[n] >= 2 or nodes[n][2] or n in via

    idx, xy, osm_ids = {}, [], []
    def nid(n):
        if n not in idx:
            la, lo, _ = nodes[n]
            idx[n] = len(osm_ids); osm_ids.append(n)
            xy.extend([round((lo - LON0) * KX), round((la - LAT0) * KY)])
        return idx[n]

    names, name_idx = [], {}
    def name_id(s):
        if s not in name_idx:
            name_idx[s] = len(names); names.append(s)
        return name_idx[s]

    edges, geom, edge_way, cond = [], [], [], []
    for wid, (nd, t) in ways.items():
        nd = [n for n in nd if n in nodes]
        if len(nd) < 2:
            continue
        ow = t.get("oneway")
        if t.get("oneway:motorcycle") == "no":
            ow = "no"
        rules = conditions(t)
        if ow == "-1":
            nd = nd[::-1]; ow = "yes"
            rules = [({1: 2, 2: 1}.get(k, k), m, s, e2) for k, m, s, e2 in rules]
        oneway = 1 if ow in ("yes", "true", "1") or t.get("junction") == "roundabout" else 0
        nm = name_id(t.get("name") or "")
        cls = CLS[t["highway"]]
        start, mid = nd[0], []
        for n in nd[1:]:
            if keep(n) or n == nd[-1]:
                g0 = len(geom) // 2
                for m in mid:
                    la, lo, _ = nodes[m]
                    geom.extend([round((lo - LON0) * KX), round((la - LAT0) * KY)])
                edges.append([nid(start), nid(n), nm, cls, oneway, g0, len(mid)])
                edge_way.append(wid)
                for k, m, s, e2 in rules:
                    cond.extend([len(edges) - 1, k, m, s, e2])
                start, mid = n, []
            else:
                mid.append(n)

    # resolve restrictions to edge pairs at the via node
    inc = defaultdict(list)
    for e, (u, v, *_r) in enumerate(edges):
        inc[u].append(e); inc[v].append(e)
    rs = []
    for fw, vn, tw, typ in restr:
        if vn not in idx:
            continue
        v = idx[vn]
        fe = [e for e in inc[v] if edge_way[e] == fw]
        te = [e for e in inc[v] if edge_way[e] == tw]
        for f in fe:
            for t2 in te:
                if f != t2:
                    rs.append([v, f, t2, typ])

    sig = [i for i, n in enumerate(osm_ids) if nodes[n][2]]
    out = {"v": 1, "built": time.strftime("%Y-%m-%d"), "source": "© OpenStreetMap contributors (ODbL)",
           "proj": {"lat0": LAT0, "lon0": LON0, "kx": KX, "ky": KY},
           "names": names, "xy": xy, "sig": sig, "sigOsm": [osm_ids[i] for i in sig],
           "edges": [x for e in edges for x in e], "geom": geom, "restr": [x for r in rs for x in r], "cond": cond}
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    json.dump(out, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"nodes {len(osm_ids)} edges {len(edges)} geom pts {len(geom)//2} signals {len(sig)} restrictions {len(rs)} timed rules {len(cond)//5} size {os.path.getsize(a.out)//1024} KB")


if __name__ == "__main__":
    main()
