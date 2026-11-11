#!/usr/bin/env node
/* Map Taipei traffic-control road sections (GetVD.xml.gz, free, no key) onto
   directed edges of data/graph.json, so the app can apply live speeds.

   Usage: node tools/build_vd_map.js [path/to/GetVD.xml.gz]
   Without a path it downloads the current feed. Writes data/vd_map.json. */
"use strict";
const fs = require("fs"), path = require("path"), zlib = require("zlib"), https = require("https");
const ROOT = path.join(__dirname, "..");
global.window = global;
global.fetch = async u => ({ json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, u))) });
require(path.join(ROOT, "js/graph.js"));
const FEED = "https://tcgbusfs.blob.core.windows.net/blobtisv/GetVD.xml.gz";

function get(url) { return new Promise((res, rej) => https.get(url, r => { const b = []; r.on("data", c => b.push(c)); r.on("end", () => res(Buffer.concat(b))); }).on("error", rej)); }
function parse(xml) {
  const out = [];
  for (const m of xml.matchAll(/<vd:SectionData>([\s\S]*?)<\/vd:SectionData>/g)) {
    const g = t => { const x = m[1].match(new RegExp(`<vd:${t}>(.*?)</vd:${t}>`)); return x ? x[1] : null; };
    out.push({ id: g("SectionId"), name: g("SectionName"), sx: +g("StartWgsX"), sy: +g("StartWgsY"), ex: +g("EndWgsX"), ey: +g("EndWgsY") });
  }
  return out;
}

/* follow the same road onward and backward from a section, up to `max` metres each way */
function extend(path, max) {
  const G = Graph.G, out = [], have = new Set(path);
  const nm = de => Graph.shortName(Graph.nameOf(Graph.deE(de)));
  const pts = de => Graph.edgePtsLL(de);
  const bearing = (de, end) => { const p = pts(de); const a = end ? p[p.length - 2] : p[0], b = end ? p[p.length - 1] : p[1]; return Math.atan2(b[1] - a[1], b[0] - a[0]); };
  const close = (a, b) => { let d = Math.abs(a - b) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d; return d < .5; };
  const name = nm(path[0]);
  // forward
  let cur = path[path.length - 1], len = 0;
  while (len < max) {
    const n = Graph.deTo(cur);
    const nx = G.out[n].find(d => !have.has(d) && Graph.deE(d) !== Graph.deE(cur) && nm(d) === name && close(bearing(d, false), bearing(cur, true)));
    if (nx == null) break;
    out.push(nx); have.add(nx); len += G.len[Graph.deE(nx)]; cur = nx;
  }
  // backward
  cur = path[0]; len = 0;
  while (len < max) {
    const n = Graph.deFrom(cur);
    let pv = null;
    for (const e of G.inc[n]) for (const d of [2 * e, 2 * e + 1]) {
      if (have.has(d) || e === Graph.deE(cur) || Graph.deTo(d) !== n) continue;
      if ((d & 1) && G.eow[e]) continue;
      if (nm(d) === name && close(bearing(d, true), bearing(cur, false))) pv = d;
    }
    if (pv == null) break;
    out.push(pv); have.add(pv); len += G.len[Graph.deE(pv)]; cur = pv;
  }
  return out;
}

(async () => {
  const buf = process.argv[2] ? fs.readFileSync(process.argv[2]) : await get(FEED);
  const secs = parse(zlib.gunzipSync(buf).toString("utf8"));
  const G = await Graph.load("data/graph.json");
  const W = 121.506, E = 121.548, S = 24.992, N = 25.054;
  const map = {};
  let tried = 0, ok = 0;
  for (const s of secs) {
    if (![s.sx, s.ex].every(x => x >= W && x <= E) || ![s.sy, s.ey].every(y => y >= S && y <= N)) continue;
    if (/快|高架|高 |地下道|匝道|市高|新生高/.test(s.name)) continue;
    tried++;
    const a = Graph.toXY(s.sy, s.sx), b = Graph.toXY(s.ey, s.ex);
    const straight = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (straight < 40) continue;
    const hd = Math.atan2(b[0] - a[0], b[1] - a[1]);
    const r = Graph.route({ x: a[0], y: a[1], heading: hd }, { x: b[0], y: b[1] }, {});
    if (!r || r.distance > straight * 1.5 + 120) continue;
    const road = s.name.trim().split(/\s+/)[0].replace(/[一二三四五六七八九]段$/, "").replace(/\(.*\)|（.*）/g, "");
    let match = 0, total = 0;
    for (const e of r.edges) { const L = e.to - e.from; total += L; const nm = Graph.nameOf(Graph.deE(e.de)); if (nm && (nm.includes(road) || road.includes(Graph.shortName(nm)))) match += L; }
    if (!total || match / total < .6) continue;
    const de = r.edges.filter(e => e.to - e.from > 5).map(e => e.de);
    map[s.id] = { n: s.name.replace(/\s+/g, " ").trim(), de, x: extend(de, 300) };
    ok++;
  }
  fs.writeFileSync(path.join(ROOT, "data/vd_map.json"), JSON.stringify({ v: 1, built: new Date().toISOString().slice(0, 10), source: FEED, sections: map }));
  console.log(`sections in area ${tried}, mapped ${ok}`);
})();
