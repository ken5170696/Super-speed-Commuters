/* Road graph, on-phone routing (A* over directed edges with turn restrictions),
   map matching and route description (signals, turns, road names). */
(function (global) {
"use strict";

const G = { ready: false };
let P;
const SPEED_KMH = [42, 40, 34, 25, 20, 15, 30];   // default moving speed by road class
const SIG_COST = 14;                                // routing penalty per signal (s)

/* ---------- loading ---------- */
async function load(url) {
  const j = await (await fetch(url)).json();
  P = j.proj; G.proj = P; G.names = j.names;
  G.xy = Int32Array.from(j.xy); G.N = G.xy.length / 2;
  const E = j.edges, M = E.length / 7; G.M = M;
  G.eu = new Int32Array(M); G.ev = new Int32Array(M); G.ename = new Int32Array(M); G.ecls = new Uint8Array(M);
  G.eow = new Uint8Array(M); G.eg0 = new Int32Array(M); G.egn = new Int32Array(M); G.len = new Float32Array(M);
  G.gx = Int32Array.from(j.geom);
  G.pc = null;
  G.out = Array.from({ length: G.N }, () => []);
  G.inc = Array.from({ length: G.N }, () => []);
  for (let e = 0; e < M; e++) {
    const o = e * 7;
    G.eu[e] = E[o]; G.ev[e] = E[o + 1]; G.ename[e] = E[o + 2]; G.ecls[e] = E[o + 3]; G.eow[e] = E[o + 4]; G.eg0[e] = E[o + 5]; G.egn[e] = E[o + 6];
    const p = edgePts(e); let L = 0; for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    G.len[e] = Math.max(L, .5);
    G.out[G.eu[e]].push(2 * e); if (!G.eow[e]) G.out[G.ev[e]].push(2 * e + 1);
    G.inc[G.eu[e]].push(e); G.inc[G.ev[e]].push(e);
  }
  G.pc = new Array(M); for (let e = 0; e < M; e++) G.pc[e] = edgePts(e);
  G.isSig = new Uint8Array(G.N); G.sigOsm = new Map(); G.osmNode = new Map();
  j.sig.forEach((n, i) => { G.isSig[n] = 1; G.sigOsm.set(n, j.sigOsm[i]); G.osmNode.set(j.sigOsm[i], n); });
  // time-dependent rules: closures and peak-hour one-way changes
  G.cond = new Map(); G.block = new Uint8Array(M); G.skip = new Float32Array(2 * M);
  const C = j.cond || [];
  for (let i = 0; i < C.length; i += 5) {
    const e = C[i], r = [C[i + 1], C[i + 2], C[i + 3], C[i + 4]];
    (G.cond.get(e) || G.cond.set(e, []).get(e)).push(r);
    if (r[0] === 3 && G.eow[e] && !G.out[G.ev[e]].includes(2 * e + 1)) G.out[G.ev[e]].push(2 * e + 1);
  }
  // signal clusters: signal nodes joined by short edges (<45 m) form one intersection; id = smallest OSM id
  G.sigCluster = new Map();
  for (const n of j.sig) {
    if (G.sigCluster.has(n)) continue;
    const comp = [n], seen = new Set([n]);
    for (let q = 0; q < comp.length; q++) for (const e of G.inc[comp[q]]) {
      if (G.len[e] > 45) continue;
      const m = G.eu[e] === comp[q] ? G.ev[e] : G.eu[e];
      if (G.isSig[m] && !seen.has(m)) { seen.add(m); comp.push(m); }
    }
    const id = "n" + Math.min(...comp.map(x => G.sigOsm.get(x)));
    for (const m of comp) G.sigCluster.set(m, id);
  }
  G.ban = new Map(); G.only = new Map();
  const R = j.restr;
  for (let i = 0; i < R.length; i += 4) {
    const via = R[i], f = R[i + 1], t = R[i + 2], typ = R[i + 3], k = f * 1e6 + via;
    if (typ) { (G.only.get(k) || G.only.set(k, new Set()).get(k)).add(t); }
    else { (G.ban.get(k) || G.ban.set(k, new Set()).get(k)).add(t); }
  }
  // spatial grid of edge segments (150 m cells)
  G.cell = 150; G.grid = new Map();
  for (let e = 0; e < M; e++) {
    const p = edgePts(e);
    for (let i = 0; i < p.length - 1; i++) {
      const x0 = Math.min(p[i][0], p[i + 1][0]), x1 = Math.max(p[i][0], p[i + 1][0]), y0 = Math.min(p[i][1], p[i + 1][1]), y1 = Math.max(p[i][1], p[i + 1][1]);
      for (let cx = Math.floor(x0 / G.cell); cx <= Math.floor(x1 / G.cell); cx++) for (let cy = Math.floor(y0 / G.cell); cy <= Math.floor(y1 / G.cell); cy++) {
        const k = cx * 100003 + cy; let a = G.grid.get(k); if (!a) G.grid.set(k, a = []); a.push(e, i);
      }
    }
  }
  G.habit = new Float32Array(2 * M);   // times the rider used each directed edge
  G.vLearn = new Float32Array(2 * M);  // learned moving speed (m/s) per directed edge
  G.vLive = new Float32Array(2 * M);   // live road speed (km/h) from Taipei traffic control, 0 = none
  G.moe = new Int8Array(2 * M).fill(-1); // live congestion level: 0 smooth, 1 busy, 2 congested
  G.ready = true;
  return G;
}

/* ---------- geometry helpers ---------- */
const toXY = (lat, lon) => [(lon - P.lon0) * P.kx, (lat - P.lat0) * P.ky];
const toLL = (x, y) => [P.lat0 + y / P.ky, P.lon0 + x / P.kx];
const nxy = n => [G.xy[2 * n], G.xy[2 * n + 1]];
function edgePts(e) {
  if (G.pc && G.pc[e]) return G.pc[e];
  const p = [nxy(G.eu[e])];
  for (let k = 0; k < G.egn[e]; k++) p.push([G.gx[2 * (G.eg0[e] + k)], G.gx[2 * (G.eg0[e] + k) + 1]]);
  p.push(nxy(G.ev[e])); return p;
}
const deE = de => de >> 1, deDir = de => de & 1;
const deFrom = de => deDir(de) ? G.ev[deE(de)] : G.eu[deE(de)];
const deTo = de => deDir(de) ? G.eu[deE(de)] : G.ev[deE(de)];
function dePts(de) { const p = edgePts(deE(de)); return deDir(de) ? p.slice().reverse() : p; }
const bearing = (a, b) => Math.atan2(b[0] - a[0], b[1] - a[1]);
const angDiff = (a, b) => { let d = (a - b) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d; };
function deBearIn(de) { const p = dePts(de); return bearing(p[p.length - 2], p[p.length - 1]); }
function deBearOut(de) { const p = dePts(de); return bearing(p[0], p[1]); }
const nameOf = e => G.names[G.ename[e]] || "";
const shortName = s => (s || "").replace(/[一二三四五六七八九]段$/, "");

/* nearest directed edges to a point; heading in radians (optional) */
function nearEdges(x, y, maxD, heading) {
  const out = new Map();
  const cx = Math.floor(x / G.cell), cy = Math.floor(y / G.cell);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const a = G.grid.get((cx + dx) * 100003 + cy + dy); if (!a) continue;
    for (let i = 0; i < a.length; i += 2) {
      const e = a[i], s = a[i + 1], p = edgePts(e), A = p[s], B = p[s + 1];
      const vx = B[0] - A[0], vy = B[1] - A[1], L2 = vx * vx + vy * vy || 1e-9;
      let u = ((x - A[0]) * vx + (y - A[1]) * vy) / L2; u = Math.max(0, Math.min(1, u));
      const d = Math.hypot(A[0] + u * vx - x, A[1] + u * vy - y);
      if (d > maxD) continue;
      // distance along edge (u->v) to the projected point
      let along = 0; for (let k = 0; k < s; k++) along += Math.hypot(p[k + 1][0] - p[k][0], p[k + 1][1] - p[k][1]);
      along += u * Math.sqrt(L2);
      const segB = Math.atan2(vx, vy);
      for (const dir of [0, 1]) {
        if (dir && G.eow[e]) continue;
        const de = 2 * e + dir, b = dir ? segB + Math.PI : segB;
        if (heading != null && Math.abs(angDiff(b, heading)) > 1.2) continue;
        const f = dir ? 1 - along / G.len[e] : along / G.len[e];
        const prev = out.get(de); if (!prev || d < prev.d) out.set(de, { de, d, f: Math.max(0, Math.min(1, f)) });
      }
    }
  }
  return [...out.values()].sort((a, b) => a.d - b.d);
}

/* ---------- time-dependent access ---------- */
function timeCtx(d) { d = d || new Date(); return { wd: (d.getDay() + 6) % 7, min: d.getHours() * 60 + d.getMinutes() }; }
const inWin = (T, r) => (r[1] >> T.wd) & 1 && (r[2] <= r[3] ? T.min >= r[2] && T.min < r[3] : T.min >= r[2] || T.min < r[3]);
function edgeOpen(de, T) {
  const e = deE(de), dir = deDir(de);
  if (G.block[e]) return false;
  const rules = G.cond.get(e);
  if (!rules) return !(dir && G.eow[e]);
  let two = false;
  for (const r of rules) {
    if (!inWin(T, r)) continue;
    if (r[0] === 0) return false;
    if (r[0] === 1 && dir) return false;
    if (r[0] === 2 && !dir) return false;
    if (r[0] === 3) two = true;
  }
  return !(dir && G.eow[e]) || two;
}

/* ---------- cost model ---------- */
function vOf(de) {
  const base = G.vLearn[de] > 1 ? G.vLearn[de] : SPEED_KMH[G.ecls[deE(de)]] / 3.6;
  const live = G.vLive[de];
  // live detector speed relative to a typical free-flowing arterial (~45 km/h)
  return live > 0 ? base * Math.max(.4, Math.min(1.1, live / 45)) : base;
}
function setLive(sections, vdMap) {
  G.vLive.fill(0); G.moe.fill(-1);
  let n = 0;
  for (const s of sections) {
    const m = vdMap[s.id]; if (!m || !(s.spd > 0) || s.moe < 0) continue;
    for (const de of m.de) { G.vLive[de] = s.spd; G.moe[de] = s.moe; }
    n++;
  }
  // extend each detector's reading along the same road where nothing closer was measured
  for (const s of sections) {
    const m = vdMap[s.id]; if (!m || !m.x || !(s.spd > 0) || s.moe < 0) continue;
    for (const de of m.x) if (!(G.vLive[de] > 0)) { G.vLive[de] = s.spd; G.moe[de] = s.moe; }
  }
  return n;
}
function edgeCost(de, habitW) {
  let t = G.len[deE(de)] / vOf(de);
  if (G.skip[de] > 0) t *= 1 + Math.min(4, G.skip[de] * 1.5);   // roads you keep refusing to take
  if (!habitW) return t;
  const h = G.habit[de];
  return t * (h >= 2 ? 1 - .5 * habitW : h >= 1 ? 1 - .3 * habitW : 1);
}
function turnCost(a, b) {
  const t = angDiff(deBearOut(b), deBearIn(a));
  if (Math.abs(t) > 2.6) return 120;   // U-turn
  if (t < -.6) return 10;              // left
  if (t > .6) return 4;                // right
  return 0;
}
function allowedTurn(a, via, b) {
  const k = deE(a) * 1e6 + via;
  const o = G.only.get(k); if (o && !o.has(deE(b))) return false;
  const n = G.ban.get(k); if (n && n.has(deE(b))) return false;
  return true;
}

/* ---------- heap ---------- */
class Heap {
  constructor() { this.k = []; this.v = []; }
  push(key, val) { const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val); while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; } k[i] = key; v[i] = val; }
  pop() { const k = this.k, v = this.v, top = v[0], topk = k[0], lk = k.pop(), lv = v.pop(); if (k.length) { let i = 0; const n = k.length; while (true) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; } k[i] = lk; v[i] = lv; } this.lastKey = topk; return top; }
  get size() { return this.k.length; }
}

