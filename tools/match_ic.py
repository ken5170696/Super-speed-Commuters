"""Shared helpers: match Taipei signal-control intersection names to graph nodes."""
import re, math, collections


def norm(s):
    s = s.replace("　", "").replace(" ", "").replace("臺", "台")
    s = re.sub(r"([^路街道])([一二三四五六七八九])段", r"\1路\2段", s)   # 建國南二段 -> 建國南路二段
    return s


def base(s):
    return re.sub(r"[一二三四五六七八九]段$", "", s)


def split_ic(name):
    parts = [p for p in re.split(r"　+|\s{2,}", name) if p.strip()]
    parts = [norm(p) for p in parts]
    if len(parts) >= 2:
        a, b = parts[0], parts[1]
        b = re.sub(r"^(\d+)[,，、]\d+", r"\1", b)          # 122,213巷 -> 122巷
        if re.match(r"^\d+(巷|弄)$", b):                    # lane of the first road
            b = a + b
        return a, b
    return None


class Matcher:
    def __init__(self, g):
        names, xy, E = g["names"], g["xy"], g["edges"]
        self.xy, self.sig = xy, set(g["sig"])
        node_names = collections.defaultdict(set)
        for e in range(len(E) // 7):
            nm = names[E[e * 7 + 2]]
            if nm:
                node_names[E[e * 7]].add(nm); node_names[E[e * 7 + 1]].add(nm)
        self.full, self.base = collections.defaultdict(set), collections.defaultdict(set)
        for n, ss in node_names.items():
            for s in ss:
                self.full[norm(s)].add(n); self.base[base(norm(s))].add(n)

    def nodes(self, road):
        return self.full.get(road) or self.base.get(base(road)) or set()

    def locate(self, icname):
        ab = split_ic(icname)
        if not ab:
            return None
        cand = self.nodes(ab[0]) & self.nodes(ab[1])
        if not cand:
            return None
        sc = [n for n in cand if n in self.sig] or list(cand)
        pts = [(self.xy[2 * n], self.xy[2 * n + 1]) for n in sc]
        cx = sum(p[0] for p in pts) / len(pts); cy = sum(p[1] for p in pts) / len(pts)
        if max(math.hypot(p[0] - cx, p[1] - cy) for p in pts) > 120:
            return None
        return cx, cy, [n for n in sc if n in self.sig]
