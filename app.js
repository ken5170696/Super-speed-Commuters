/* 綠波通勤 — live map navigation that follows the road you actually take,
   learns your habits, signal cycles and speeds from your own GPS tracks.
   Everything personal stays on this phone (localStorage + IndexedDB). */
(function () {
"use strict";
const { G } = Graph;
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pad = n => String(n).padStart(2, "0");
const mod = (a, n) => ((a % n) + n) % n;
const DIRNAME = { am: "上班", pm: "下班" };
const ROUTE_COLORS = ["#3d8cf0", "#f07a3d", "#22b07d", "#c9a400", "#b05cd6"];

/* ---------------- storage ---------------- */
const K = "ssc.";
function load(k, d) { try { const v = localStorage.getItem(K + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function save(k, v) { try { localStorage.setItem(K + k, JSON.stringify(v)); return true; } catch (e) { toast("手機儲存空間不足，請到「紀錄」匯出後刪除舊紀錄"); return false; } }
const DB = {
  db: null, mem: new Map(),
  open() { return new Promise(res => { try { const r = indexedDB.open("ssc", 1); r.onupgradeneeded = () => r.result.createObjectStore("tracks", { keyPath: "id" }); r.onsuccess = () => { this.db = r.result; res(); }; r.onerror = () => res(); } catch (e) { res(); } }); },
  tx(mode) { return this.db.transaction("tracks", mode).objectStore("tracks"); },
  put(o) { if (!this.db) { this.mem.set(o.id, o); return Promise.resolve(); } return new Promise(res => { const r = this.tx("readwrite").put(o); r.onsuccess = r.onerror = () => res(); }); },
  get(id) { if (!this.db) return Promise.resolve(this.mem.get(id)); return new Promise(res => { const r = this.tx("readonly").get(id); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }); },
  all() { if (!this.db) return Promise.resolve([...this.mem.values()]); return new Promise(res => { const r = this.tx("readonly").getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); }); },
  del(id) { if (!this.db) { this.mem.delete(id); return Promise.resolve(); } return new Promise(res => { const r = this.tx("readwrite").delete(id); r.onsuccess = r.onerror = () => res(); }); },
  clear() { if (!this.db) { this.mem.clear(); return Promise.resolve(); } return new Promise(res => { const r = this.tx("readwrite").clear(); r.onsuccess = r.onerror = () => res(); }); },
};
const S = {
  settings: Object.assign({ voice: true, motion: true, auto: true, deadline: "09:00", home: null, office: null }, load("settings", {})),
  trips: load("trips", []),
  sig: load("signals", {}),
  dir: new Date().getHours() < 13 ? "am" : "pm",
  plan: { am: null, pm: null }, sel: { am: 0, pm: 0 },
  sigPeriod: new Date().getHours() < 13 ? "am" : "pm",
  passes: {}, learned: 0,
};
function saveSettings() { save("settings", S.settings); }
function saveTrips() { save("trips", S.trips); }

/* ---------------- live traffic (Taipei traffic control centre, free, no key) ---------------- */
const LIVE_URL = "https://tcgbusfs.blob.core.windows.net/blobtisv/GetVD.xml.gz";
const LIVE = { map: null, deSec: new Map(), at: null, n: 0, err: null, secs: [], hist: load("liveHist", {}), histSaved: 0 };
async function loadLive() {
  try {
    if (!LIVE.map) {
      LIVE.map = (await (await fetch("data/vd_map.json")).json()).sections;
      for (const [sid, m] of Object.entries(LIVE.map)) for (const de of m.de) LIVE.deSec.set(de, sid);
    }
    if (!("DecompressionStream" in window)) throw new Error("nodecomp");
    const res = await fetch(LIVE_URL + "?t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error("http " + res.status);
    const txt = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).text();
    const at = (txt.match(/<vd:ExchangeTime>(.*?)<\/vd:ExchangeTime>/) || [])[1];
    const secs = [];
    for (const m of txt.matchAll(/<vd:SectionData>([\s\S]*?)<\/vd:SectionData>/g)) {
      const s = m[1], g = k => { const x = s.match(new RegExp("<vd:" + k + ">(.*?)</vd:" + k + ">")); return x ? x[1] : null; };
      const id = g("SectionId"); if (!LIVE.map[id]) continue;
      secs.push({ id, spd: +g("AvgSpd"), moe: +g("MOELevel") });
    }
    LIVE.n = Graph.setLive(secs, LIVE.map); LIVE.secs = secs; LIVE.err = null;
    LIVE.at = at ? new Date(at.replace(/\//g, "-")).getTime() : Date.now();
    recordHist(secs);
  } catch (e) { LIVE.err = e.message === "nodecomp" ? "這支手機的瀏覽器版本太舊，讀不了即時路況" : "即時路況暫時讀不到"; }
  onLive();
}
const slotOf = (d = new Date()) => Math.floor(tod(d) / 600);
function recordHist(secs) {
  // remember each section's speed per 10-minute slot on weekdays, to know what "usual" is
  const d = new Date(); if (d.getDay() === 0 || d.getDay() === 6) return;
  const slot = slotOf(d), day = dateStr(d), H = LIVE.hist;
  H._seen = H._seen || {};
  if (H._seen[slot] === day) return;
  H._seen[slot] = day;
  for (const s of secs) {
    if (!(s.spd > 0)) continue;
    const h = H[s.id] || (H[s.id] = {}); const v = h[slot];
    h[slot] = v ? [+(v[0] * .75 + s.spd * .25).toFixed(1), Math.min(v[1] + 1, 99)] : [s.spd, 1];
  }
  if (Date.now() - LIVE.histSaved > 60000) { LIVE.histSaved = Date.now(); save("liveHist", H); }
}
function liveSummary(r) {
  let cov = 0, busy = 0, jam = 0, tNow = 0, tUsual = 0;
  const slot = slotOf();
  for (const e of r.edges) {
    const L = e.to - e.from; const v = G.vLive[e.de]; if (!(v > 0)) continue;
    cov += L; if (G.moe[e.de] === 1) busy += L; if (G.moe[e.de] >= 2) jam += L;
    const sid = LIVE.deSec.get(e.de), u = sid && LIVE.hist[sid] && LIVE.hist[sid][slot];
    if (u && u[1] >= 3) { tNow += L / v; tUsual += L / u[0]; }
  }
  return { cov, busy, jam, vsUsual: tUsual ? tNow / tUsual : null };
}
function liveText(r) {
  if (!LIVE.n) return "";
  const s = liveSummary(r);
  if (s.cov < 200) return '<span class="live same">即時路況：這條路線沒有偵測資料</span>';
  const parts = [];
  if (s.jam > 50) parts.push(`<span class="live slow">壅塞 ${(s.jam / 1000).toFixed(1)} km</span>`);
  if (s.busy > 50) parts.push(`<span class="live warn">稍慢 ${(s.busy / 1000).toFixed(1)} km</span>`);
  if (s.vsUsual) { const p = Math.round((s.vsUsual - 1) * 100); if (Math.abs(p) >= 8) parts.push(`<span class="live ${p > 0 ? "slow" : "fast"}">比平常${p > 0 ? "慢" : "快"} ${Math.abs(p)}%</span>`); }
  if (!parts.length) parts.push('<span class="live fast">順暢</span>');
  return `<span class="live same">即時（${(s.cov / 1000).toFixed(1)} km 有資料）：</span>` + parts.join(" ");
}
function onLive() {
  if (R.on) { R.liveDirty = true; if (R.route) drawRideRoute(); return; }
  S.plan = { am: null, pm: null };
  if (!$("v-plan").hidden) renderPlan();
}

/* ---------------- time helpers ---------------- */
const tod = (d = new Date()) => d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
function clock(sec, withSec) { sec = mod(Math.round(sec), 86400); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60; return pad(h) + ":" + pad(m) + (withSec ? ":" + pad(s) : ""); }
function parseClock(v) { if (!v) return null; const p = v.split(":").map(Number); if (p.some(isNaN)) return null; return p[0] * 3600 + (p[1] || 0) * 60 + (p[2] || 0); }
const mins = s => Math.round(s / 60);
const mmss = s => { s = Math.round(s); return Math.floor(s / 60) + ":" + pad(s % 60); };
const dateStr = (d = new Date()) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const periodOf = sec => (sec < 13 * 3600 ? "am" : "pm");
const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const quant = (a, q) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(q * (s.length - 1))]; };
const xyOf = p => Graph.toXY(p.lat, p.lon);

/* ---------------- signal learning ---------------- */
const sigKey = (period, sid) => period + "_" + sid;
function sigRec(period, sid) { const k = sigKey(period, sid); return S.sig[k] || (S.sig[k] = { obs: [], manual: null }); }
function addObs(period, sid, o) { const r = sigRec(period, sid); if (r.obs.some(x => x.date === o.date && Math.abs(x.t - o.t) < 20)) return; r.obs.push(o); if (r.obs.length > 80) r.obs.splice(0, r.obs.length - 80); delete r._m; save("signals", S.sig); }
function fitCycle(onsets) {
  let best = 0; const res = [];
  for (let C = 60; C <= 220; C += .5) {
    let sx = 0, sy = 0; for (const t of onsets) { const a = 2 * Math.PI * t / C; sx += Math.cos(a); sy += Math.sin(a); }
    const R = Math.hypot(sx, sy) / onsets.length; res.push({ C, R, ph: Math.atan2(sy, sx) }); if (R > best) best = R;
  }
  const ok = res.filter(x => x.R >= Math.max(.8, best * .93));
  if (!ok.length) return null;
  const p = ok[ok.length - 1];
  return { C: p.C, R: p.R, ref: mod(p.ph / (2 * Math.PI) * p.C, p.C) };
}
function sigModel(period, sid) {
  const rec = S.sig[sigKey(period, sid)];
  if (!rec) return null;
  if (rec.manual && rec.manual.cycle) return { cycle: rec.manual.cycle, green: rec.manual.green, ref: parseClock(rec.manual.ref), src: "manual", n: rec.obs.length };
  if (rec._m !== undefined) return rec._m;
  const on = rec.obs.filter(o => o.kind === "resume" || o.kind === "stamp").map(o => o.kind === "resume" ? o.t - 2 : o.t);
  let m = null;
  if (on.length >= 4) {
    const f = fitCycle(on);
    if (f) {
      const waits = rec.obs.filter(o => o.kind === "resume" && o.wait).map(o => o.wait);
      let red = waits.length ? quant(waits, .9) + 3 : f.C * .45;
      red = Math.max(15, Math.min(f.C - 10, red));
      m = { cycle: f.C, green: Math.round(f.C - red), ref: f.ref, src: "auto", n: on.length, R: f.R };
    }
  }
  Object.defineProperty(rec, "_m", { value: m, writable: true, configurable: true, enumerable: false });
  return m;
}
function lightAt(m, t) { const ph = mod(t - m.ref, m.cycle); return ph < m.green ? { green: true, left: m.green - ph } : { green: false, wait: m.cycle - ph }; }
function sigStats(period, sid) {
  const rec = S.sig[sigKey(period, sid)]; if (!rec) return null;
  const w = rec.obs.filter(o => o.kind === "resume" && o.wait).map(o => o.wait);
  return w.length ? { n: w.length, avg: w.reduce((a, b) => a + b, 0) / w.length } : null;
}
function sigDelay(s, period) {
  const k = sigKey(period, s.id), rec = S.sig[k], n = S.passes[k];
  if (rec && n >= 2) { const tot = rec.obs.filter(o => o.kind === "resume" && o.wait).reduce((a, o) => a + o.wait, 0); return tot / n; }
  return Graph.priorDelay(s);
}

/* ---------------- learning from recorded tracks ---------------- */
function analyzeTrack(pts) {
  // pts: [t, lat, lon, v, heading, acc, alt, aMax]
  const m = Graph.matchTrack(pts);
  let dist = 0, moving = 0, stopped = 0, vmax = 0;
  const stops = [], roads = [], sigPassed = new Map(), deSet = new Set(), deSpeed = new Map();
  let stopStart = null;
  const vs = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    let v = p[3];
    if (i > 0) {
      const dt = (p[0] - pts[i - 1][0]) / 1000, dd = Math.hypot(m[i].xy[0] - m[i - 1].xy[0], m[i].xy[1] - m[i - 1].xy[1]);
      if (v == null || v < 0) v = dt > 0 ? dd / dt : 0;
      if (dt > 0 && dt < 30) { dist += dd; if (v > 1.2) moving += dt; else stopped += dt; }
      if (m[i].de >= 0) {
        const nm = Graph.shortName(Graph.nameOf(Graph.deE(m[i].de))) || "無名道路";
        const last = roads[roads.length - 1];
        if (last && last.name === nm) { last.dist += dd; last.t1 = p[0]; } else roads.push({ name: nm, dist: dd, t0: pts[i - 1][0], t1: p[0] });
        deSet.add(m[i].de);
        if (v > 2) { const a = deSpeed.get(m[i].de) || []; a.push(v); deSpeed.set(m[i].de, a); }
        const n = Graph.deTo(m[i].de);
        if (G.isSig[n] && !sigPassed.has(G.sigCluster.get(n))) {
          const nx = G.xy[2 * n], ny = G.xy[2 * n + 1];
          if (Math.hypot(nx - m[i].xy[0], ny - m[i].xy[1]) < 30) sigPassed.set(G.sigCluster.get(n), p[0]);
        }
      }
    }
    vs.push(v || 0);
    if ((v || 0) < 1.2) { if (stopStart == null) stopStart = i; }
    else if (stopStart != null) {
      const dur = (p[0] - pts[stopStart][0]) / 1000;
      if (dur >= 4) {
        const sp = pts[stopStart], xy = m[stopStart].xy;
        const sg = Graph.nearestSignal(xy[0], xy[1], 45);
        stops.push({ t: sp[0], resume: p[0], wait: Math.round(dur), lat: sp[1], lon: sp[2], sid: sg ? sg.id : null, name: sg ? Graph.sigNameById(sg.id) : null });
      }
      stopStart = null;
    }
  }
  const sm = vs.map((v, i) => median(vs.slice(Math.max(0, i - 2), i + 3)));
  vmax = Math.max(0, ...sm);
  return { m, dist, moving, stopped, vmax, stops, roads: roads.filter(r => r.dist > 20), sigPassed, deSet, deSpeed };
}
const deSamples = new Map();
async function learnFromTracks(only) {
  const tracks = only ? [only] : await DB.all();
  if (!only) { G.habit.fill(0); deSamples.clear(); S.passes = {}; }
  for (const tr of tracks) {
    if (!tr.pts || tr.pts.length < 60) continue;
    const a = analyzeTrack(tr.pts);
    const period = periodOf(tod(new Date(tr.pts[0][0])));
    for (const de of a.deSet) G.habit[de] += 1;
    for (const [de, v] of a.deSpeed) { const arr = deSamples.get(de) || []; arr.push(...v); if (arr.length > 200) arr.splice(0, arr.length - 200); deSamples.set(de, arr); }
    for (const sid of a.sigPassed.keys()) { const k = sigKey(period, sid); S.passes[k] = (S.passes[k] || 0) + 1; }
    for (const st of a.stops) if (st.sid) addObs(period, st.sid, { kind: "resume", t: Math.round(tod(new Date(st.resume))), wait: st.wait, date: dateStr(new Date(st.t)) });
    if (!only) await new Promise(r => setTimeout(r, 0));
  }
  for (const [de, arr] of deSamples) if (arr.length >= 5) G.vLearn[de] = median(arr);
  S.learned = tracks.length;
}
const hasHabit = () => { for (let i = 0; i < G.habit.length; i++) if (G.habit[i] > 0) return true; return false; };

/* ---------------- estimates ---------------- */
function routeTime(r, d0 = 0, period) {
  period = period || periodOf(tod());
  return Graph.timeAlong(r, d0, r.distance) + r.signals.filter(s => s.d > d0 + 5).reduce((a, s) => a + sigDelay(s, period), 0);
}
function calibFactor(dir) {
  const f = S.trips.filter(t => t.dir === dir && t.pred && t.duration > 300).map(t => t.duration / t.pred);
  return f.length >= 3 ? Math.max(.7, Math.min(1.5, median(f))) : 1;
}
function placeOf(dir, end) { return (dir === "am") === (end === "from") ? S.settings.home : S.settings.office; }
function computePlan(dir) {
  const A = placeOf(dir, "from"), B = placeOf(dir, "to");
  if (!A || !B) return [];
  const a = xyOf(A), b = xyOf(B);
  const specs = [];
  if (hasHabit()) specs.push({ tag: "你最常走的", opts: { habit: 1 } });
  specs.push({ tag: "建議路線", opts: { habit: hasHabit() ? .4 : 0 } });
  for (const v of dir === "am" ? ["永福橋", "中正橋", "福和橋"] : ["福和橋", "永福橋", "中正橋"]) specs.push({ tag: "經" + v, opts: { via: v, habit: hasHabit() ? .4 : 0 } });
  const out = [];
  for (const sp of specs) {
    const r = Graph.route({ x: a[0], y: a[1] }, { x: b[0], y: b[1] }, sp.opts);
    if (!r) continue;
    const dup = out.find(o => Math.abs(o.r.distance - r.distance) < 40 && o.r.label === r.label);
    if (dup) { if (!dup.tags.includes(sp.tag)) dup.tags.push(sp.tag); continue; }
    out.push({ r, tags: [sp.tag] });
  }
  const f = calibFactor(dir);
  for (const o of out) o.sec = routeTime(o.r, 0, dir) * f;
  const min = Math.min(...out.map(o => o.sec));
  return out.filter(o => o.sec <= min * 1.35 || o.tags.includes("你最常走的")).sort((x, y) => x.sec - y.sec);
}

/* ---------------- maps (MapLibre + OpenFreeMap vector tiles: sharp at any zoom, rotates with heading) ---------------- */
const STYLE = { nav: "https://tiles.openfreemap.org/styles/liberty", light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;
const lngLat = (x, y) => { const ll = Graph.toLL(x, y); return [ll[1], ll[0]]; };
const routeCoords = r => r.geom.map(p => lngLat(p[0], p[1]));
const fc = features => ({ type: "FeatureCollection", features });
const lineF = (coords, props = {}) => ({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } });
const ptF = (c, props = {}) => ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: c } });
const FONT = ["Noto Sans Regular"];
function mkMap(id, opts = {}) {
  const m = new maplibregl.Map({
    container: id, style: opts.style || (dark() ? STYLE.dark : STYLE.light), center: [121.525, 25.022], zoom: 13,
    attributionControl: false, dragRotate: !!opts.nav, touchPitch: !!opts.nav, maxPitch: 65, fadeDuration: 0,
  });
  m.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
  if (opts.zoomCtl) m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  m.ready = new Promise(res => m.on("load", () => {
    // Chinese street names; hide shop/POI clutter on the navigation map
    for (const l of m.getStyle().layers) {
      if (l.type === "symbol" && l.layout && l.layout["text-field"]) m.setLayoutProperty(l.id, "text-field", ["coalesce", ["get", "name:zh-Hant"], ["get", "name:zh"], ["get", "name"]]);
      if (opts.nav && /^poi|airport|^label_other/.test(l.id)) m.setLayoutProperty(l.id, "visibility", "none");
    }
    const at = m.getContainer().querySelector(".maplibregl-ctrl-attrib"); if (at) at.classList.remove("maplibregl-compact-show");
    res();
  }));
  return m;
}
function setGeo(m, id, data) { const s = m.getSource(id); if (s) s.setData(data); else m.addSource(id, { type: "geojson", data }); }
function addLayer(m, layer) { if (!m.getLayer(layer.id)) m.addLayer(layer); }
const ROUND = { "line-cap": "round", "line-join": "round" };
function pinEl(kind) { const d = document.createElement("div"); d.innerHTML = `<div class="pinwrap"><div class="pin ${kind}"><span>${kind === "home" ? "家" : "公"}</span></div></div>`; return d.firstChild; }
function fitTo(m, coords, pad = 40) {
  if (!coords.length) return;
  const b = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
  m.fitBounds(b, { padding: pad, duration: 0, maxZoom: 17, bearing: 0, pitch: 0 });
}
const MOE_COLOR = ["#2fc26b", "#f2a33a", "#e5483d"];
function trafficFeatures(r, fromD = 0) {
  const f = [];
  for (const e of r.edges) { if (e.to < fromD) continue; const mo = G.moe[e.de]; if (mo < 1) continue; f.push(lineF(Graph.edgePtsLL(e.de).map(p => [p[1], p[0]]), { c: MOE_COLOR[Math.min(2, mo)] })); }
  return f;
}
let planMap, planMk = [];
async function renderPlanMap(plan) {
  if (!planMap) {
    planMap = mkMap("planMap");
    planMap.on("click", "plan-alt", e => { S.sel[S.dir] = e.features[0].properties.i; renderPlan(); });
  }
  await planMap.ready; planMap.resize();
  const H = S.settings.home, O = S.settings.office;
  const cur = plan[S.sel[S.dir]];
  setGeo(planMap, "plan-alt", fc(plan.map((o, i) => i === S.sel[S.dir] ? null : lineF(routeCoords(o.r), { i, c: ROUTE_COLORS[i % 5] })).filter(Boolean)));
  setGeo(planMap, "plan-cur", fc(cur ? [lineF(routeCoords(cur.r), { c: ROUTE_COLORS[S.sel[S.dir] % 5] })] : []));
  setGeo(planMap, "plan-traffic", fc(cur ? trafficFeatures(cur.r) : []));
  setGeo(planMap, "plan-sig", fc(cur ? cur.r.signals.map(s => ptF(lngLat(s.x, s.y), { c: sigModel(S.dir, s.id) ? "#2fc26b" : "#8a949b" })) : []));
  addLayer(planMap, { id: "plan-alt", type: "line", source: "plan-alt", layout: ROUND, paint: { "line-color": ["get", "c"], "line-width": 5, "line-opacity": .55 } });
  addLayer(planMap, { id: "plan-cur-case", type: "line", source: "plan-cur", layout: ROUND, paint: { "line-color": "#ffffff", "line-width": 10 } });
  addLayer(planMap, { id: "plan-cur", type: "line", source: "plan-cur", layout: ROUND, paint: { "line-color": ["get", "c"], "line-width": 6 } });
  addLayer(planMap, { id: "plan-traffic", type: "line", source: "plan-traffic", layout: ROUND, paint: { "line-color": ["get", "c"], "line-width": 3 } });
  addLayer(planMap, { id: "plan-sig", type: "circle", source: "plan-sig", minzoom: 13.5, paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 13.5, 2.5, 17, 6], "circle-color": ["get", "c"], "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
  planMk.forEach(m => m.remove()); planMk = [];
  if (!H || !O) { planMap.jumpTo({ center: [121.525, 25.022], zoom: 12.5 }); return; }
  planMk.push(new maplibregl.Marker({ element: pinEl("home"), anchor: "bottom" }).setLngLat([H.lon, H.lat]).addTo(planMap));
  planMk.push(new maplibregl.Marker({ element: pinEl("office"), anchor: "bottom" }).setLngLat([O.lon, O.lat]).addTo(planMap));
  fitTo(planMap, cur ? routeCoords(cur.r) : [[H.lon, H.lat], [O.lon, O.lat]], 36);
}


/* ---------------- plan view ---------------- */
function renderPlan() {
  $("dAm").setAttribute("aria-pressed", S.dir === "am"); $("dPm").setAttribute("aria-pressed", S.dir === "pm");
  const ready = S.settings.home && S.settings.office;
  $("onboard").hidden = !!ready;
  $("startBtn").disabled = !ready;
  $("optAuto").checked = !!S.settings.auto;
  if (!ready) { $("planHero").hidden = true; $("planRoutes").innerHTML = ""; $("planNote").textContent = ""; renderPlanMap([]); return; }
  $("planHero").hidden = false;
  const plan = S.plan[S.dir] || (S.plan[S.dir] = computePlan(S.dir));
  if (S.sel[S.dir] >= plan.length) S.sel[S.dir] = 0;
  const cur = plan[S.sel[S.dir]];
  if (!cur) { $("planHero").innerHTML = "<p>找不到路線，請確認家和公司的位置在永和到中山區之間的道路旁。</p>"; return; }
  const now = tod(), arrive = now + cur.sec;
  const ts = S.trips.filter(t => t.dir === S.dir && t.duration > 300).map(t => t.duration);
  let extra = "";
  if (ts.length) extra += `<div class="line">你過去 ${ts.length} 趟的中位數 <b class="num">${mins(median(ts))}</b> 分鐘</div>`;
  if (S.dir === "am") {
    const dl = parseClock(S.settings.deadline) || 32400;
    if (now < dl + 1800) {
      const p80 = ts.length >= 5 ? quant(ts, .8) : cur.sec * 1.15;
      const latest = dl - p80;
      extra += `<div class="line">${S.settings.deadline} 前到：最晚 <b class="num">${clock(latest)}</b> 出門 ${now > latest ? '<span class="pill late">已經來不及</span>' : now > latest - 300 ? '<span class="pill warn">快出門</span>' : '<span class="pill ok">還有 ' + mins(latest - now) + ' 分</span>'}</div>`;
    }
  }
  $("planHero").innerHTML = `<div class="eyebrow">${DIRNAME[S.dir]} · 現在出發</div>
    <div class="big-num num">${clock(arrive)}<small>抵達</small></div>
    <div class="route">${esc(cur.r.label)}</div>
    <div class="line">約 <b class="num">${mins(cur.sec)}</b> 分鐘 · ${(cur.r.distance / 1000).toFixed(1)} km · ${cur.r.signals.filter(s => s.kind === "junction").length} 個號誌路口</div>${extra}`;
  $("planRoutes").innerHTML = plan.map((o, i) => `<button class="ritem" data-i="${i}" aria-pressed="${i === S.sel[S.dir]}">
      <span class="sw" style="background:${ROUTE_COLORS[i % 5]}"></span>
      <span style="min-width:0"><span class="nm">${esc(o.r.label)}</span><br>
      <span class="meta">${o.tags.map(t => `<span class="pill ${t === "你最常走的" ? "ok" : "info"}">${esc(t)}</span>`).join(" ")} <span class="num">${(o.r.distance / 1000).toFixed(1)} km</span> · ${o.r.signals.filter(s => s.kind === "junction").length} 路口</span><br>${liveText(o.r)}</span>
      <span class="t num">${mins(o.sec)}<small>分</small></span></button>`).join("");
  $("planRoutes").querySelectorAll(".ritem").forEach(b => b.onclick = () => { S.sel[S.dir] = +b.dataset.i; renderPlan(); });
  const liveLine = LIVE.err ? LIVE.err + "。" : LIVE.n ? `即時路況：台北市交控中心 ${clock(tod(new Date(LIVE.at)))} 更新，${LIVE.n} 個路段（永和段沒有公開資料）。` : "";
  $("planNote").textContent = liveLine + (S.learned ? `已從你的 ${S.learned} 條軌跡學習常走的路和各路段車速。導航時走別條路，會自動重新規劃。` : "還沒有你的軌跡，時間是一般估計。導航時走別條路會自動重新規劃；騎幾趟後，路線和時間會改成依你的習慣。");
  renderPlanMap(plan);
}

/* ---------------- ride engine ---------------- */
const R = { on: false };
let rideMap, puck;
function speak(text, key) {
  if (!S.settings.voice || !("speechSynthesis" in window)) return;
  if (key) { if (R.said[key]) return; R.said[key] = 1; }
  try { const u = new SpeechSynthesisUtterance(text); u.lang = "zh-TW"; u.rate = 1.05; speechSynthesis.speak(u); } catch (e) { }
}
async function wakeLock() { try { if ("wakeLock" in navigator) R.wake = await navigator.wakeLock.request("screen"); } catch (e) { } }
document.addEventListener("visibilitychange", () => { if (R.on && document.visibilityState === "visible") wakeLock(); });
function onMotion(e) { const a = e.acceleration; if (!a || a.x == null) return; const g = Math.hypot(a.x, a.y, a.z); if (!(R.aMax >= g)) R.aMax = g; }

async function startRide(opts = {}) {
  if (R.on) return;
  if (!("geolocation" in navigator)) { toast("這個瀏覽器不支援定位"); return; }
  const dir = opts.dir || S.dir;
  const dest = placeOf(dir, "to");
  if (!dest) { toast("請先設定家和公司"); return; }
  const plan = S.plan[dir] || computePlan(dir);
  const chosen = opts.auto ? null : plan[S.sel[dir]];
  stopPassive();
  Object.assign(R, { on: true, dir, dest: xyOf(dest), destLL: dest, route: chosen ? chosen.r : null, pts: [], said: {}, off: 0, lastReroute: 0, follow: true, stopStart: null, stopsLog: [], aMax: null, startT: Date.now(), id: null, pred: null, arriveT: null, lastSave: 0, reroutes: 0, hdSm: null, last: null, d: 0 });
  if (S.settings.motion && window.DeviceMotionEvent) {
    try { if (typeof DeviceMotionEvent.requestPermission === "function" && !opts.auto) await DeviceMotionEvent.requestPermission(); window.addEventListener("devicemotion", onMotion); } catch (e) { }
  }
  document.body.classList.add("riding"); show("ride");
  if (!rideMap) {
    rideMap = mkMap("rideMap", { style: STYLE.nav, nav: true });
    const el = document.createElement("div"); el.className = "puck"; el.innerHTML = "<i></i>";
    puck = new maplibregl.Marker({ element: el, rotationAlignment: "map", pitchAlignment: "map" }).setLngLat([121.52, 25.02]);
    rideMap.on("dragstart", () => setFollow(false));
    rideMap.on("click", "r-sig", e => { const p = e.features[0].properties; toast(p.name + (p.lab ? " · " + p.lab : "")); });
    await rideMap.ready;
    initRideLayers();
  }
  await rideMap.ready;
  rideMap.resize();
  puck.addTo(rideMap);
  setFollow(true);
  if (R.route) drawRideRoute();
  wakeLock();
  speak(opts.auto ? "偵測到你在騎車，已自動開始導航和記錄" : "開始導航");
  R.watch = navigator.geolocation.watchPosition(onFix, onGeoErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  R.tick = setInterval(() => { renderRide(); if (R.liveDirty) { R.liveDirty = false; R.lastBetter = 0; } checkBetterRoute(); }, 1000);
  renderRide();
}
function initRideLayers() {
  const m = rideMap, empty = fc([]);
  for (const id of ["r-route", "r-done", "r-traffic", "r-turn", "r-sig", "r-dest"]) setGeo(m, id, empty);
  addLayer(m, { id: "r-route-case", type: "line", source: "r-route", layout: ROUND, paint: { "line-color": "#0b4fb3", "line-width": ["interpolate", ["linear"], ["zoom"], 13, 7, 18, 22] } });
  addLayer(m, { id: "r-route", type: "line", source: "r-route", layout: ROUND, paint: { "line-color": "#2f86ff", "line-width": ["interpolate", ["linear"], ["zoom"], 13, 4.5, 18, 16] } });
  addLayer(m, { id: "r-traffic", type: "line", source: "r-traffic", layout: ROUND, paint: { "line-color": ["get", "c"], "line-width": ["interpolate", ["linear"], ["zoom"], 13, 3, 18, 9] } });
  addLayer(m, { id: "r-done", type: "line", source: "r-done", layout: ROUND, paint: { "line-color": "#9aa5ad", "line-width": ["interpolate", ["linear"], ["zoom"], 13, 4.5, 18, 16] } });
  addLayer(m, { id: "r-turn", type: "line", source: "r-turn", layout: ROUND, paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 13, 2, 18, 6] } });
  addLayer(m, { id: "r-sig", type: "circle", source: "r-sig", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 4, 18, 11], "circle-color": ["get", "c"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 2.5 } });
  addLayer(m, { id: "r-sig-label", type: "symbol", source: "r-sig", minzoom: 14.5, layout: { "text-field": ["get", "lab"], "text-font": FONT, "text-size": 13, "text-offset": [0, -1.5], "text-allow-overlap": true, "text-anchor": "bottom" }, paint: { "text-color": ["get", "tc"], "text-halo-color": "#ffffff", "text-halo-width": 2 } });
  addLayer(m, { id: "r-dest", type: "circle", source: "r-dest", paint: { "circle-radius": 9, "circle-color": "#e5483d", "circle-stroke-color": "#fff", "circle-stroke-width": 3 } });
}
function setFollow(on) {
  R.follow = on;
  $("rRecenter").hidden = on;
  $("rOverview").textContent = on ? "概覽" : "導航視角";
  if (on && R.last) camera(true);
}
function camera(jump) {
  const f = R.last; if (!f || !rideMap) return;
  const h = rideMap.getContainer().clientHeight;
  const zoom = f.v < 4 ? 17.6 : f.v < 9 ? 17.1 : 16.6;
  const opts = { center: [f.lon, f.lat], bearing: R.hdSm == null ? rideMap.getBearing() : R.hdSm, pitch: 52, zoom, padding: { top: Math.round(h * .42), bottom: 90, left: 0, right: 0 } };
  if (jump) rideMap.jumpTo(opts); else rideMap.easeTo(Object.assign(opts, { duration: 950, easing: t => t }));
}
function overview() {
  if (!R.route) return;
  setFollow(false);
  const c = routeCoords(R.route);
  const b = c.reduce((b, x) => b.extend(x), new maplibregl.LngLatBounds(c[0], c[0]));
  const h = rideMap.getContainer().clientHeight;
  rideMap.jumpTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
  rideMap.fitBounds(b, { padding: { top: Math.round(h * .22), bottom: Math.round(h * .3), left: 30, right: 30 }, duration: 600 });
}
function drawRideRoute() {
  if (!rideMap || !rideMap.getSource("r-route")) return;
  setGeo(rideMap, "r-route", fc([lineF(routeCoords(R.route))]));
  setGeo(rideMap, "r-traffic", fc(trafficFeatures(R.route)));
  setGeo(rideMap, "r-dest", fc([ptF([R.destLL.lon, R.destLL.lat])]));
  if (!R.pred) R.pred = routeTime(R.route, 0, R.dir) * calibFactor(R.dir);
}
function onGeoErr(e) { $("rGps").textContent = e.code === 1 ? "沒有定位權限：請到 iPhone 設定 › Safari › 位置，允許這個網站" : "GPS 訊號弱，等待定位…"; }
function onFix(pos) {
  const c = pos.coords, t = pos.timestamp || Date.now();
  const xy = Graph.toXY(c.latitude, c.longitude);
  const last = R.last;
  let v = c.speed;
  if ((v == null || isNaN(v) || v < 0) && last) { const dt = (t - last.t) / 1000; v = dt > 0 ? Math.hypot(xy[0] - last.xy[0], xy[1] - last.xy[1]) / dt : 0; }
  v = Math.max(0, v || 0);
  let hd = (c.heading != null && !isNaN(c.heading) && v > 1.5) ? c.heading * Math.PI / 180 : null;
  if (hd == null && last && Math.hypot(xy[0] - last.xy[0], xy[1] - last.xy[1]) > 4) hd = Math.atan2(xy[0] - last.xy[0], xy[1] - last.xy[1]);
  if (hd == null && last) hd = last.hd;
  const fix = { t, xy, v, hd, acc: c.accuracy || 0, lat: c.latitude, lon: c.longitude };
  R.pts.push([t, +c.latitude.toFixed(6), +c.longitude.toFixed(6), +v.toFixed(2), hd == null ? -1 : Math.round(hd * 180 / Math.PI), Math.round(c.accuracy || 0), c.altitude == null ? null : Math.round(c.altitude), R.aMax == null ? null : +R.aMax.toFixed(2)]);
  R.aMax = null;
  if (!R.id) { const d0 = new Date(t); R.id = dateStr(d0) + "_" + R.dir + "_" + pad(d0.getHours()) + pad(d0.getMinutes()); }
  if (Date.now() - R.lastSave > 20000) { R.lastSave = Date.now(); DB.put({ id: R.id, pts: R.pts, partial: true }); }
  // smooth the heading the map turns to (only while moving)
  if (hd != null && v > 1.5) {
    const deg = hd * 180 / Math.PI;
    if (R.hdSm == null) R.hdSm = deg;
    else { let dlt = ((deg - R.hdSm + 540) % 360) - 180; R.hdSm = (R.hdSm + dlt * (v > 6 ? .55 : .35) + 360) % 360; }
  }
  if (!R.route) reroute(fix, true);
  else {
    const pr = Graph.project(R.route, xy);
    R.d = pr.d; R.dist = pr.dist;
    if (pr.dist > Math.max(30, Math.min(60, fix.acc * 1.5))) R.off++; else R.off = 0;
    if (R.off >= 3 && Date.now() - R.lastReroute > 4000) reroute(fix, false);
  }
  detectStops(fix);
  R.last = fix;
  if (puck) { puck.setLngLat([fix.lon, fix.lat]); if (fix.hd != null) puck.setRotation(fix.hd * 180 / Math.PI); puck.getElement().classList.toggle("nohead", fix.hd == null); }
  if (R.follow) camera(!last);
  checkArrival(fix);
  renderRide();
}
function reroute(fix, initial) {
  R.lastReroute = Date.now();
  const r = Graph.route({ x: fix.xy[0], y: fix.xy[1], heading: fix.v > 2 ? fix.hd : null }, { x: R.dest[0], y: R.dest[1] }, { habit: hasHabit() ? .6 : 0 });
  if (!r) return;
  R.route = r; R.off = 0; R.d = 0; R.dist = 0;
  drawRideRoute();
  if (!initial) { R.reroutes++; const t = r.turns[0]; speak("已改走你目前的路線" + (t ? `，${Math.round(t.d / 50) * 50 || 50}公尺後${turnWord(t.dir)}，${t.onto}` : "")); }
}
function checkBetterRoute() {
  if (!R.route || !R.last || R.off) return;
  if (Date.now() - (R.lastBetter || 0) < 60000) return;
  R.lastBetter = Date.now();
  const f = R.last;
  const alt = Graph.route({ x: f.xy[0], y: f.xy[1], heading: f.v > 2 ? f.hd : null }, { x: R.dest[0], y: R.dest[1] }, { habit: hasHabit() ? .6 : 0 });
  if (!alt) return;
  const cur = routeTime(R.route, R.d || 0, R.dir), nt = routeTime(alt, 0, R.dir);
  const same = Math.abs(alt.distance - (R.route.distance - (R.d || 0))) < 150 && alt.label === R.route.label;
  if (!same && nt < cur - 90) {
    R.route = alt; R.d = 0; R.off = 0; drawRideRoute();
    const ls = liveSummary(alt);
    speak(`前方${ls.jam > 0 ? "壅塞" : "車流較慢"}，改走 ${alt.label.split(" → ").slice(0, 2).join("、")}，約快 ${Math.max(1, Math.round((cur - nt) / 60))} 分鐘`);
    toast("依即時路況改走較快的路線");
  }
}
function detectStops(f) {
  if (f.v < 1.2) { if (R.stopStart == null) { R.stopStart = f.t; R.stopXY = f.xy; } }
  else if (f.v > 2.5 && R.stopStart != null) {
    const wait = (f.t - R.stopStart) / 1000;
    const sg = Graph.nearestSignal(R.stopXY[0], R.stopXY[1], 45);
    if (wait >= 4 && wait < 300 && sg) {
      const d = new Date(f.t);
      addObs(periodOf(tod(d)), sg.id, { kind: "resume", t: Math.round(tod(d)), wait: Math.round(wait), date: dateStr(d) });
      R.stopsLog.push({ sid: sg.id, wait: Math.round(wait) });
    }
    R.stopStart = null;
  }
}
function checkArrival(f) {
  const dd = Math.hypot(f.xy[0] - R.dest[0], f.xy[1] - R.dest[1]);
  if (dd < 70 && f.v < 1.5) { if (!R.arriveT) R.arriveT = f.t; if (f.t - R.arriveT > 10000) finishRide(true); }
  else R.arriveT = null;
}
const turnWord = d => ({ L: "左轉", R: "右轉", SL: "靠左", SR: "靠右", U: "迴轉" }[d] || "直行");
const ARROWS = {
  L: "M34 50V30a6 6 0 0 0-6-6H14m0 0l9-9m-9 9l9 9", R: "M24 50V30a6 6 0 0 1 6-6h14m0 0l-9-9m9 9l-9 9",
  SL: "M36 50V34L20 16m0 0v12m0-12h12", SR: "M22 50V34L38 16m0 0v12m0-12H26", U: "M20 50V24a10 10 0 0 1 20 0v14m0 0l-8-8m8 8l8-8", S: "M29 50V10m0 0l-10 10m10-10l10 10", F: "M29 8a12 12 0 0 1 12 12c0 10-12 26-12 26S17 30 17 20A12 12 0 0 1 29 8z"
};
const arrowSvg = (k, w = 6) => `<svg viewBox="0 0 58 58"><path d="${ARROWS[k] || ARROWS.S}" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(1) + "<small>km</small>" : (m >= 100 ? Math.round(m / 50) * 50 : Math.max(10, Math.round(m / 10) * 10)) + "<small>m</small>"; }
const fmtDistTxt = m => m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m / 10) * 10 + " m";
/* predicted light at a signal when you get there */
function predict(s, distM, v) {
  const period = periodOf(tod());
  const m = sigModel(period, s.id), st = sigStats(period, s.id);
  if (!m) return { state: "unk", st, m: null };
  const lt = distM > 150 && R.route ? Graph.timeAlong(R.route, R.d, R.d + distM) : null;
  const tArr = tod() + (lt != null ? lt : distM / Math.max(v, 4));
  const Lt = lightAt(m, tArr), now = lightAt(m, tod());
  const conf = m.src === "manual" ? "手動設定" : `已學習 ${m.n} 次`;
  if (Lt.green && Lt.left >= 3) return { state: "go", left: Lt.left, now, m, conf };
  if (Lt.green) return { state: "amber", now, m, conf };
  const tg = tArr + Lt.wait - tod(), vNeed = distM / tg * 3.6;
  if (vNeed >= 15 && distM > 60) return { state: "slow", v: Math.round(vNeed), wait: Lt.wait, now, m, conf };
  return { state: "stop", wait: Lt.wait, now, m, conf };
}
const STATE_COLOR = { go: "#22b35e", amber: "#f2a33a", slow: "#f2a33a", stop: "#e5483d", unk: "#8a949b" };
function sigLabel(p) {
  if (p.state === "go") return "綠";
  if (p.state === "amber") return "黃";
  if (p.state === "slow") return `收油 ${p.v}`;
  if (p.state === "stop") return `紅 ${Math.round(p.wait)}s`;
  return p.st ? `均 ${Math.round(p.st.avg)}s` : "";
}
function ring(frac, color) {
  const r = 22, c = 2 * Math.PI * r;
  return `<svg viewBox="0 0 54 54" class="ring"><circle cx="27" cy="27" r="${r}" stroke="rgba(127,127,127,.25)" stroke-width="6" fill="none"/><circle cx="27" cy="27" r="${r}" stroke="${color}" stroke-width="6" fill="none" stroke-linecap="round" stroke-dasharray="${(c * Math.max(0, Math.min(1, frac))).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 27 27)"/></svg>`;
}
function renderRide() {
  if (!R.on) return;
  const f = R.last;
  if (!f) { $("rGps").textContent = "等待 GPS 定位…"; $("rManRoad").textContent = "等待 GPS 定位"; return; }
  $("rGps").textContent = `GPS ±${Math.round(f.acc)} m · 已記錄 ${R.pts.length} 點${R.stopsLog.length ? " · 停 " + R.stopsLog.length + " 次" : ""}${R.reroutes ? " · 重新規劃 " + R.reroutes + " 次" : ""}`;
  $("rSpeed").textContent = Math.round(f.v * 3.6);
  $("rStamp").disabled = !(f.v < 1);
  if (!R.route) { $("rManDist").innerHTML = "—"; $("rManRoad").textContent = "規劃路線中…"; return; }
  const r = R.route, d = R.d || 0;
  // traveled part + next turn highlight on the map
  if (rideMap && rideMap.getSource("r-done")) {
    setGeo(rideMap, "r-done", fc([lineF(r.geom.filter(p => p[2] <= d).map(p => lngLat(p[0], p[1])).concat([[f.lon, f.lat]]))]));
  }
  // maneuver banner
  const man = $("rMan");
  man.classList.toggle("off", R.off >= 2);
  const turns = r.turns.filter(x => x.d > d + 3);
  const t = turns[0], t2 = turns[1];
  const remainM = Math.max(0, r.distance - d);
  let turnSeg = [];
  if (R.off >= 2) { $("rManIcon").innerHTML = arrowSvg("S"); $("rManDist").innerHTML = "偏離路線"; $("rManRoad").textContent = "依你走的路重新規劃…"; $("rThen").innerHTML = ""; }
  else if (t && t.d - d < 2500) {
    const dist = t.d - d;
    $("rManIcon").innerHTML = arrowSvg(t.dir);
    $("rManDist").innerHTML = fmtDist(dist);
    $("rManRoad").textContent = turnWord(t.dir) + "  " + t.onto;
    $("rThen").innerHTML = t2 && t2.d - t.d < 300 ? `<span class="then-ico">${arrowSvg(t2.dir, 7)}</span>接著${turnWord(t2.dir)} ${esc(t2.onto)}` : "";
    if (dist < 320 && dist > 150) speak(`${Math.round(dist / 50) * 50}公尺後${turnWord(t.dir)}，${t.onto}`, "t1" + t.d);
    if (dist < 70) speak(`${turnWord(t.dir)}，${t.onto}`, "t2" + t.d);
    turnSeg = r.geom.filter(p => p[2] >= t.d - 30 && p[2] <= t.d + 30).map(p => lngLat(p[0], p[1]));
  } else if (remainM < 150) { $("rManIcon").innerHTML = arrowSvg("F"); $("rManDist").innerHTML = fmtDist(remainM); $("rManRoad").textContent = "快到了"; $("rThen").innerHTML = ""; }
  else {
    const seg = r.segs.find(s => s.to > d) || r.segs[r.segs.length - 1];
    $("rManIcon").innerHTML = arrowSvg("S"); $("rManDist").innerHTML = fmtDist(t ? t.d - d : remainM); $("rManRoad").textContent = "沿 " + (seg ? seg.name : "") + " 直行"; $("rThen").innerHTML = "";
  }
  if (rideMap && rideMap.getSource("r-turn")) setGeo(rideMap, "r-turn", fc(turnSeg.length > 1 ? [lineF(turnSeg)] : []));
  // signals ahead: map labels, the next-signal card and the 3-signal rail
  const ahead = r.signals.filter(x => x.d > d + 8 && x.d - d < 2000);
  const preds = ahead.map(s => ({ s, dist: s.d - d, p: predict(s, s.d - d, f.v) }));
  if (rideMap && rideMap.getSource("r-sig")) setGeo(rideMap, "r-sig", fc(preds.map(({ s, p }) => ptF(lngLat(s.x, s.y), { c: STATE_COLOR[p.state], tc: p.state === "unk" ? "#4a535a" : STATE_COLOR[p.state], lab: sigLabel(p), name: s.name }))));
  const card = $("rSig");
  const first = preds[0];
  if (first && first.dist < 800 && R.off < 2) {
    const { s, dist, p } = first;
    let big, sub, ringHtml = "";
    if (p.state === "unk") { big = "號誌未知"; sub = p.st ? `你在這停過 ${p.st.n} 次，平均 ${Math.round(p.st.avg)} 秒` : "停下時會自動學習週期"; }
    else {
      big = p.state === "go" ? "綠燈可過" : p.state === "amber" ? "到時轉黃，準備停" : p.state === "slow" ? `收油到 ${p.v} 免停` : `紅燈 約等 ${Math.round(p.wait)} 秒`;
      const nowTxt = p.now.green ? `現在綠燈 剩 ${Math.round(p.now.left)} 秒` : `現在紅燈 剩 ${Math.round(p.now.wait)} 秒`;
      sub = `${nowTxt} · ${p.conf}`;
      const frac = p.now.green ? p.now.left / p.m.green : p.now.wait / (p.m.cycle - p.m.green);
      ringHtml = `<div class="ring-box">${ring(frac, p.now.green ? "#22b35e" : "#e5483d")}<span class="num">${Math.round(p.now.green ? p.now.left : p.now.wait)}</span></div>`;
    }
    card.className = "sigcard " + p.state;
    card.innerHTML = `${ringHtml}<div class="sc-body"><div class="sc-top"><span class="num sc-dist">${fmtDistTxt(dist)}</span><span class="sc-name">${esc(s.name)}</span></div><div class="sc-big">${esc(big)}</div><div class="sc-sub">${esc(sub)}</div></div>`;
    if (p.state !== "unk" && dist < 260 && dist > 110) speak(p.state === "go" ? "前方綠燈，保持" : p.state === "slow" ? `前方紅燈，收油到 ${p.v}` : "前方紅燈", "s" + s.id + p.state);
  } else { card.className = "sigcard empty"; card.innerHTML = ""; }
  $("rRail").innerHTML = preds.slice(first && first.dist < 800 ? 1 : 0, 4).map(({ s, dist, p }) => `<div class="rail-i"><i style="background:${STATE_COLOR[p.state]}"></i><span class="num">${fmtDistTxt(dist)}</span><b>${esc(sigLabel(p) || "—")}</b></div>`).join("");
  // ETA, deadline, vs usual, what lies ahead
  const rem = routeTime(r, d, R.dir) * calibFactor(R.dir);
  const arr = tod() + rem;
  $("rEta").textContent = clock(arr);
  $("rRemain").textContent = `剩 ${(remainM / 1000).toFixed(1)} km · ${mins(rem)} 分`;
  const pills = [];
  const dl = parseClock(S.settings.deadline) || 32400;
  if (R.dir === "am" && tod() > dl - 4 * 3600 && tod() < dl + 3600) pills.push(arr > dl ? `<span class="pill late">晚 ${Math.ceil((arr - dl) / 60)} 分到</span>` : `<span class="pill ok">${S.settings.deadline} 前到</span>`);
  const usual = S.trips.filter(x => x.dir === R.dir && x.duration > 300).map(x => x.duration);
  if (usual.length >= 3) {
    const delta = median(usual) - ((Date.now() - R.startT) / 1000 + rem);
    if (Math.abs(delta) >= 30) pills.push(`<span class="pill ${delta > 0 ? "ok" : "warn"}">比平常${delta > 0 ? "快" : "慢"} ${mmss(Math.abs(delta))}</span>`);
  }
  $("rStatus").innerHTML = pills.join("");
  const sigLeft = r.signals.filter(x => x.d > d + 8);
  const waitLeft = sigLeft.reduce((a, s) => a + sigDelay(s, periodOf(tod())), 0);
  const info = [`<span>前方 <b class="num">${sigLeft.length}</b> 個號誌，預估等 <b class="num">${mmss(waitLeft)}</b></span>`];
  let jam = null, jamLen = 0;
  for (const e of r.edges) { if (e.to <= d || e.from - d > 3000) continue; const mo = G.moe[e.de]; if (mo >= 1) { if (!jam) jam = { from: Math.max(0, e.from - d), mo, name: Graph.shortName(Graph.nameOf(Graph.deE(e.de))) }; jamLen += e.to - Math.max(e.from, d); jam.mo = Math.max(jam.mo, mo); } else if (jam) break; }
  if (jam) info.push(`<span class="${jam.mo >= 2 ? "t-jam" : "t-slow"}">${jam.from < 30 ? "目前" : fmtDistTxt(jam.from) + " 後"}${jam.mo >= 2 ? "壅塞" : "車流較慢"} ${fmtDistTxt(jamLen)}${jam.name ? "（" + esc(jam.name) + "）" : ""}</span>`);
  else if (LIVE.n) info.push('<span class="t-ok">前方 3 km 即時路況順暢</span>');
  $("rInfo").innerHTML = info.join("");
}
function stampGreen() {
  const f = R.last; if (!f) return;
  const sg = Graph.nearestSignal(f.xy[0], f.xy[1], 60);
  if (!sg) { toast("附近沒有號誌"); return; }
  const d = new Date();
  addObs(periodOf(tod(d)), sg.id, { kind: "stamp", t: Math.round(tod(d)), date: dateStr(d) });
  toast("已記錄：" + Graph.sigNameById(sg.id) + " 綠燈亮");
  R.stopStart = null;
}

async function finishRide(auto) {
  if (!R.on) return;
  R.on = false; clearInterval(R.tick);
  if (R.watch != null) navigator.geolocation.clearWatch(R.watch);
  window.removeEventListener("devicemotion", onMotion);
  try { R.wake && R.wake.release(); } catch (e) { }
  document.body.classList.remove("riding");
  if (R.pts.length > 30) {
    const tr = { id: R.id, pts: R.pts };
    await DB.put(tr);
    const trip = summarize(tr, R.dir, auto ? "nav" : "nav", R.pred);
    upsertTrip(trip);
    await learnFromTracks(tr); for (const k in S.sig) delete S.sig[k]._m;
    S.plan = { am: null, pm: null };
    toast(`${auto ? "已抵達。" : ""}這趟 ${mins(trip.duration)} 分鐘、${(trip.dist / 1000).toFixed(1)} km，停 ${trip.nStops} 次，已存檔`);
    speak(auto ? `已抵達，這趟 ${mins(trip.duration)} 分鐘` : "導航結束");
  } else { toast("導航結束（軌跡太短，沒有存檔）"); await DB.del(R.id); }
  show("plan"); renderAll(); startPassive();
}
function summarize(tr, dir, source, pred) {
  const a = analyzeTrack(tr.pts);
  const t0 = new Date(tr.pts[0][0]), t1 = new Date(tr.pts[tr.pts.length - 1][0]);
  const dur = (t1 - t0) / 1000;
  const majors = []; for (const r of a.roads) if (r.dist > 300 && !/[巷弄]/.test(r.name) && r.name !== "無名道路" && majors[majors.length - 1] !== r.name) majors.push(r.name);
  return { id: tr.id, date: dateStr(t0), dir, depart: Math.round(tod(t0)), arrive: Math.round(tod(t1)), duration: Math.round(dur), dist: Math.round(a.dist), moving: Math.round(a.moving), stopped: Math.round(a.stopped), nStops: a.stops.length, sigStops: a.stops.filter(s => s.sid).length, vAvg: a.moving ? +(a.dist / a.moving * 3.6).toFixed(1) : null, vMax: Math.round(a.vmax * 3.6), label: majors.slice(0, 5).join(" → "), pred: pred ? Math.round(pred) : null, source, hasTrack: true };
}
/* make sure every stored track has a detailed summary: tracks from the first version,
   and rides whose page was closed before "結束" (saved every 20 s), get one here */
async function repairTrips() {
  let fixed = 0;
  for (const tr of await DB.all()) {
    if (!tr.pts || tr.pts.length < 30 || (R.on && tr.id === R.id)) continue;
    const old = S.trips.find(x => x.id === tr.id);
    if (old && old.hasTrack && old.dist != null) continue;
    const dir = old ? old.dir : (/_pm_/.test(tr.id) ? "pm" : /_am_/.test(tr.id) ? "am" : dirFor(tr.pts));
    const sum = summarize(tr, dir, old ? old.source || "nav" : "nav", old ? old.pred : null);
    if (tr.partial) sum.partial = true;
    S.trips = S.trips.filter(x => x.id !== tr.id).concat(sum); fixed++;
  }
  if (fixed) { S.trips.sort((a, b) => a.id < b.id ? -1 : 1); saveTrips(); }
  return fixed;
}
function upsertTrip(t) { S.trips = S.trips.filter(x => x.id !== t.id).concat(t).sort((a, b) => a.id < b.id ? -1 : 1); saveTrips(); }

/* passive watch: detect riding while the app is open and start automatically */
const PW = { id: null, fast: 0 };
function startPassive() {
  stopPassive();
  if (!S.settings.auto || !S.settings.home || !S.settings.office || !("geolocation" in navigator) || document.visibilityState !== "visible") return;
  PW.fast = 0;
  PW.id = navigator.geolocation.watchPosition(p => {
    const v = p.coords.speed;
    if (v != null && v > 4.5) PW.fast++; else PW.fast = 0;
    if (PW.fast >= 4 && !R.on) {
      const xy = Graph.toXY(p.coords.latitude, p.coords.longitude);
      const dh = Math.hypot(xy[0] - xyOf(S.settings.home)[0], xy[1] - xyOf(S.settings.home)[1]);
      const dof = Math.hypot(xy[0] - xyOf(S.settings.office)[0], xy[1] - xyOf(S.settings.office)[1]);
      startRide({ auto: true, dir: dh < dof ? "am" : "pm" });
    }
  }, () => { }, { enableHighAccuracy: true, maximumAge: 2000 });
}
function stopPassive() { if (PW.id != null) { navigator.geolocation.clearWatch(PW.id); PW.id = null; } }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { if (!R.on) startPassive(); } else if (!R.on) stopPassive(); });

/* ---------------- signals view ---------------- */
function renderSignals() {
  $("sAm").setAttribute("aria-pressed", S.sigPeriod === "am"); $("sPm").setAttribute("aria-pressed", S.sigPeriod === "pm");
  const ids = new Set();
  for (const k of Object.keys(S.sig)) if (k.startsWith(S.sigPeriod + "_")) ids.add(k.slice(3));
  const plan = S.plan[S.sigPeriod]; if (plan && plan[0]) for (const s of plan[0].r.signals) ids.add(s.id);
  const now = tod();
  const items = [...ids].map(id => { const rec = S.sig[sigKey(S.sigPeriod, id)]; return { id, n: rec ? rec.obs.length : 0, m: sigModel(S.sigPeriod, id), st: sigStats(S.sigPeriod, id) }; })
    .sort((a, b) => (b.m ? 1 : 0) - (a.m ? 1 : 0) || b.n - a.n);
  $("sigList").innerHTML = items.length ? items.map(({ id, n, m, st }) => {
    let state = "";
    if (m) { const L2 = lightAt(m, now); state = `<span class="dot" style="background:${L2.green ? "var(--go)" : "var(--stop)"}"></span>${L2.green ? "綠 " + Math.round(L2.left) : "紅 " + Math.round(L2.wait)} 秒`; }
    const status = m ? (m.src === "manual" ? `手動：週期 ${m.cycle} 秒、綠 ${m.green} 秒` : `已學會：週期 ${m.cycle} 秒（${m.n} 次，吻合 ${Math.round(m.R * 100)}%）`) : n ? `已觀察 ${n} 次，再 ${Math.max(0, 4 - n)} 次可推算` : "尚無資料";
    return `<button class="sig-row" data-id="${id}"><span style="min-width:0"><span class="nm">${esc(Graph.sigNameById(id))}</span><br><span class="st">${status}${st ? ` · 平均等 ${Math.round(st.avg)} 秒` : ""}</span></span><span class="st num">${state}</span></button>`;
  }).join("") : '<p class="note">設定家和公司後，這裡會列出路線上的號誌。</p>';
  $("sigList").querySelectorAll(".sig-row").forEach(b => b.onclick = () => { S.editSig = b.dataset.id; S.stamps = []; renderSigEdit(); $("sigEdit").scrollIntoView({ behavior: "smooth" }); });
  renderSigEdit();
}
function renderSigEdit() {
  const box = $("sigEdit"), id = S.editSig;
  if (!id) { box.hidden = true; return; }
  box.hidden = false; S.stamps = S.stamps || [];
  const rec = sigRec(S.sigPeriod, id), man = rec.manual || {};
  box.innerHTML = `<h2>${esc(Graph.sigNameById(id))}（${S.sigPeriod === "am" ? "早上" : "傍晚"}）</h2>
    <div class="row wrap"><label class="small">週期（秒）<br><input type="number" id="eC" inputmode="numeric" value="${man.cycle || ""}"></label>
    <label class="small">綠燈（秒）<br><input type="number" id="eG" inputmode="numeric" value="${man.green || ""}"></label>
    <label class="small">某次綠燈亮起<br><input type="time" id="eR" step="1" value="${man.ref || ""}"></label></div>
    <div class="row wrap"><button class="btn" id="eSave">儲存手動設定</button>${rec.manual ? '<button class="btn" id="eDelM">改回自動學習</button>' : ""}<button class="btn" id="eClr">清除 ${rec.obs.length} 筆觀察</button></div>
    <h2 style="margin-top:12px">現場碼表</h2>
    <div class="row"><button class="btn" id="eG1" style="flex:1;padding:14px;background:var(--go);color:var(--go-ink)">綠燈亮</button><button class="btn" id="eR1" style="flex:1;padding:14px;background:var(--stop);color:var(--stop-ink)">紅燈亮</button></div>
    <p class="small">${S.stamps.map(x => (x.k === "G" ? "綠 " : "紅 ") + clock(x.t, true)).join("　") || "停妥時燈號一變就按"}</p>
    <div class="row"><button class="btn" id="eApply" ${S.stamps.length < 2 ? "disabled" : ""}>帶入上面欄位</button></div>`;
  $("eG1").onclick = () => { S.stamps.push({ k: "G", t: tod() }); addObs(S.sigPeriod, id, { kind: "stamp", t: Math.round(tod()), date: dateStr() }); renderSigEdit(); };
  $("eR1").onclick = () => { S.stamps.push({ k: "R", t: tod() }); renderSigEdit(); };
  $("eApply").onclick = () => {
    const g = S.stamps.filter(x => x.k === "G").map(x => x.t);
    if (g.length >= 2) { const ds = g.slice(1).map((v, i) => v - g[i]).filter(d => d > 20); if (ds.length) { const c = Math.min(...ds); const n = ds.map(d => Math.max(1, Math.round(d / c))); $("eC").value = Math.round(ds.reduce((a, b) => a + b, 0) / n.reduce((a, b) => a + b, 0)); } }
    if (g.length) $("eR").value = clock(g[g.length - 1], true);
    for (let i = 0; i < S.stamps.length - 1; i++) if (S.stamps[i].k === "G" && S.stamps[i + 1].k === "R") $("eG").value = Math.round(S.stamps[i + 1].t - S.stamps[i].t);
  };
  $("eSave").onclick = () => {
    const c = +$("eC").value, gr = +$("eG").value, ref = $("eR").value;
    if (!(c >= 30 && c <= 300) || !(gr >= 5 && gr < c) || parseClock(ref) == null) { toast("請填週期 30～300 秒、綠燈小於週期，以及一次綠燈亮起時刻"); return; }
    rec.manual = { cycle: c, green: gr, ref: ref.length === 5 ? ref + ":00" : ref }; delete rec._m; save("signals", S.sig); toast("已儲存"); renderSignals();
  };
  const dm = $("eDelM"); if (dm) dm.onclick = () => { rec.manual = null; delete rec._m; save("signals", S.sig); renderSignals(); };
  $("eClr").onclick = () => { rec.obs = []; delete rec._m; save("signals", S.sig); renderSignals(); };
}

/* ---------------- records view ---------------- */
function renderRecords() {
  const H = S.settings.home, O = S.settings.office;
  $("placeVal").textContent = `家：${H ? "已設定" : "未設定"}　公司：${O ? "已設定" : "未設定"}`;
  $("optVoice").checked = !!S.settings.voice; $("optMotion").checked = !!S.settings.motion; $("optDeadline").value = S.settings.deadline || "09:00";
  const tr = S.trips;
  const by = d => tr.filter(t => t.dir === d && t.duration > 300).map(t => t.duration);
  $("tripStats").innerHTML = `<p class="small">共 ${tr.length} 趟（上班 ${by("am").length} 趟，中位數 ${by("am").length ? mins(median(by("am"))) : "—"} 分；下班 ${by("pm").length} 趟，中位數 ${by("pm").length ? mins(median(by("pm"))) : "—"} 分）。</p>`;
  $("tripList").innerHTML = tr.slice().reverse().slice(0, 60).map(t => `<button class="trip-row" data-id="${esc(t.id)}"><span style="min-width:0"><span class="nm">${t.date.slice(5).replace("-", "/")} ${DIRNAME[t.dir]} · ${clock(t.depart)} 出發</span><br>
    <span class="st">${t.partial ? "（未按結束，已自動保存）" : ""}${t.hasTrack ? `${(t.dist / 1000).toFixed(1)} km · 停 ${t.nStops} 次 · 行駛均速 ${t.vAvg || "—"} km/h${t.label ? " · " + esc(t.label) : ""}` : "只有時間軸紀錄（沒有詳細軌跡）"}</span></span>
    <span class="t num">${mins(t.duration)}<small class="small"> 分</small></span></button>`).join("");
  $("tripList").querySelectorAll(".trip-row").forEach(b => b.onclick = () => openTrip(b.dataset.id));
}

/* ---------------- trip detail ---------------- */
let tripMap;
const SPEED_BINS = [[0, 10, "#e5483d", "< 10"], [10, 20, "#f08a24", "10–20"], [20, 30, "#e6c229", "20–30"], [30, 45, "#5cc45a", "30–45"], [45, 999, "#2f8cff", "45 以上"]];
const binOf = kmh => SPEED_BINS.findIndex(b => kmh >= b[0] && kmh < b[1]);
async function openTrip(id) {
  const t = S.trips.find(x => x.id === id); if (!t) return;
  show("trip");
  $("tEyebrow").textContent = `${t.date} · ${DIRNAME[t.dir]}`;
  $("tTitle").textContent = `${clock(t.depart)} → ${clock(t.arrive)}`;
  const tr = t.hasTrack ? await DB.get(id) : null;
  if (!tripMap) {
    tripMap = mkMap("tripMap", { zoomCtl: true });
    tripMap.on("click", "t-stop", e => { const p = e.features[0].properties; new maplibregl.Popup({ offset: 12 }).setLngLat(e.lngLat).setHTML(`${esc(p.name)}<br>${p.time} 停 ${p.wait} 秒`).addTo(tripMap); });
  }
  await tripMap.ready; tripMap.resize();
  for (const id of ["t-track", "t-stop"]) setGeo(tripMap, id, fc([]));
  addLayer(tripMap, { id: "t-track-case", type: "line", source: "t-track", layout: ROUND, paint: { "line-color": "#ffffff", "line-width": 8 } });
  addLayer(tripMap, { id: "t-track", type: "line", source: "t-track", layout: ROUND, paint: { "line-color": ["get", "c"], "line-width": 5 } });
  addLayer(tripMap, { id: "t-stop", type: "circle", source: "t-stop", paint: { "circle-radius": ["get", "r"], "circle-color": "rgba(229,72,61,.9)", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
  addLayer(tripMap, { id: "t-stop-label", type: "symbol", source: "t-stop", layout: { "text-field": ["get", "wait"], "text-font": FONT, "text-size": 11, "text-allow-overlap": true }, paint: { "text-color": "#ffffff" } });
  if (!tr || !tr.pts || tr.pts.length < 5) {
    $("tStats").innerHTML = stat(mins(t.duration) + " 分", "門到門時間") + stat(clock(t.depart), "出發") + stat(clock(t.arrive), "抵達");
    $("tChart").innerHTML = '<p class="note">這趟來自 Google 時間軸，只有出發和抵達時間。用導航錄的趟次才有詳細軌跡。</p>';
    $("tStops").innerHTML = $("tRoads").innerHTML = $("tLegend").innerHTML = "";
    tripMap.jumpTo({ center: [121.525, 25.022], zoom: 12.5 });
    tripActions(t, null); return;
  }
  const a = analyzeTrack(tr.pts);
  const pts = tr.pts;
  $("tStats").innerHTML = stat(mmss(t.duration), "總時間") + stat((a.dist / 1000).toFixed(2) + " km", "距離") + stat(mmss(a.moving), "行駛時間")
    + stat(mmss(a.stopped), "停止時間") + stat(a.stops.length + " 次", "停下次數") + stat((a.moving ? a.dist / a.moving * 3.6 : 0).toFixed(1), "行駛均速 km/h")
    + stat((a.dist / t.duration * 3.6).toFixed(1), "全程均速 km/h") + stat(Math.round(a.vmax * 3.6), "最高速 km/h") + stat(pts.length, "GPS 點數");
  // track colored by speed
  const feats = []; let seg = [], bin = -1;
  for (let i = 0; i < pts.length; i++) {
    const b = binOf((pts[i][3] || 0) * 3.6), ll = [pts[i][2], pts[i][1]];
    if (b !== bin && seg.length) { seg.push(ll); feats.push(lineF(seg, { c: SPEED_BINS[bin][2] })); seg = []; }
    bin = b; seg.push(ll);
  }
  if (seg.length > 1) feats.push(lineF(seg, { c: SPEED_BINS[bin][2] }));
  setGeo(tripMap, "t-track", fc(feats));
  setGeo(tripMap, "t-stop", fc(a.stops.map(s => ptF([s.lon, s.lat], { r: Math.min(17, 9 + s.wait / 12), wait: String(s.wait), name: s.name || "非號誌處", time: clock(tod(new Date(s.t)), true) }))));
  fitTo(tripMap, pts.map(p => [p[2], p[1]]), 30);
  $("tLegend").innerHTML = SPEED_BINS.map(b => `<span><i style="background:${b[2]}"></i>${b[3]} km/h</span>`).join("") + '<span>紅圈數字＝停等秒數</span>';
  $("tChart").innerHTML = speedChart(pts, a.stops);
  $("tStops").innerHTML = a.stops.length ? `<table><thead><tr><th>時刻</th><th>地點</th><th class="r">停</th></tr></thead><tbody>${a.stops.map(s => `<tr><td class="num">${clock(tod(new Date(s.t)), true)}</td><td>${esc(s.name || "非號誌處（塞車或路邊）")}</td><td class="r num">${s.wait} 秒</td></tr>`).join("")}</tbody></table>
    <p class="small">號誌停等 ${a.stops.filter(s => s.sid).length} 次，共 ${mmss(a.stops.filter(s => s.sid).reduce((x, s) => x + s.wait, 0))}；經過的號誌路口 ${a.sigPassed.size} 個。</p>` : '<p class="small">這趟沒有停下來。</p>';
  $("tRoads").innerHTML = `<table><thead><tr><th>道路</th><th class="r">距離</th><th class="r">時間</th><th class="r">均速</th></tr></thead><tbody>${mergeRoads(a.roads).map(r => { const s = (r.t1 - r.t0) / 1000; return `<tr><td>${esc(r.name)}</td><td class="r num">${r.dist >= 1000 ? (r.dist / 1000).toFixed(1) + " km" : Math.round(r.dist) + " m"}</td><td class="r num">${mmss(s)}</td><td class="r num">${s > 0 ? (r.dist / s * 3.6).toFixed(0) : "—"}</td></tr>`; }).join("")}</tbody></table>`;
  tripActions(t, tr);
}
function mergeRoads(roads) { const out = []; for (const r of roads) { const l = out[out.length - 1]; if (l && l.name === r.name) { l.dist += r.dist; l.t1 = r.t1; } else out.push(Object.assign({}, r)); } return out.filter(r => r.dist > 40); }
const stat = (v, k) => `<div class="stat"><div class="v num">${v}</div><div class="k">${k}</div></div>`;
function speedChart(pts, stops) {
  const W = Math.max(600, pts.length * 0.6), H = 200, ml = 34, mr = 8, mt = 8, mb = 22;
  const t0 = pts[0][0], T = (pts[pts.length - 1][0] - t0) / 1000 || 1;
  const vmax = Math.max(50, ...pts.map(p => (p[3] || 0) * 3.6)) * 1.05;
  const X = t => ml + (t - t0) / 1000 / T * (W - ml - mr), Y = v => mt + (1 - v / vmax) * (H - mt - mb);
  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  const step = vmax > 150 ? 50 : vmax > 80 ? 20 : 10;
  for (let v = 0; v <= vmax; v += step) s += `<line class="gridl" x1="${ml}" x2="${W - mr}" y1="${Y(v)}" y2="${Y(v)}"/><text class="axis" x="${ml - 5}" y="${Y(v)}" dy=".35em" text-anchor="end">${v}</text>`;
  for (let m = 0; m <= T / 60; m += 2) s += `<text class="axis" x="${X(t0 + m * 60000)}" y="${H - 6}" text-anchor="middle">${m} 分</text>`;
  for (const st of stops) s += `<rect x="${X(st.t)}" y="${mt}" width="${Math.max(1, X(st.resume) - X(st.t))}" height="${H - mt - mb}" fill="#e5483d" opacity=".18"/>`;
  s += `<path d="M${pts.map(p => X(p[0]).toFixed(1) + " " + Y((p[3] || 0) * 3.6).toFixed(1)).join("L")}" fill="none" stroke="#3d8cf0" stroke-width="1.8" stroke-linejoin="round"/>`;
  return s + "</svg>";
}
function tripActions(t, tr) {
  $("tActions").innerHTML = `${tr ? '<button class="btn" id="tGpx">匯出這趟 GPX</button>' : ""}<span id="tDelBox"><button class="btn danger" id="tDel">刪除這趟</button></span>`;
  if (tr) $("tGpx").onclick = () => download(`${t.id}.gpx`, gpx([tr]), "application/gpx+xml");
  $("tDel").onclick = () => {
    $("tDelBox").innerHTML = '<span class="small">確定刪除？</span> <button class="btn danger" id="tDelY">刪除</button> <button class="btn" id="tDelN">取消</button>';
    $("tDelY").onclick = async () => { S.trips = S.trips.filter(x => x.id !== t.id); saveTrips(); await DB.del(t.id); await learnFromTracks(); S.plan = { am: null, pm: null }; show("set"); renderAll(); };
    $("tDelN").onclick = () => tripActions(t, tr);
  };
}

/* ---------------- home / office picker ---------------- */
let pickMap, pickMk = {}, pickWhich = "home", pickTmp = {};
async function openPicker() {
  pickTmp = { home: S.settings.home, office: S.settings.office };
  show("pick");
  if (!pickMap) {
    pickMap = mkMap("pickMap", { zoomCtl: true });
    pickMap.on("click", e => setPick(pickWhich, e.lngLat.lat, e.lngLat.lng));
  }
  await pickMap.ready; pickMap.resize();
  for (const k of ["home", "office"]) { if (pickMk[k]) { pickMk[k].remove(); pickMk[k] = null; } if (pickTmp[k]) setPick(k, pickTmp[k].lat, pickTmp[k].lon, true); }
  const pts = ["home", "office"].filter(k => pickTmp[k]).map(k => [pickTmp[k].lon, pickTmp[k].lat]);
  if (pts.length === 2) fitTo(pickMap, pts, 60); else if (pts.length) pickMap.jumpTo({ center: pts[0], zoom: 16 }); else pickMap.jumpTo({ center: [121.525, 25.022], zoom: 13 });
  setWhich(pickTmp.home ? (pickTmp.office ? "home" : "office") : "home");
}
function setWhich(k) { pickWhich = k; $("pkHome").setAttribute("aria-pressed", k === "home"); $("pkOffice").setAttribute("aria-pressed", k === "office"); $("pkMsg").textContent = `點地圖放置「${k === "home" ? "家" : "公司"}」，或拖曳圖釘微調。`; }
function setPick(k, lat, lon, quiet) {
  const xy = Graph.toXY(lat, lon);
  if (!Graph.nearEdges(xy[0], xy[1], 200, null).length) { toast("這個位置離可騎的道路太遠，或超出路網範圍（永和到中山區）"); if (pickMk[k] && pickTmp[k]) pickMk[k].setLngLat([pickTmp[k].lon, pickTmp[k].lat]); return; }
  pickTmp[k] = { lat, lon };
  if (pickMk[k]) pickMk[k].setLngLat([lon, lat]);
  else { pickMk[k] = new maplibregl.Marker({ element: pinEl(k), anchor: "bottom", draggable: true }).setLngLat([lon, lat]).addTo(pickMap); pickMk[k].on("dragend", () => { const p = pickMk[k].getLngLat(); setPick(k, p.lat, p.lng, true); }); }
  if (!quiet && k === "home" && !pickTmp.office) setWhich("office");
}
function pickHere() {
  if (!("geolocation" in navigator)) return;
  $("pkMsg").textContent = "定位中…";
  navigator.geolocation.getCurrentPosition(p => { setPick(pickWhich, p.coords.latitude, p.coords.longitude); pickMap.jumpTo({ center: [p.coords.longitude, p.coords.latitude], zoom: 17 }); $("pkMsg").textContent = "已放到目前位置，可拖曳微調"; },
    e => { $("pkMsg").textContent = e.code === 1 ? "沒有定位權限" : "定位失敗"; }, { enableHighAccuracy: true, timeout: 20000 });
}

/* ---------------- import / export ---------------- */
function download(name, text, type) {
  const blob = new Blob([text], { type });
  try { const file = new File([blob], name, { type }); if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: name }).catch(() => { }); return; } } catch (e) { }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
function gpx(tracks) {
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="綠波通勤" xmlns="http://www.topografix.com/GPX/1/1">` + tracks.map(tr => `<trk><name>${tr.id}</name><trkseg>${tr.pts.map(p => `<trkpt lat="${p[1]}" lon="${p[2]}">${p[6] != null ? `<ele>${p[6]}</ele>` : ""}<time>${new Date(p[0]).toISOString()}</time></trkpt>`).join("")}</trkseg></trk>`).join("") + "</gpx>";
}
async function exportGpx() { const t = (await DB.all()).filter(x => x.pts && x.pts.length); if (!t.length) { toast("還沒有錄到的軌跡"); return; } download(`commute-${dateStr()}.gpx`, gpx(t), "application/gpx+xml"); }
async function exportJson() { download(`commute-backup-${dateStr()}.json`, JSON.stringify({ app: "super-speed-commuters", v: 2, settings: S.settings, trips: S.trips, signals: S.sig, tracks: await DB.all() }), "application/json"); }
const parseLL = s => { const m = String(s).match(/(-?\d+(?:\.\d+)?)°?\s*,\s*(-?\d+(?:\.\d+)?)/); return m ? [+m[1], +m[2]] : null; };
function dirFor(pts) {
  const H = S.settings.home, O = S.settings.office, a = Graph.toXY(pts[0][1], pts[0][2]);
  if (H && O) { const h = xyOf(H), o = xyOf(O); return Math.hypot(a[0] - h[0], a[1] - h[1]) < Math.hypot(a[0] - o[0], a[1] - o[1]) ? "am" : "pm"; }
  return periodOf(tod(new Date(pts[0][0])));
}
async function importFiles(files) {
  const msgs = [];
  for (const f of files) {
    try {
      const txt = await f.text();
      if (/\.gpx$/i.test(f.name) || txt.includes("<gpx")) {
        const doc = new DOMParser().parseFromString(txt, "application/xml");
        let n = 0;
        for (const trk of doc.querySelectorAll("trk")) {
          const pts = [...trk.querySelectorAll("trkpt")].map(p => { const tm = p.querySelector("time"), el = p.querySelector("ele"); return [Date.parse(tm && tm.textContent), +p.getAttribute("lat"), +p.getAttribute("lon"), null, -1, 0, el ? +el.textContent : null, null]; }).filter(p => isFinite(p[0]));
          for (let i = 0; i < pts.length; i++) { const j = Math.max(0, i - 1), k = Math.min(pts.length - 1, i + 1); const a = Graph.toXY(pts[j][1], pts[j][2]), b = Graph.toXY(pts[k][1], pts[k][2]); const dt = (pts[k][0] - pts[j][0]) / 1000; pts[i][3] = dt > 0 ? +(Math.hypot(b[0] - a[0], b[1] - a[1]) / dt).toFixed(2) : 0; }
          if (pts.length < 30) continue;
          const d0 = new Date(pts[0][0]), dir = dirFor(pts);
          const tr = { id: dateStr(d0) + "_" + dir + "_" + pad(d0.getHours()) + pad(d0.getMinutes()), pts };
          await DB.put(tr); upsertTrip(summarize(tr, dir, "gpx", null)); n++;
        }
        msgs.push(`${f.name}：匯入 ${n} 趟軌跡`); continue;
      }
      const j = JSON.parse(txt);
      if (j && j.app === "super-speed-commuters") {
        S.settings = Object.assign(S.settings, j.settings || {}); saveSettings();
        for (const t of j.trips || []) if (!S.trips.some(x => x.id === t.id)) S.trips.push(t);
        S.trips.sort((a, b) => a.id < b.id ? -1 : 1); saveTrips();
        for (const [k, v] of Object.entries(j.signals || {})) { const cur = S.sig[k] || { obs: [], manual: null }; cur.obs = cur.obs.concat(v.obs || []).slice(-80); cur.manual = cur.manual || v.manual || null; S.sig[k] = cur; }
        save("signals", S.sig);
        const tr = Array.isArray(j.tracks) ? j.tracks : Object.entries(j.tracks || {}).map(([id, pts]) => ({ id, pts }));
        for (const t of tr) await DB.put(t);
        msgs.push(`${f.name}：已還原備份`); continue;
      }
      const segs = Array.isArray(j) ? j : (j.semanticSegments || []);
      const H = S.settings.home, O = S.settings.office;
      if (!H || !O) { msgs.push("請先設定家與公司，才能從時間軸找出通勤"); continue; }
      const hx = xyOf(H), ox = xyOf(O), visits = [];
      for (const s of segs) {
        const v = s.visit && s.visit.topCandidate; if (!v) continue;
        const ll = parseLL(v.placeLocation && (v.placeLocation.latLng || v.placeLocation)); if (!ll) continue;
        const xy = Graph.toXY(ll[0], ll[1]);
        visits.push({ place: Math.hypot(xy[0] - hx[0], xy[1] - hx[1]) < 200 ? "H" : Math.hypot(xy[0] - ox[0], xy[1] - ox[1]) < 200 ? "O" : null, t0: Date.parse(s.startTime), t1: Date.parse(s.endTime) });
      }
      visits.sort((a, b) => a.t0 - b.t0);
      let n = 0;
      for (let i = 0; i < visits.length - 1; i++) {
        const a = visits[i], b = visits[i + 1];
        if (!a.place || !b.place || a.place === b.place) continue;
        const dur = (b.t0 - a.t1) / 1000; if (dur < 300 || dur > 7200) continue;
        const t0 = new Date(a.t1), dir = a.place === "H" ? "am" : "pm"; if (t0.getDay() === 0 || t0.getDay() === 6) continue;
        const id = dateStr(t0) + "_" + dir + "_" + pad(t0.getHours()) + pad(t0.getMinutes());
        if (S.trips.some(x => x.id === id)) continue;
        S.trips.push({ id, date: dateStr(t0), dir, depart: Math.round(tod(t0)), arrive: Math.round(tod(new Date(b.t0))), duration: Math.round(dur), source: "timeline", hasTrack: false }); n++;
      }
      S.trips.sort((a, b) => a.id < b.id ? -1 : 1); saveTrips();
      msgs.push(`${f.name}：從時間軸新增 ${n} 趟通勤`);
    } catch (e) { msgs.push(`${f.name}：讀不懂這個檔案`); }
  }
  $("impMsg").textContent = msgs.join("；");
  await learnFromTracks(); S.plan = { am: null, pm: null }; renderAll();
}