/* ---------- routing ----------
   from: {x,y,heading?}  to: {x,y}  opts: {via: road name, habit: 0..1}
   returns route object or null */
function route(from, to, opts = {}) {
  const habitW = opts.habit || 0, via = opts.via || null, T = timeCtx(opts.time);
  let starts = nearEdges(from.x, from.y, 60, from.heading).filter(s => edgeOpen(s.de, T));
  if (!starts.length) starts = nearEdges(from.x, from.y, 150, null).filter(s => edgeOpen(s.de, T));
  if (!starts.length) return null;
  starts = starts.slice(0, 6);
  const goals = nearEdges(to.x, to.y, 150, null).filter(g => edgeOpen(g.de, T)).slice(0, 4);
  if (!goals.length) return null;
  const S = via ? 2 : 1, viaId = via ? G.names.indexOf(via) : -1;
  const NS = 2 * G.M * S;
  const dist = new Float64Array(NS).fill(Infinity), prev = new Int32Array(NS).fill(-2);
  const h = new Heap();
  const vmax = 15;
  const hEst = n => Math.hypot(G.xy[2 * n] - to.x, G.xy[2 * n + 1] - to.y) / vmax;
  const startF = new Map();
  for (const s of starts) {
    const st = via && G.ename[deE(s.de)] === viaId ? 1 : 0;
    const id = s.de * S + st, c = (1 - s.f) * edgeCost(s.de, habitW) + s.d * .5;
    if (c < dist[id]) { dist[id] = c; prev[id] = -1; startF.set(s.de, s.f); h.push(c + hEst(deTo(s.de)), id); }
  }
  // goal directed edges: arrive at their start node, then go partially along
  const goalBy = new Map();
  for (const g of goals) { const arr = goalBy.get(deFrom(g.de)) || []; arr.push(g); goalBy.set(deFrom(g.de), arr); }
  let best = Infinity, bestId = -1, bestGoal = null, pops = 0;
  // start and goal on the same directed edge, ahead of us
  for (const s of starts) for (const g of goals) if (s.de === g.de && g.f >= s.f && (!via)) {
    const c = (g.f - s.f) * edgeCost(s.de, habitW);
    if (c < best) { best = c; bestId = -10; bestGoal = { g, s }; }
  }
  while (h.size) {
    const id = h.pop(); const key = h.lastKey;
    if (key >= best) break;
    if (++pops > 400000) break;
    const de = Math.floor(id / S), st = id % S, c = dist[id];
    const n = deTo(de);
    if (st === S - 1 || !via) {
      const gs = goalBy.get(n);
      if (gs) for (const g of gs) {
        if (deE(g.de) === deE(de) && g.de !== de) continue;
        if (!allowedTurn(de, n, g.de)) continue;
        const tot = c + turnCost(de, g.de) + g.f * edgeCost(g.de, habitW) + g.d * .5;
        if (tot < best) { best = tot; bestId = id; bestGoal = { g }; }
      }
    }
    for (const de2 of G.out[n]) {
      if (deE(de2) === deE(de) && G.out[n].length > 1) continue;
      if (!edgeOpen(de2, T)) continue;
      if (!allowedTurn(de, n, de2)) continue;
      const st2 = st === 0 && via && G.ename[deE(de2)] === viaId ? 1 : st;
      const c2 = c + edgeCost(de2, habitW) + turnCost(de, de2) + (G.isSig[deTo(de2)] ? SIG_COST : 0);
      const id2 = de2 * S + st2;
      if (c2 < dist[id2]) { dist[id2] = c2; prev[id2] = id; h.push(c2 + hEst(deTo(de2)), id2); }
    }
  }
  if (bestId === -1) return null;
  let path, f0, f1;
  if (bestId === -10) { path = [bestGoal.s.de]; f0 = bestGoal.s.f; f1 = bestGoal.g.f; }
  else {
    path = []; let id = bestId;
    while (id >= 0) { path.push(Math.floor(id / S)); id = prev[id]; }
    path.reverse();
    f0 = startF.get(path[0]) || 0;
    path.push(bestGoal.g.de); f1 = bestGoal.g.f;
  }
  return describe(path, f0, f1, opts);
}

