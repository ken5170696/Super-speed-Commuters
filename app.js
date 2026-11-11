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
const MOE_COLOR = ["#2fc26b", "#f2b33a", "#e5483d"];
function liveOverlay(r, layer, w) {
  for (const e of r.edges) { const m = G.moe[e.de]; if (m < 0) continue; L.polyline(Graph.edgePtsLL(e.de), { color: MOE_COLOR[Math.min(2, m)], weight: w, opacity: .95, interactive: false }).addTo(layer); }
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

/* ---------------- maps ---------------- */
const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;
function baseLayer() {
  // OpenStreetMap standard tiles (no key). Dark mode darkens them with a CSS filter on the tile pane.
  return L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' });
}
function mkMap(id, opts = {}) {
  const m = L.map(id, Object.assign({ zoomControl: false, attributionControl: true }, opts));
  baseLayer().addTo(m); m.attributionControl.setPrefix(false);
  return m;
}
const llOf = (x, y) => Graph.toLL(x, y);
const geomLL = r => r.geom.map(p => llOf(p[0], p[1]));
const pinIcon = kind => L.divIcon({ className: "", html: `<div class="pin ${kind}"><span>${kind === "home" ? "家" : "公"}</span></div>`, iconSize: [30, 30], iconAnchor: [15, 30] });
let planMap, planLayer;
function renderPlanMap(plan) {
  if (!planMap) { planMap = mkMap("planMap"); planLayer = L.layerGroup().addTo(planMap); }
  planLayer.clearLayers();
  const H = S.settings.home, O = S.settings.office;
  if (!H || !O) { planMap.setView([25.02, 121.525], 13); return; }
  plan.forEach((o, i) => { if (i !== S.sel[S.dir]) L.polyline(geomLL(o.r), { color: ROUTE_COLORS[i % 5], weight: 4, opacity: .55 }).on("click", () => { S.sel[S.dir] = i; renderPlan(); }).addTo(planLayer); });
  const cur = plan[S.sel[S.dir]];
  if (cur) {
    L.polyline(geomLL(cur.r), { color: "#fff", weight: 9, opacity: .9 }).addTo(planLayer);
    L.polyline(geomLL(cur.r), { color: ROUTE_COLORS[S.sel[S.dir] % 5], weight: 6 }).addTo(planLayer);
    liveOverlay(cur.r, planLayer, 3);
    for (const s of cur.r.signals) L.circleMarker(llOf(s.x, s.y), { radius: 3.5, color: "#fff", weight: 1, fillColor: sigModel(S.dir, s.id) ? "#2fc26b" : "#7f8a92", fillOpacity: 1 }).bindTooltip(s.name).addTo(planLayer);
  }
  L.marker([H.lat, H.lon], { icon: pinIcon("home") }).addTo(planLayer);
  L.marker([O.lat, O.lon], { icon: pinIcon("office") }).addTo(planLayer);
  planMap.invalidateSize();
  planMap.fitBounds(L.latLngBounds([[H.lat, H.lon], [O.lat, O.lon]]).pad(.15));
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
let rideMap, rideRoute, rideDone, meMk, sigLayer;
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
  Object.assign(R, { on: true, dir, dest: xyOf(dest), route: chosen ? chosen.r : null, pts: [], said: {}, off: 0, lastReroute: 0, follow: true, stopStart: null, stopsLog: [], aMax: null, startT: Date.now(), id: null, pred: null, arriveT: null, lastSave: 0, reroutes: 0 });
  if (S.settings.motion && window.DeviceMotionEvent) {
    try { if (typeof DeviceMotionEvent.requestPermission === "function" && !opts.auto) await DeviceMotionEvent.requestPermission(); window.addEventListener("devicemotion", onMotion); } catch (e) { }
  }
  document.body.classList.add("riding"); show("ride");
  if (!rideMap) {
    rideMap = mkMap("rideMap", { zoomControl: false });
    sigLayer = L.layerGroup().addTo(rideMap);
    rideMap.on("dragstart", () => { R.follow = false; });
  }
  rideMap.invalidateSize();
  if (R.route) drawRideRoute();
  wakeLock();
  speak(opts.auto ? "偵測到你在騎車，已自動開始導航和記錄" : "開始導航");
  R.watch = navigator.geolocation.watchPosition(onFix, onGeoErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  R.tick = setInterval(() => { renderRide(); if (R.liveDirty) { R.liveDirty = false; R.lastBetter = 0; } checkBetterRoute(); }, 1000);
  renderRide();
}
function drawRideRoute() {
  const ll = geomLL(R.route);
  if (rideRoute) rideRoute.remove(); if (rideDone) rideDone.remove();
  rideRoute = L.polyline(ll, { color: "#3d8cf0", weight: 8, opacity: .95 }).addTo(rideMap);
  rideDone = L.polyline([], { color: "#6b7780", weight: 8, opacity: .9 }).addTo(rideMap);
  sigLayer.clearLayers();
  liveOverlay(R.route, sigLayer, 4);
  for (const s of R.route.signals) L.marker(llOf(s.x, s.y), { icon: L.divIcon({ className: "", html: `<div class="sigmk" style="background:${sigModel(R.dir, s.id) ? "#2fc26b" : "#9aa3a9"}"></div>`, iconSize: [12, 12] }) }).addTo(sigLayer);
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
  // route following & rerouting
  if (!R.route) reroute(fix, true);
  else {
    const pr = Graph.project(R.route, xy);
    R.d = pr.d; R.dist = pr.dist;
    if (pr.dist > Math.max(30, Math.min(60, fix.acc * 1.5))) R.off++; else R.off = 0;
    if (R.off >= 3 && Date.now() - R.lastReroute > 4000) reroute(fix, false);
  }
  detectStops(fix);
  R.last = fix;
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
const arrowSvg = k => `<svg viewBox="0 0 58 58"><path d="${ARROWS[k] || ARROWS.S}" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(1) + "<small>km</small>" : (m >= 100 ? Math.round(m / 50) * 50 : Math.max(10, Math.round(m / 10) * 10)) + "<small>m</small>"; }
function advise(s, distM, v) {
  const period = periodOf(tod());
  const m = sigModel(period, s.id), st = sigStats(period, s.id);
  if (!m) return { cls: "unk", text: s.name, sub: st ? `號誌未知 · 你在這停過 ${st.n} 次，平均 ${Math.round(st.avg)} 秒` : "號誌未知 · 停下時會自動學習" };
  const lt = distM > 150 ? Graph.timeAlong(R.route, R.d, R.d + distM) : null;
  const tArr = tod() + (lt != null ? lt : distM / Math.max(v, 4));
  const Lt = lightAt(m, tArr);
  const conf = m.src === "manual" ? "手動設定" : `已學習 ${m.n} 次`;
  if (Lt.green && Lt.left >= 3) return { cls: "go", text: "綠燈可過，保持", sub: `${s.name} · 抵達時還剩約 ${Math.round(Lt.left)} 秒 · ${conf}`, state: "go" };
  if (Lt.green) return { cls: "slow", text: "抵達時剛好轉黃", sub: `${s.name} · 準備停車 · ${conf}`, state: "stop" };
  const tg = tArr + Lt.wait - tod(), vNeed = distM / tg * 3.6;
  if (vNeed >= 15 && distM > 60) return { cls: "slow", text: `收油到 ${Math.round(vNeed)} km/h 免停`, sub: `${s.name} · 抵達時剛好轉綠 · ${conf}`, state: "slow", v: Math.round(vNeed) };
  return { cls: "stop", text: `紅燈，約等 ${Math.round(Lt.wait)} 秒`, sub: `${s.name} · ${conf}`, state: "stop" };
}
function renderRide() {
  if (!R.on) return;
  const f = R.last;
  if (!f) { $("rGps").textContent = "等待 GPS 定位…"; return; }
  $("rGps").textContent = `GPS ±${Math.round(f.acc)} m · ${R.pts.length} 點${R.stopsLog.length ? " · 停 " + R.stopsLog.length + " 次" : ""}${R.reroutes ? " · 重新規劃 " + R.reroutes + " 次" : ""}`;
  $("rSpeed").textContent = Math.round(f.v * 3.6);
  $("rStamp").disabled = !(f.v < 1);
  const ll = [f.lat, f.lon];
  const deg = f.hd == null ? 0 : f.hd * 180 / Math.PI;
  const html = f.hd == null ? '<div class="me nohead"><i></i></div>' : `<div class="me" style="transform:rotate(${deg}deg)"><i></i></div>`;
  if (!meMk) meMk = L.marker(ll, { icon: L.divIcon({ className: "", html, iconSize: [26, 26] }), zIndexOffset: 1000 }).addTo(rideMap);
  else { meMk.setLatLng(ll); meMk.setIcon(L.divIcon({ className: "", html, iconSize: [26, 26] })); }
  if (R.follow) rideMap.setView(ll, Math.max(rideMap.getZoom() || 17, 16), { animate: false });
  if (!R.route) { $("rManDist").innerHTML = "—"; $("rManRoad").textContent = "規劃路線中…"; return; }
  // traveled part
  if (rideDone) rideDone.setLatLngs(R.route.geom.filter(p => p[2] <= R.d).map(p => llOf(p[0], p[1])).concat([ll]));
  const r = R.route, d = R.d || 0;
  const man = $("rMan");
  man.classList.toggle("off", R.off >= 2);
  const t = r.turns.find(x => x.d > d + 3);
  const remainM = Math.max(0, r.distance - d);
  if (R.off >= 2) { $("rManIcon").innerHTML = arrowSvg("S"); $("rManDist").innerHTML = "偏離中"; $("rManRoad").textContent = "依你走的路重新規劃…"; }
  else if (t && t.d - d < 2000) {
    const dist = t.d - d;
    $("rManIcon").innerHTML = arrowSvg(t.dir);
    $("rManDist").innerHTML = fmtDist(dist);
    $("rManRoad").textContent = turnWord(t.dir) + " " + t.onto;
    if (dist < 320 && dist > 150) speak(`${Math.round(dist / 50) * 50}公尺後${turnWord(t.dir)}，${t.onto}`, "t1" + t.d);
    if (dist < 70) speak(`${turnWord(t.dir)}，${t.onto}`, "t2" + t.d);
  } else if (remainM < 150) { $("rManIcon").innerHTML = arrowSvg("F"); $("rManDist").innerHTML = fmtDist(remainM); $("rManRoad").textContent = "快到了"; }
  else {
    const seg = r.segs.find(s => s.to > d) || r.segs[r.segs.length - 1];
    $("rManIcon").innerHTML = arrowSvg("S"); $("rManDist").innerHTML = fmtDist(t ? t.d - d : remainM); $("rManRoad").textContent = "沿 " + (seg ? seg.name : "") + " 直行";
  }
  // next signal
  const s = r.signals.find(x => x.d > d + 8);
  const chip = $("rSig");
  if (s && s.d - d < 700 && R.off < 2) {
    const dist = s.d - d, a = advise(s, dist, f.v);
    chip.className = "sigchip " + (a.state === "go" ? "green" : a.state === "stop" ? "red" : a.state === "slow" ? "slow" : "");
    chip.innerHTML = `<div class="a"><span class="num">${Math.round(dist / 10) * 10} m</span> <span class="adv-${a.cls}">${esc(a.text)}</span></div><div class="b">${esc(a.sub)}</div>`;
    if (a.state && dist < 260 && dist > 110) speak(a.state === "go" ? "前方綠燈，保持" : a.state === "slow" ? `前方紅燈，收油到 ${a.v}` : "前方紅燈", "s" + s.id + a.state);
  } else { chip.className = "sigchip"; chip.innerHTML = ""; }
  // ETA
  const rem = routeTime(r, d, R.dir) * calibFactor(R.dir);
  const arr = tod() + rem;
  let late = "";
  const dl = parseClock(S.settings.deadline) || 32400;
  if (R.dir === "am" && tod() > dl - 4 * 3600 && tod() < dl + 3600) late = arr > dl ? ` <span class="pill late">晚 ${Math.ceil((arr - dl) / 60)} 分</span>` : ' <span class="pill ok">準時</span>';
  $("rEta").innerHTML = clock(arr) + late;
  $("rRemain").textContent = `剩 ${(remainM / 1000).toFixed(1)} km · ${mins(rem)} 分`;
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
    <span class="st">${t.hasTrack ? `${(t.dist / 1000).toFixed(1)} km · 停 ${t.nStops} 次 · 行駛均速 ${t.vAvg || "—"} km/h${t.label ? " · " + esc(t.label) : ""}` : "只有時間軸紀錄（沒有詳細軌跡）"}</span></span>
    <span class="t num">${mins(t.duration)}<small class="small"> 分</small></span></button>`).join("");
  $("tripList").querySelectorAll(".trip-row").forEach(b => b.onclick = () => openTrip(b.dataset.id));
}

/* ---------------- trip detail ---------------- */
let tripMap, tripLayer;
const SPEED_BINS = [[0, 10, "#e5483d", "< 10"], [10, 20, "#f08a24", "10–20"], [20, 30, "#e6c229", "20–30"], [30, 45, "#5cc45a", "30–45"], [45, 999, "#2f8cff", "45 以上"]];
const binOf = kmh => SPEED_BINS.findIndex(b => kmh >= b[0] && kmh < b[1]);
async function openTrip(id) {
  const t = S.trips.find(x => x.id === id); if (!t) return;
  show("trip");
  $("tEyebrow").textContent = `${t.date} · ${DIRNAME[t.dir]}`;
  $("tTitle").textContent = `${clock(t.depart)} → ${clock(t.arrive)}`;
  const tr = t.hasTrack ? await DB.get(id) : null;
  if (!tripMap) { tripMap = mkMap("tripMap", { zoomControl: true }); tripLayer = L.layerGroup().addTo(tripMap); }
  tripLayer.clearLayers(); tripMap.invalidateSize();
  if (!tr || !tr.pts || tr.pts.length < 5) {
    $("tStats").innerHTML = stat(mins(t.duration) + " 分", "門到門時間") + stat(clock(t.depart), "出發") + stat(clock(t.arrive), "抵達");
    $("tChart").innerHTML = '<p class="note">這趟來自 Google 時間軸，只有出發和抵達時間。用導航錄的趟次才有詳細軌跡。</p>';
    $("tStops").innerHTML = $("tRoads").innerHTML = $("tLegend").innerHTML = "";
    tripMap.setView([25.02, 121.525], 13);
    tripActions(t, null); return;
  }
  const a = analyzeTrack(tr.pts);
  const pts = tr.pts;
  $("tStats").innerHTML = stat(mmss(t.duration), "總時間") + stat((a.dist / 1000).toFixed(2) + " km", "距離") + stat(mmss(a.moving), "行駛時間")
    + stat(mmss(a.stopped), "停止時間") + stat(a.stops.length + " 次", "停下次數") + stat((a.moving ? a.dist / a.moving * 3.6 : 0).toFixed(1), "行駛均速 km/h")
    + stat((a.dist / t.duration * 3.6).toFixed(1), "全程均速 km/h") + stat(Math.round(a.vmax * 3.6), "最高速 km/h") + stat(pts.length, "GPS 點數");
  // track colored by speed
  let seg = [], bin = -1;
  for (let i = 0; i < pts.length; i++) {
    const b = binOf((pts[i][3] || 0) * 3.6), ll = [pts[i][1], pts[i][2]];
    if (b !== bin && seg.length) { seg.push(ll); L.polyline(seg, { color: SPEED_BINS[bin][2], weight: 6, opacity: .95 }).addTo(tripLayer); seg = []; }
    bin = b; seg.push(ll);
  }
  if (seg.length > 1) L.polyline(seg, { color: SPEED_BINS[bin][2], weight: 6 }).addTo(tripLayer);
  for (const s of a.stops) {
    const r = Math.min(34, 18 + s.wait / 6);
    L.marker([s.lat, s.lon], { icon: L.divIcon({ className: "", html: `<div class="stopmk" style="width:${r}px;height:${r}px">${s.wait}</div>`, iconSize: [r, r] }) })
      .bindPopup(`${esc(s.name || "非號誌處")}<br>${clock(tod(new Date(s.t)), true)} 停 ${s.wait} 秒`).addTo(tripLayer);
  }
  tripMap.fitBounds(L.latLngBounds(pts.map(p => [p[1], p[2]])).pad(.08));
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
function openPicker() {
  pickTmp = { home: S.settings.home, office: S.settings.office };
  show("pick");
  if (!pickMap) {
    pickMap = mkMap("pickMap", { zoomControl: true });
    pickMap.on("click", e => setPick(pickWhich, e.latlng.lat, e.latlng.lng));
  }
  pickMap.invalidateSize();
  for (const k of ["home", "office"]) { if (pickMk[k]) { pickMk[k].remove(); pickMk[k] = null; } if (pickTmp[k]) setPick(k, pickTmp[k].lat, pickTmp[k].lon, true); }
  const pts = ["home", "office"].filter(k => pickTmp[k]).map(k => [pickTmp[k].lat, pickTmp[k].lon]);
  if (pts.length === 2) pickMap.fitBounds(pts, { padding: [40, 40] }); else if (pts.length) pickMap.setView(pts[0], 16); else pickMap.setView([25.022, 121.525], 13);
  setWhich(pickTmp.home ? (pickTmp.office ? "home" : "office") : "home");
}
function setWhich(k) { pickWhich = k; $("pkHome").setAttribute("aria-pressed", k === "home"); $("pkOffice").setAttribute("aria-pressed", k === "office"); $("pkMsg").textContent = `點地圖放置「${k === "home" ? "家" : "公司"}」，或拖曳圖釘微調。`; }
function setPick(k, lat, lon, quiet) {
  const xy = Graph.toXY(lat, lon);
  const near = Graph.nearEdges(xy[0], xy[1], 200, null);
  if (!near.length) { toast("這個位置離可騎的道路太遠，或超出路網範圍（永和到中山區）"); return; }
  pickTmp[k] = { lat, lon };
  if (pickMk[k]) pickMk[k].setLatLng([lat, lon]);
  else { pickMk[k] = L.marker([lat, lon], { icon: pinIcon(k), draggable: true }).addTo(pickMap); pickMk[k].on("dragend", e => { const p = e.target.getLatLng(); setPick(k, p.lat, p.lng, true); }); }
  if (!quiet && k === "home" && !pickTmp.office) setWhich("office");
}
function pickHere() {
  if (!("geolocation" in navigator)) return;
  $("pkMsg").textContent = "定位中…";
  navigator.geolocation.getCurrentPosition(p => { setPick(pickWhich, p.coords.latitude, p.coords.longitude); pickMap.setView([p.coords.latitude, p.coords.longitude], 17); $("pkMsg").textContent = "已放到目前位置，可拖曳微調"; },
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
  if (v === "plan" && planMap) setTimeout(() => planMap.invalidateSize(), 50);
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
  $("rRecenter").onclick = () => { R.follow = true; if (R.last) rideMap.setView([R.last.lat, R.last.lon], 17); };
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
  learnFromTracks().then(() => { S.plan = { am: null, pm: null }; renderAll(); });
  startPassive();
  setInterval(() => { if (!R.on && !$("v-plan").hidden) renderPlan(); }, 30000);
  loadLive(); setInterval(() => { if (document.visibilityState === "visible") loadLive(); }, 60000);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { });
  window.__ssc = { S, R, G, LIVE, loadLive, fitCycle, sigModel, startRide, finishRide, analyzeTrack, learnFromTracks, DB, openTrip, onFix, computePlan };
}
boot();
})();