/* ---------------- shell ---------------- */
let toastT;
function toast(t) { const el = $("toast"); el.textContent = t; el.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 3500); }
function show(v) {
  for (const id of ["plan", "ride", "sig", "set", "pick", "trip"]) $("v-" + id).hidden = id !== v;
  const tab = { plan: "plan", sig: "sig", set: "set", pick: "set", trip: "set" }[v];
  document.querySelectorAll("#tabs button").forEach(b => { if (b.dataset.v === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  if (v !== "ride") window.scrollTo(0, 0);
  if (v === "plan" && planMap) setTimeout(() => planMap.resize(), 50);
}
function renderAll() { renderPlan(); renderSignals(); renderRecords(); }

async function boot() {
  await DB.open();
  // migrate tracks kept in localStorage by the first version
  const old = load("tracks", null);
  if (old) { for (const [id, pts] of Object.entries(old)) await DB.put({ id, pts }); try { localStorage.removeItem(K + "tracks"); } catch (e) { } }
  try { await Graph.load("data/graph.json"); } catch (e) { document.body.innerHTML = "<p style='padding:24px'>路網資料載入失敗，請重新整理。</p>"; return; }
  $("dAm").onclick = () => { S.dir = "am"; renderPlan(); }; $("dPm").onclick = () => { S.dir = "pm"; renderPlan(); };
  $("sAm").onclick = () => { S.sigPeriod = "am"; S.editSig = null; renderSignals(); }; $("sPm").onclick = () => { S.sigPeriod = "pm"; S.editSig = null; renderSignals(); };
  $("startBtn").onclick = () => startRide(); $("rStop").onclick = () => finishRide(false); $("rStamp").onclick = stampGreen;
  $("rRecenter").onclick = () => setFollow(true);
  $("rOverview").onclick = () => { if (R.follow) overview(); else setFollow(true); };
  document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => { show(b.dataset.v); if (b.dataset.v === "sig") renderSignals(); if (b.dataset.v === "set") renderRecords(); });
  $("obSet").onclick = openPicker; $("openPicker").onclick = openPicker;
  $("pkHome").onclick = () => setWhich("home"); $("pkOffice").onclick = () => setWhich("office"); $("pkHere").onclick = pickHere;
  $("pkSave").onclick = () => { if (!pickTmp.home || !pickTmp.office) { toast("家和公司都要設定"); return; } S.settings.home = pickTmp.home; S.settings.office = pickTmp.office; saveSettings(); S.plan = { am: null, pm: null }; show("plan"); renderAll(); startPassive(); toast("已儲存家和公司"); };
  $("pkCancel").onclick = () => { show(S.settings.home ? "set" : "plan"); };
  $("tBack").onclick = () => { show("set"); renderRecords(); };
  $("optAuto").onchange = e => { S.settings.auto = e.target.checked; saveSettings(); if (S.settings.auto) startPassive(); else stopPassive(); };
  $("optVoice").onchange = e => { S.settings.voice = e.target.checked; saveSettings(); };
  $("optMotion").onchange = e => { S.settings.motion = e.target.checked; saveSettings(); };
  $("optDeadline").onchange = e => { S.settings.deadline = e.target.value || "09:00"; saveSettings(); renderPlan(); };
  $("expGpx").onclick = exportGpx; $("expJson").onclick = exportJson;
  $("impFile").onchange = e => { importFiles([...e.target.files]); e.target.value = ""; };
  $("clearAll").onclick = () => {
    $("clearBox").innerHTML = '<span class="small">確定刪除這支手機上的家、公司、紀錄、軌跡與號誌觀察？</span><button class="btn danger" id="clearYes">刪除</button><button class="btn" id="clearNo">取消</button>';
    $("clearYes").onclick = async () => { try { Object.keys(localStorage).filter(k => k.startsWith(K)).forEach(k => localStorage.removeItem(k)); } catch (e) { } await DB.clear(); location.reload(); };
    $("clearNo").onclick = () => location.reload();
  };
  renderAll();
  await repairTrips();
  learnFromTracks().then(() => { S.plan = { am: null, pm: null }; renderAll(); });
  startPassive();
  setInterval(() => { if (!R.on && !$("v-plan").hidden) renderPlan(); }, 30000);
  loadLive(); setInterval(() => { if (document.visibilityState === "visible") loadLive(); }, 60000);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { });
  window.__ssc = { S, R, G, LIVE, loadLive, fitCycle, sigModel, startRide, finishRide, analyzeTrack, learnFromTracks, DB, openTrip, onFix, computePlan };
}
boot();
})();