/* ---------- route description ---------- */
function partialPts(pts, a, b) {
  // sub-polyline from fraction a to b of a polyline
  let L = 0; const cum = [0];
  for (let i = 1; i < pts.length; i++) { L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); cum.push(L); }
  const at = f => { const t = f * L; for (let i = 1; i < pts.length; i++) if (cum[i] >= t) { const u = (t - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1); return [pts[i - 1][0] + u * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + u * (pts[i][1] - pts[i - 1][1])]; } return pts[pts.length - 1]; };
  const out = [at(a)];
  for (let i = 1; i < pts.length - 1; i++) if (cum[i] > a * L && cum[i] < b * L) out.push(pts[i]);
  out.push(at(b)); return out;
}
function describe(path, f0, f1, opts) {
  const geom = [], edges = [], nodes = [];
  let d = 0;
  path.forEach((de, i) => {
    let pts = dePts(de);
    const a = i === 0 ? f0 : 0, b = i === path.length - 1 ? f1 : 1;
    if (a > 0 || b < 1) pts = partialPts(pts, a, b);
    const d0 = d;
    pts.forEach((p, k) => {
      if (geom.length && k === 0) return;
      if (geom.length) d += Math.hypot(p[0] - geom[geom.length - 1][0], p[1] - geom[geom.length - 1][1]);
      geom.push([p[0], p[1], d]);
    });
    edges.push({ de, from: d0, to: d });
    if (i < path.length - 1) nodes.push({ n: deTo(de), d, inDe: de, outDe: path[i + 1] });
  });
  // road segments by name
  const segs = [];
  for (const e of edges) {
    const nm = shortName(nameOf(deE(e.de))) || "無名道路";
    if (segs.length && segs[segs.length - 1].name === nm) segs[segs.length - 1].to = e.to; else segs.push({ name: nm, from: e.from, to: e.to });
  }
  // turns
  const turns = [];
  for (const nd of nodes) {
    const t = angDiff(deBearOut(nd.outDe), deBearIn(nd.inDe));
    const onto = shortName(nameOf(deE(nd.outDe))) || "無名道路";
    const fromName = shortName(nameOf(deE(nd.inDe)));
    if (onto === fromName && Math.abs(t) < 1.25) continue;   // bends and jogs along the same road are not turns
    if (Math.abs(t) >= .6) turns.push({ d: nd.d, dir: Math.abs(t) > 2.6 ? "U" : t < 0 ? "L" : "R", onto, angle: t });
    else if (Math.abs(t) >= .3 && onto !== fromName && G.out[nd.n].length > 2) turns.push({ d: nd.d, dir: t < 0 ? "SL" : "SR", onto, angle: t });
  }
  // signals (cluster consecutive signal nodes within 40 m)
  const signals = [];
  for (const nd of nodes) {
    if (!G.isSig[nd.n]) continue;
    const last = signals[signals.length - 1];
    if (last && nd.d - last.d0 <= 40) { last.nodes.push(nd.n); last.d = (last.d0 + nd.d) / 2; continue; }
    signals.push({ d0: nd.d, d: nd.d, nodes: [nd.n], de: nd.inDe });
  }
  for (const s of signals) {
    s.id = G.sigCluster.get(s.nodes[0]);
    const nm = sigName(s.nodes, shortName(nameOf(deE(s.de))));
    s.kind = nm.cross ? "junction" : "crossing";
    s.major = G.ecls[deE(s.de)] <= 1;
    s.name = nm.name;
    const p = nxy(s.nodes[0]); s.x = p[0]; s.y = p[1];
    delete s.d0;
  }
  const r = { geom, edges, segs, turns, signals, distance: d, path, label: labelOf(segs), via: opts.via || null };
  r.baseSec = timeAlong(r, 0, d) + signals.reduce((a, s) => a + priorDelay(s), 0);
  return r;
}
function sigName(nodes, road) {
  const names = [];
  for (const n of nodes) for (const e of G.inc[n]) { const nm = shortName(nameOf(e)); if (nm && !names.includes(nm) && !nm.includes("專用道")) names.push(nm); }
  names.sort((a, b) => (/[巷弄]/.test(a) ? 1 : 0) - (/[巷弄]/.test(b) ? 1 : 0));
  road = road || names[0] || "無名道路";
  const cross = names.filter(x => x !== road);
  return { name: road + (cross.length ? " × " + cross.slice(0, 2).join("、") : "（行人號誌）"), cross: cross.length };
}
function sigNameById(id) {
  const osm = +String(id).slice(1); const n = G.osmNode.get(osm);
  if (n == null) return "號誌 " + id;
  const nodes = [...G.sigCluster.entries()].filter(([, v]) => v === id).map(([k]) => k);
  return sigName(nodes.length ? nodes : [n], null).name;
}
function sigNodeXY(id) { const n = G.osmNode.get(+String(id).slice(1)); return n == null ? null : nxy(n); }
/* nearest signal cluster to a point, within maxD metres */
function nearestSignal(x, y, maxD) {
  let best = null;
  const cx = Math.floor(x / G.cell), cy = Math.floor(y / G.cell);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const a = G.grid.get((cx + dx) * 100003 + cy + dy); if (!a) continue;
    for (let i = 0; i < a.length; i += 2) for (const n of [G.eu[a[i]], G.ev[a[i]]]) {
      if (!G.isSig[n]) continue;
      const d = Math.hypot(G.xy[2 * n] - x, G.xy[2 * n + 1] - y);
      if (d <= maxD && (!best || d < best.d)) best = { n, d, id: G.sigCluster.get(n) };
    }
  }
  return best;
}
function labelOf(segs) {
  const majors = [];
  for (const s of segs) if (s.to - s.from > 350 && !/[巷弄]/.test(s.name) && s.name !== "無名道路" && majors[majors.length - 1] !== s.name) majors.push(s.name);
  return majors.slice(0, 5).join(" → ") || "（短程）";
}
function priorDelay(s) { if (s.kind === "crossing") return 5; return s.major ? 14 : 20; }
function timeAlong(r, d0, d1) {
  let t = 0;
  for (const e of r.edges) { const a = Math.max(d0, e.from), b = Math.min(d1, e.to); if (b > a) t += (b - a) / vOf(e.de); }
  return t;
}
/* project a point onto a route polyline */
function project(r, p) {
  let best = { dist: 1e18, d: 0 };
  const g = r.geom;
  for (let i = 0; i < g.length - 1; i++) {
    const a = g[i], b = g[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9;
    let u = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2; u = Math.max(0, Math.min(1, u));
    const dist = Math.hypot(a[0] + u * dx - p[0], a[1] + u * dy - p[1]);
    if (dist < best.dist) best = { dist, d: a[2] + u * (b[2] - a[2]) };
  }
  return best;
}

/* ---------- map matching for recorded tracks ----------
   pts: [[t, lat, lon, v, ...]]  -> per point {de|-1, xy} */
function matchTrack(pts) {
  const out = new Array(pts.length);
  let prevDe = -1;
  for (let i = 0; i < pts.length; i++) {
    const xy = toXY(pts[i][1], pts[i][2]);
    let hd = null;
    const a = pts[Math.max(0, i - 2)], b = pts[Math.min(pts.length - 1, i + 2)];
    const A = toXY(a[1], a[2]), B = toXY(b[1], b[2]);
    if (Math.hypot(B[0] - A[0], B[1] - A[1]) > 6) hd = bearing(A, B);
    const c = nearEdges(xy[0], xy[1], 30, hd);
    let pick = c[0];
    if (prevDe >= 0) { const same = c.find(x => x.de === prevDe || deFrom(x.de) === deTo(prevDe)); if (same && same.d < (pick ? pick.d + 8 : 99)) pick = same; }
    out[i] = { xy, de: pick ? pick.de : -1, d: pick ? pick.d : null };
    if (pick) prevDe = pick.de;
  }
  return out;
}

global.Graph = { G, load, route, project, matchTrack, toXY, toLL, nameOf, shortName, deE, deTo, deFrom, timeAlong, priorDelay, vOf, nearEdges, SPEED_KMH, sigNameById, sigNodeXY, nearestSignal, setLive, edgeOpen, timeCtx, edgeKey: e => [G.eu[e], G.ev[e]].map(n => G.xy[2 * n] + "," + G.xy[2 * n + 1]).join("|"), edgePtsLL: de => dePts(de).map(p => toLL(p[0], p[1])) };
})(window);
