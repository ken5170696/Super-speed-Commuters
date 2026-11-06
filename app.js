/* 綠波通勤 — live commute navigation with signal learning.
   Everything personal (home, office, tracks, signal observations) stays in this phone's localStorage. */
(function () {
"use strict";

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pad = n => String(n).padStart(2, "0");
const mod = (a, n) => ((a % n) + n) % n;
const DIRNAME = { am: "上班", pm: "下班" };

/* ---------------- storage ---------------- */
const K = "ssc.";
function load(k, d) { try { const v = localStorage.getItem(K + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function save(k, v) { try { localStorage.setItem(K + k, JSON.stringify(v)); return true; } catch (e) { toast("手機儲存空間不足，請到「紀錄」匯出後清除舊軌跡"); return false; } }
const S = {
  data: null,
  settings: Object.assign({ voice: true, record: true, deadline: "09:00", home: null, office: null }, load("settings", {})),
  trips: load("trips", []),          // summaries
  sig: load("signals", {}),          // key `${period}_${sid}` -> {obs:[], manual:null}
  dir: new Date().getHours() < 13 ? "am" : "pm",
  sel: { am: null, pm: null },
  sigPeriod: new Date().getHours() < 13 ? "am" : "pm",
  editSig: null, stamps: [],
};
function saveSettings() { save("settings", S.settings); }

/* ---------------- time helpers ---------------- */
const tod = (d = new Date()) => d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
function clock(sec, withSec) { sec = mod(Math.round(sec), 86400); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60; return pad(h) + ":" + pad(m) + (withSec ? ":" + pad(s) : ""); }
function parseClock(v) { if (!v) return null; const p = v.split(":").map(Number); if (p.some(isNaN)) return null; return p[0] * 3600 + (p[1] || 0) * 60 + (p[2] || 0); }
const mins = s => Math.round(s / 60);
const dateStr = (d = new Date()) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const periodOf = sec => (sec < 13 * 3600 ? "am" : "pm");

/* ---------------- geometry ---------------- */
let P;
const toXY = (lat, lon) => [(lon - P.lon0) * P.kx, (lat - P.lat0) * P.ky];
const dxy = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function project(route, p) {
  let best = { dist: 1e18, d: 0 };
  const g = route.geom;
  for (let i = 0; i < g.length - 1; i++) {
    const a = g[i], b = g[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9;
    let u = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2; u = Math.max(0, Math.min(1, u));
    const dist = Math.hypot(a[0] + u * dx - p[0], a[1] + u * dy - p[1]);
    if (dist < best.dist) best = { dist, d: a[2] + u * (b[2] - a[2]), bearing: Math.atan2(dx, dy) };
  }
  return best;
}
const routesOf = dir => S.data.routes.filter(r => r.dir === dir);
const routeById = id => S.data.routes.find(r => r.id === id);

/* ---------------- time model ---------------- */
const PRIOR = { major: { C: 140, g: .55 }, minor: { C: 140, g: .42 }, crossing: { C: 90, g: .72 } };
function prior(s) { return s.kind === "crossing" ? PRIOR.crossing : (s.major ? PRIOR.major : PRIOR.minor); }
function expDelay(s) { const p = prior(s); const r = p.C * (1 - p.g); return r * r / (2 * p.C) + 4 * (r / p.C) + (s.twoStage ? 35 : 0); }
function segSpeed(s) { const lim = Math.min(s.limit, 50); return (s.limit <= 30 ? lim * .75 : lim) / 3.6; }
function travel(r, d0, d1) { let t = 0; for (const s of r.segs) { const a = Math.max(d0, s.from), b = Math.min(d1, s.to); if (b > a) t += (b - a) / segSpeed(s); } return t; }
function calib(dir) {
  // learn from this phone's trips when there are enough, else the factor fitted on the Timeline history
  const ts = S.trips.filter(t => t.dir === dir && t.routeId && t.duration > 300);
  if (ts.length >= 3) { const f = ts.map(t => t.duration / routeById(t.routeId).baseSec).sort((a, b) => a - b); return f[Math.floor(f.length / 2)]; }
  return (S.data.calib && S.data.calib[dir]) || .8;
}
function routeTrips(r) { return S.trips.filter(t => t.routeId === r.id && t.duration > 300).map(t => t.duration).sort((a, b) => a - b); }
function estimate(r) {
  const ts = routeTrips(r);
  let base, basis;
  if (ts.length >= 3) { base = ts[Math.floor(ts.length / 2)]; basis = "你的 " + ts.length + " 趟中位數"; }
  else { base = r.baseSec * calib(r.dir); basis = "校正估計"; }
  return { sec: base, base, basis, p80: ts.length >= 5 ? ts[Math.floor(.8 * (ts.length - 1))] : base * 1.15 };
}
function remaining(r, d) {
  if (PROF && PROF.vAll) {
    const a = Math.max(d, r.start);
    const mv = learnedTime(r, a, r.end) + Math.max(0, r.distance - Math.max(d, r.end)) / PROF.vAll + Math.max(0, r.start - d) / PROF.vAll;
    const sd = r.signals.filter(s => s.d > d + 5).reduce((acc, s) => { const l = learnedDelay(s, r.dir); return acc + (l != null ? l : expDelay(s) * calib(r.dir)); }, 0);
    return mv + sd;
  }
  const f = calib(r.dir);
  const mv = travel(r, Math.max(d, r.start), r.end) / .85 + Math.max(0, r.distance - Math.max(d, r.end)) / (20 / 3.6);
  const sd = r.signals.filter(s => s.d > d + 5).reduce((a, s) => a + expDelay(s), 0);
  return (mv + sd) * f;
}

/* ---------------- learned riding profile (from GPS tracks recorded on this phone) ---------------- */
const BIN = 100;
let PROF = null;
function median(a) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
function buildProfile() {
  const tracks = load("tracks", {});
  const bins = {}, passes = {}, allV = [];
  for (const [id, pts] of Object.entries(tracks)) {
    if (!pts || pts.length < 60) continue;
    const dir = periodOf(tod(new Date(pts[0][0])));
    // pick the candidate route this track follows best
    let best = null;
    for (const r of routesOf(dir)) {
      let ok = 0, n = 0;
      for (let i = 0; i < pts.length; i += 15) { n++; if (project(r, toXY(pts[i][1], pts[i][2])).dist < 40) ok++; }
      if (!best || ok / n > best.f) best = { r, f: ok / n };
    }
    if (!best || best.f < .6) continue;
    const r = best.r, rb = bins[r.id] || (bins[r.id] = {});
    let prev = null, dmin = 1e9, dmax = -1;
    for (let i = 0; i < pts.length; i += 2) {
      const pr = project(r, toXY(pts[i][1], pts[i][2]));
      if (pr.dist > 40) { prev = null; continue; }
      const cur = { t: pts[i][0], d: pr.d };
      dmin = Math.min(dmin, pr.d); dmax = Math.max(dmax, pr.d);
      if (prev) {
        const dt = (cur.t - prev.t) / 1000, dd = cur.d - prev.d;
        if (dt > 0 && dt < 10 && dd > 0) {
          const v = dd / dt;
          if (v > 2 && v < 40) { const b = Math.floor((prev.d + cur.d) / 2 / BIN); (rb[b] || (rb[b] = [])).push(v); allV.push(v); }
        }
      }
      prev = cur;
    }
    for (const s of r.signals) if (s.d >= dmin && s.d <= dmax) { const k = sigKey(dir, s.id); passes[k] = (passes[k] || 0) + 1; }
  }
  const med = {};
  for (const [rid, rb] of Object.entries(bins)) { med[rid] = {}; for (const [b, vs] of Object.entries(rb)) if (vs.length >= 3) med[rid][b] = median(vs); }
  PROF = { bins: med, passes, vAll: median(allV), n: Object.keys(tracks).length };
  return PROF;
}
function profVel(r, b) { const m = PROF && PROF.bins[r.id]; return (m && m[b]) || (PROF && PROF.vAll) || null; }
function learnedTime(r, d0, d1) {
  if (!PROF || !PROF.vAll) return null;
  let t = 0;
  for (let d = d0; d < d1;) { const b = Math.floor(d / BIN); const e = Math.min(d1, (b + 1) * BIN); t += (e - d) / profVel(r, b); d = e; }
  return t;
}
function learnedDelay(s, period) {
  const k = sigKey(period, s.id), rec = S.sig[k], n = PROF && PROF.passes[k];
  if (!n || n < 2 || !rec) return null;
  const tot = rec.obs.filter(o => o.kind === "resume" && o.wait).reduce((a, o) => a + o.wait, 0);
  return tot / n;
}

/* ---------------- signal learning ---------------- */
function sigKey(period, sid) { return period + "_" + sid; }
function sigRec(period, sid) { const k = sigKey(period, sid); return S.sig[k] || (S.sig[k] = { obs: [], manual: null }); }
function addObs(period, sid, o) { const r = sigRec(period, sid); r.obs.push(o); if (r.obs.length > 60) r.obs.splice(0, r.obs.length - 60); r._m = null; save("signals", S.sig); }
function fitCycle(onsets) {
  let best = { R: 0, C: 0 }; const res = [];
  for (let C = 60; C <= 220; C += .5) {
    let sx = 0, sy = 0; for (const t of onsets) { const a = 2 * Math.PI * t / C; sx += Math.cos(a); sy += Math.sin(a); }
    const R = Math.hypot(sx, sy) / onsets.length; res.push({ C, R, ph: Math.atan2(sy, sx) });
    if (R > best.R) best = { C, R };
  }
  // prefer the longest cycle that fits almost as well (sub-multiples fit equally well)
  const ok = res.filter(x => x.R >= Math.max(.8, best.R * .93));
  if (!ok.length) return null;
  const pick = ok[ok.length - 1];
  return { C: pick.C, R: pick.R, ref: mod(pick.ph / (2 * Math.PI) * pick.C, pick.C) };
}
function sigModel(period, sid) {
  const rec = S.sig[sigKey(period, sid)];
  if (!rec) return null;
  if (rec.manual && rec.manual.cycle) return { cycle: rec.manual.cycle, green: rec.manual.green, ref: parseClock(rec.manual.ref), src: "manual", n: rec.obs.length };
  if (rec._m !== undefined && rec._m !== null) return rec._m || null;
  const on = rec.obs.filter(o => o.kind === "resume" || o.kind === "stamp").map(o => o.kind === "resume" ? o.t - 2 : o.t);
  if (on.length < 4) { rec._m = false; return null; }
  const f = fitCycle(on);
  if (!f) { rec._m = false; return null; }
  const waits = rec.obs.filter(o => o.kind === "resume" && o.wait).map(o => o.wait).sort((a, b) => a - b);
  let red = waits.length ? waits[Math.floor(.9 * (waits.length - 1))] + 3 : f.C * .45;
  red = Math.max(15, Math.min(f.C - 10, red));
  rec._m = { cycle: f.C, green: Math.round(f.C - red), ref: f.ref, src: "auto", n: on.length, R: f.R };
  return rec._m;
}
function lightAt(m, t) { const ph = mod(t - m.ref, m.cycle); return ph < m.green ? { green: true, left: m.green - ph } : { green: false, wait: m.cycle - ph }; }
function sigStats(period, sid) {
  const rec = S.sig[sigKey(period, sid)]; if (!rec) return null;
  const w = rec.obs.filter(o => o.kind === "resume" && o.wait).map(o => o.wait);
  return w.length ? { n: w.length, avg: w.reduce((a, b) => a + b, 0) / w.length } : null;
}

/* ---------------- plan view ---------------- */
function bestRoute(dir) { return routesOf(dir).map(r => ({ r, e: estimate(r) })).sort((a, b) => a.e.sec - b.e.sec)[0]; }
function curPlanRoute() { const id = S.sel[S.dir]; return id ? routeById(id) : bestRoute(S.dir).r; }
function renderPlan() {
  if (!S.data) return;
  $("dAm").setAttribute("aria-pressed", S.dir === "am"); $("dPm").setAttribute("aria-pressed", S.dir === "pm");
  const rows = routesOf(S.dir).map(r => ({ r, e: estimate(r) })).sort((a, b) => a.e.sec - b.e.sec);
  const cur = curPlanRoute(); const ce = estimate(cur);
  const now = tod(); const arrive = now + ce.sec;
  let deadlineLine = "";
  if (S.dir === "am" && now < (parseClock(S.settings.deadline) || 32400) + 1800) {
    const dl = parseClock(S.settings.deadline) || 9 * 3600;
    const latest = dl - ce.p80;
    const late = arrive > dl;
    deadlineLine = `<div class="line">${S.settings.deadline} 前到：最晚 <b class="num">${clock(latest)}</b> 出門 ${now > latest ? '<span class="pill late">已經來不及</span>' : now > latest - 300 ? '<span class="pill warn">快點出門</span>' : '<span class="pill ok">還有 ' + mins(latest - now) + ' 分</span>'}</div>`;
    if (late && now <= latest) deadlineLine += "";
  }
  $("planHero").innerHTML = `
    <div class="eyebrow">${DIRNAME[S.dir]} · 現在出發</div>
    <div class="big-num num">${clock(arrive)}<small>抵達</small></div>
    <div class="route">${esc(cur.label)}</div>
    <div class="line">約 <b class="num">${mins(ce.sec)}</b> 分鐘（${esc(ce.basis)}）</div>
    ${deadlineLine}`;
  $("planRoutes").innerHTML = rows.map(({ r, e }, i) => `
    <button class="ritem" data-id="${r.id}" aria-pressed="${r === cur}">
      <span style="min-width:0"><span class="nm">${esc(r.label)}</span> ${i === 0 ? '<span class="pill ok">最快</span>' : ""}<br>
      <span class="meta num">${(r.distance / 1000).toFixed(1)} km · ${r.signals.filter(s => s.kind === "junction").length} 路口${r.signals.some(s => s.twoStage) ? " · " + r.signals.filter(s => s.twoStage).length + " 處兩段左轉" : ""}</span></span>
      <span class="t num">${mins(e.sec)}<small>分</small></span></button>`).join("");
  $("planRoutes").querySelectorAll(".ritem").forEach(b => b.onclick = () => { S.sel[S.dir] = b.dataset.id; renderPlan(); });
  $("liveNote").textContent = routeTrips(cur).length >= 3 ? "時間依你在這支手機錄到的實際紀錄計算。" : "時間依過去 Google 時間軸紀錄校正的模型估計；用這個網頁導航幾趟後會改用你的實測。";
}

/* ---------------- ride engine ---------------- */
const R = { on: false, watch: null, wake: null, route: null, fixes: [], last: null, stopStart: null, stopXY: null, said: {}, lastSpeak: 0, offSince: null, startT: null, matchCount: {}, stopsLog: [], best: null, advice: null };
function speak(text, key) {
  if (!S.settings.voice || !("speechSynthesis" in window)) return;
  if (key) { if (R.said[key]) return; R.said[key] = 1; }
  try { const u = new SpeechSynthesisUtterance(text); u.lang = "zh-TW"; u.rate = 1.05; speechSynthesis.speak(u); } catch (e) { }
}
async function wakeLock() { try { if ("wakeLock" in navigator) R.wake = await navigator.wakeLock.request("screen"); } catch (e) { } }
document.addEventListener("visibilitychange", () => { if (R.on && document.visibilityState === "visible") wakeLock(); });

function startRide() {
  if (!("geolocation" in navigator)) { toast("這個瀏覽器不支援定位"); return; }
  Object.assign(R, { on: true, route: curPlanRoute(), fixes: [], last: null, stopStart: null, said: {}, offSince: null, startT: Date.now(), matchCount: {}, stopsLog: [], dir: S.dir });
  document.body.classList.add("riding"); show("ride");
  wakeLock();
  speak("開始導航，" + R.route.label.replace(/→/g, "，"));
  if ("speechSynthesis" in window) try { speechSynthesis.getVoices(); } catch (e) { }
  R.watch = navigator.geolocation.watchPosition(onFix, onGeoErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  R.tick = setInterval(renderRide, 1000);
  renderRide();
}
function onGeoErr(e) { $("rGps").textContent = e.code === 1 ? "沒有定位權限：請到手機設定允許這個網頁使用位置" : "GPS 訊號弱，等待定位…"; }
function onFix(pos) {
  const c = pos.coords, t = pos.timestamp || Date.now();
  const xy = toXY(c.latitude, c.longitude);
  let v = c.speed;
  if ((v == null || isNaN(v)) && R.last) { const dt = (t - R.last.t) / 1000; v = dt > 0 ? dxy(xy, R.last.xy) / dt : 0; }
  v = Math.max(0, v || 0);
  const fix = { t, lat: c.latitude, lon: c.longitude, xy, v, acc: c.accuracy };
  if (S.settings.record) R.fixes.push([t, +c.latitude.toFixed(6), +c.longitude.toFixed(6), +v.toFixed(1), Math.round(c.accuracy || 0)]);
  // route matching with stickiness
  let cur = project(R.route, xy);
  if (cur.dist > 45) {
    let alt = null;
    for (const r of routesOf(R.dir)) { const p = project(r, xy); if (p.dist < 30 && (!alt || p.dist < alt.p.dist)) alt = { r, p }; }
    if (alt && alt.r !== R.route) { R.route = alt.r; cur = alt.p; speak("已切換到 " + alt.r.label.split(" → ").slice(2, 4).join("，")); }
  }
  R.off = cur.dist > 45;
  R.pos = { ...fix, d: cur.d, dist: cur.dist };
  if (!R.off) R.matchCount[R.route.id] = (R.matchCount[R.route.id] || 0) + 1;
  detectStops(fix);
  R.last = fix;
  checkArrival(fix);
  renderRide();
}
function nearestSignalAt(d) {
  const r = R.route; let best = null;
  for (const s of r.signals) { const off = s.d - d; if (off > -20 && off < 45 && (!best || Math.abs(off) < Math.abs(best.d - d))) best = s; }
  return best;
}
function detectStops(f) {
  if (!R.pos || R.off) { R.stopStart = null; return; }
  if (f.v < 1.2) { if (!R.stopStart) { R.stopStart = f.t; R.stopD = R.pos.d; } }
  else if (f.v > 2.5 && R.stopStart) {
    const wait = (f.t - R.stopStart) / 1000;
    const s = nearestSignalAt(R.stopD);
    if (wait >= 4 && wait < 300 && s) {
      const now = new Date(f.t);
      addObs(periodOf(tod(now)), s.id, { kind: "resume", t: Math.round(tod(now)), wait: Math.round(wait), date: dateStr(now) });
      R.stopsLog.push({ sid: s.id, name: s.name, wait: Math.round(wait) });
    }
    R.stopStart = null;
  }
}
function checkArrival(f) {
  const dest = R.dir === "am" ? S.settings.office : S.settings.home;
  if (dest) {
    const dxyv = dxy(f.xy, toXY(dest.lat, dest.lon));
    if (dxyv < 80 && f.v < 1.5) { if (!R.arriveT) R.arriveT = f.t; if (f.t - R.arriveT > 15000) finishRide(true); }
    else R.arriveT = null;
  } else if (R.pos && R.pos.d >= R.route.end - 30 && f.v < 1) { if (!R.arriveT) R.arriveT = f.t; if (f.t - R.arriveT > 30000) finishRide(true); }
}
function advise(s, distM, v) {
  const period = periodOf(tod());
  const m = sigModel(period, s.id);
  const st = sigStats(period, s.id);
  if (!m) return { cls: "unk", text: "號誌未知", sub: st ? `你在這裡停過 ${st.n} 次，平均等 ${Math.round(st.avg)} 秒` : "停下時會自動記錄" };
  const vv = Math.max(v, 4);
  const lt = distM > 150 && R.route ? learnedTime(R.route, s.d - distM, s.d) : null;
  const tArr = tod() + (lt != null ? lt : distM / vv);
  const L = lightAt(m, tArr);
  const conf = m.src === "manual" ? "手動" : `學習 ${m.n} 次`;
  if (L.green && L.left >= 3) return { cls: "go", text: "綠燈可過，保持", sub: `抵達時綠燈還剩約 ${Math.round(L.left)} 秒 · ${conf}`, state: "go" };
  if (L.green) return { cls: "slow", text: "抵達時剛好轉黃", sub: "不用趕，準備停車 · " + conf, state: "stop" };
  const tg = tArr + L.wait - tod();
  const vNeed = distM / tg * 3.6;
  if (vNeed >= 15 && distM > 60) return { cls: "slow", text: `收油到 ${Math.round(vNeed)} km/h`, sub: `抵達時剛好轉綠，不用停車 · ${conf}`, state: "slow", v: Math.round(vNeed) };
  return { cls: "stop", text: `會遇紅燈，約等 ${Math.round(L.wait)} 秒`, sub: "放輕鬆，滑行到停止線 · " + conf, state: "stop" };
}
function renderRide() {
  if (!R.on) return;
  const now = new Date(); $("rClock").textContent = clock(tod(now));
  const p = R.pos, r = R.route;
  if (!p) { $("rGps").textContent = "等待 GPS 定位…"; return; }
  $("rGps").textContent = `GPS ±${Math.round(p.acc || 0)} m · 已記錄 ${R.fixes.length} 點${R.stopsLog.length ? " · 停等 " + R.stopsLog.length + " 次" : ""}`;
  const kmh = p.v * 3.6;
  $("rSpeed").textContent = Math.round(kmh);
  $("rRoute").textContent = r.label;
  $("rStamp").disabled = !(p.v < 1);
  // ETA
  const rem = remaining(r, p.d);
  const arr = tod(now) + rem;
  let etaTxt = `預計 ${clock(arr)} 到`;
  const dlx = parseClock(S.settings.deadline) || 32400;
  if (R.dir === "am" && tod(now) > dlx - 4 * 3600 && tod(now) < dlx + 3600) { const dl = dlx; const diff = Math.round((arr - dl) / 60); etaTxt += diff > 0 ? ` <span class="pill late">晚 ${diff} 分</span>` : ` <span class="pill ok">準時</span>`; }
  $("rEta").innerHTML = R.off ? "不在候選路線上" : etaTxt;
  // next signal
  const card = $("rSig");
  if (R.off) { $("rSigDist").innerHTML = "—"; $("rSigName").textContent = "偏離候選路線，回到路線後會繼續提示"; $("rAdv").innerHTML = ""; card.className = "sig-card"; }
  else {
    const s = r.signals.find(x => x.d > p.d + 8);
    if (!s) { $("rSigDist").innerHTML = Math.max(0, Math.round(r.end - p.d)) + "<small>m</small>"; $("rSigName").textContent = "前方沒有號誌，快到了"; $("rAdv").innerHTML = ""; card.className = "sig-card"; }
    else {
      const dist = s.d - p.d;
      $("rSigDist").innerHTML = (dist >= 1000 ? (dist / 1000).toFixed(1) + "<small>km</small>" : Math.round(dist / 10) * 10 + "<small>m</small>");
      $("rSigName").textContent = s.name + (s.kind === "crossing" ? "" : "");
      const a = advise(s, dist, p.v);
      $("rAdv").innerHTML = `<span class="adv-${a.cls}">${esc(a.text)}</span><span class="sub">${esc(a.sub)}</span>`;
      card.className = "sig-card " + (a.state === "go" ? "green" : a.state === "stop" ? "red" : "");
      if (dist < 260 && dist > 120 && a.state) {
        const say = a.state === "go" ? "前方綠燈，保持速度" : a.state === "slow" ? `前方紅燈，收油到 ${a.v}` : "前方紅燈，準備停車";
        speak(say, "sig" + s.id + a.state);
      }
    }
  }
  // next turn
  const t = r.turns.find(x => x.d > p.d + 5);
  if (t && t.d - p.d < 1500) {
    const dist = t.d - p.d; const sig = r.signals.find(s => Math.abs(s.d - t.d) < 30);
    const two = t.dir === "L" && sig && sig.twoStage;
    $("rTurn").innerHTML = `<span class="num">${Math.round(dist / 10) * 10} m</span> ${t.dir === "L" ? "左轉" : "右轉"} ${esc(t.onto)}${two ? ' <span class="two">· 兩段式左轉</span>' : ""}`;
    if (dist < 250 && dist > 100) speak(`${Math.round(dist / 50) * 50} 公尺後${t.dir === "L" ? "左轉" : "右轉"}，${t.onto}${two ? "，注意兩段式左轉" : ""}`, "turn" + t.d);
  } else $("rTurn").innerHTML = "<span class='small'>直行</span>";
}
function stampGreen() {
  if (!R.pos) return;
  const s = nearestSignalAt(R.pos.d) || R.route.signals.find(x => x.d > R.pos.d - 20);
  if (!s) { toast("附近沒有號誌"); return; }
  const now = new Date();
  addObs(periodOf(tod(now)), s.id, { kind: "stamp", t: Math.round(tod(now)), date: dateStr(now) });
  toast("已記錄：" + s.name + " 綠燈亮");
  R.stopStart = null; // avoid double counting this stop as a resume
}
function finishRide(auto) {
  if (!R.on) return;
  R.on = false; clearInterval(R.tick);
  if (R.watch != null) navigator.geolocation.clearWatch(R.watch);
  try { R.wake && R.wake.release(); } catch (e) { }
  document.body.classList.remove("riding");
  const f = R.fixes;
  if (f.length > 30) {
    const t0 = new Date(f[0][0]), t1 = new Date(f[f.length - 1][0]);
    const routeId = Object.entries(R.matchCount).sort((a, b) => b[1] - a[1])[0];
    const id = dateStr(t0) + "_" + R.dir + "_" + pad(t0.getHours()) + pad(t0.getMinutes());
    const trip = { id, date: dateStr(t0), dir: R.dir, depart: Math.round(tod(t0)), arrive: Math.round(tod(t1)), duration: Math.round((t1 - t0) / 1000), routeId: routeId && routeId[1] > 20 ? routeId[0] : null, stops: R.stopsLog, source: "nav" };
    S.trips = S.trips.filter(t => t.id !== id).concat(trip).sort((a, b) => a.id < b.id ? -1 : 1);
    save("trips", S.trips);
    const tracks = load("tracks", {}); tracks[id] = f;
    const keys = Object.keys(tracks).sort(); while (keys.length > 40) delete tracks[keys.shift()];
    if (!save("tracks", tracks)) { delete tracks[keys[0]]; save("tracks", tracks); }
    toast(`${auto ? "已抵達。" : ""}這趟 ${mins(trip.duration)} 分鐘，停等 ${R.stopsLog.length} 次，已存檔`);
    speak(auto ? `已抵達，這趟 ${mins(trip.duration)} 分鐘` : "導航結束");
  } else toast("導航結束（軌跡太短，沒有存檔）");
  buildProfile(); show("plan"); renderAll();
}

/* ---------------- signals view ---------------- */
function renderSignals() {
  if (!S.data) return;
  $("sAm").setAttribute("aria-pressed", S.sigPeriod === "am"); $("sPm").setAttribute("aria-pressed", S.sigPeriod === "pm");
  const seen = new Map();
  for (const r of routesOf(S.sigPeriod)) for (const s of r.signals) if (!seen.has(s.id)) seen.set(s.id, { s, routes: [r] }); else seen.get(s.id).routes.push(r);
  const now = tod();
  const items = [...seen.values()].map(({ s, routes }) => {
    const rec = S.sig[sigKey(S.sigPeriod, s.id)]; const m = sigModel(S.sigPeriod, s.id); const st = sigStats(S.sigPeriod, s.id);
    return { s, routes, n: rec ? rec.obs.length : 0, m, st };
  }).sort((a, b) => (b.m ? 1 : 0) - (a.m ? 1 : 0) || b.n - a.n || a.s.d - b.s.d);
  $("sigList").innerHTML = items.map(({ s, n, m, st }) => {
    let state = "";
    if (m) { const L = lightAt(m, now); state = `<span class="dot" style="background:${L.green ? "var(--go)" : "var(--stop)"}"></span>${L.green ? "綠 " + Math.round(L.left) : "紅 " + Math.round(L.wait)} 秒`; }
    const status = m ? (m.src === "manual" ? `手動：週期 ${m.cycle} 秒、綠 ${m.green} 秒` : `已學會：週期 ${m.cycle} 秒（${m.n} 次，吻合度 ${Math.round(m.R * 100)}%）`) : n ? `已觀察 ${n} 次，再 ${Math.max(0, 4 - n)} 次可推算` : "尚無資料";
    return `<button class="sig-row" data-id="${s.id}"><span style="min-width:0"><span class="nm">${esc(s.name)}</span><br><span class="st">${status}${st ? ` · 平均等 ${Math.round(st.avg)} 秒` : ""}</span></span><span class="st num">${state}</span></button>`;
  }).join("");
  $("sigList").querySelectorAll(".sig-row").forEach(b => b.onclick = () => { S.editSig = b.dataset.id; S.stamps = []; renderSigEdit(); $("sigEdit").scrollIntoView({ behavior: "smooth" }); });
  renderSigEdit();
}
function renderSigEdit() {
  const box = $("sigEdit");
  const s = S.data.routes.flatMap(r => r.signals).find(x => x.id === S.editSig);
  if (!s) { box.hidden = true; return; }
  box.hidden = false;
  const rec = sigRec(S.sigPeriod, s.id); const man = rec.manual || {};
  box.innerHTML = `<h2>${esc(s.name)}（${S.sigPeriod === "am" ? "早上" : "傍晚"}）</h2>
    <div class="row wrap"><label class="small">週期（秒）<br><input type="number" id="eC" inputmode="numeric" value="${man.cycle || ""}"></label>
    <label class="small">綠燈（秒）<br><input type="number" id="eG" inputmode="numeric" value="${man.green || ""}"></label>
    <label class="small">某次綠燈亮起<br><input type="time" id="eR" step="1" value="${man.ref || ""}"></label></div>
    <div class="row wrap"><button class="btn" id="eSave">儲存手動設定</button>${rec.manual ? '<button class="btn" id="eDelM">改回自動學習</button>' : ""}<button class="btn" id="eClr">清除 ${rec.obs.length} 筆觀察</button></div>
    <h2 style="margin-top:12px">現場碼表</h2><p class="note">停妥時燈號一變就按。按兩次以上「綠燈亮」就能算出週期。</p>
    <div class="row"><button class="btn" id="eG1" style="flex:1;padding:14px;background:var(--go);color:var(--go-ink)">綠燈亮</button><button class="btn" id="eR1" style="flex:1;padding:14px;background:var(--stop);color:var(--stop-ink)">紅燈亮</button></div>
    <p class="small">${S.stamps.map(x => (x.k === "G" ? "綠 " : "紅 ") + clock(x.t, true)).join("　") || "尚未按"}</p>
    <div class="row"><button class="btn" id="eApply" ${S.stamps.length < 2 ? "disabled" : ""}>帶入上面欄位</button></div>`;
  $("eG1").onclick = () => { S.stamps.push({ k: "G", t: tod() }); addObs(S.sigPeriod, s.id, { kind: "stamp", t: Math.round(tod()), date: dateStr() }); renderSigEdit(); };
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
    rec.manual = { cycle: c, green: gr, ref: ref.length === 5 ? ref + ":00" : ref }; rec._m = null; save("signals", S.sig); toast("已儲存"); renderSignals();
  };
  const dm = $("eDelM"); if (dm) dm.onclick = () => { rec.manual = null; rec._m = null; save("signals", S.sig); renderSignals(); };
  $("eClr").onclick = () => { rec.obs = []; rec._m = null; save("signals", S.sig); renderSignals(); };
}

/* ---------------- settings / import / export ---------------- */
function renderSettings() {
  const fmt = p => p ? `已設定（±${Math.round(p.acc || 0)} m）` : "尚未設定";
  $("homeVal").textContent = fmt(S.settings.home); $("officeVal").textContent = fmt(S.settings.office);
  $("optVoice").checked = !!S.settings.voice; $("optRecord").checked = !!S.settings.record; $("optDeadline").value = S.settings.deadline || "09:00";
  const tr = S.trips;
  const tracks = load("tracks", {});
  const by = d => tr.filter(t => t.dir === d);
  const med = a => { const s = a.map(t => t.duration).sort((x, y) => x - y); return s.length ? mins(s[Math.floor(s.length / 2)]) : "—"; };
  $("tripStats").innerHTML = `<p class="small">共 ${tr.length} 趟（上班 ${by("am").length}，中位數 ${med(by("am"))} 分；下班 ${by("pm").length}，中位數 ${med(by("pm"))} 分）。手機上存有 ${Object.keys(tracks).length} 條 GPS 軌跡${PROF && PROF.vAll ? `，你行進中的中位車速約 ${Math.round(PROF.vAll * 3.6)} km/h，到站時間和燈號預測都用這個速度剖面` : "；錄到軌跡後，到站時間和燈號預測會改用你實際的車速"}。</p>`;
  $("tripList").innerHTML = tr.length ? `<table><thead><tr><th>日期</th><th>方向</th><th>出發</th><th>花費</th><th>停等</th></tr></thead><tbody>${tr.slice(-12).reverse().map(t => `<tr><td class="num">${t.date.slice(5)}</td><td>${DIRNAME[t.dir]}</td><td class="num">${clock(t.depart)}</td><td class="num">${mins(t.duration)} 分</td><td class="num">${t.stops ? t.stops.length : "—"}</td></tr>`).join("")}</tbody></table>` : "";
}
function useCurrentAs(which) {
  if (!("geolocation" in navigator)) { toast("無法定位"); return; }
  toast("定位中…");
  navigator.geolocation.getCurrentPosition(p => {
    S.settings[which] = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
    saveSettings(); renderSettings(); toast(which === "home" ? "已設為家" : "已設為公司");
  }, e => toast(e.code === 1 ? "沒有定位權限" : "定位失敗，請到戶外再試"), { enableHighAccuracy: true, timeout: 20000 });
}
function download(name, text, type) {
  const blob = new Blob([text], { type });
  const file = new File([blob], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: name }).catch(() => { }); return; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
function exportGpx() {
  const tracks = load("tracks", {}); const ids = Object.keys(tracks).sort();
  if (!ids.length) { toast("還沒有導航錄下的軌跡"); return; }
  const segs = ids.map(id => `<trk><name>${id}</name><trkseg>${tracks[id].map(p => `<trkpt lat="${p[1]}" lon="${p[2]}"><time>${new Date(p[0]).toISOString()}</time></trkpt>`).join("")}</trkseg></trk>`).join("");
  download(`commute-${dateStr()}.gpx`, `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="綠波通勤" xmlns="http://www.topografix.com/GPX/1/1">${segs}</gpx>`, "application/gpx+xml");
}
function exportJson() { download(`commute-backup-${dateStr()}.json`, JSON.stringify({ app: "super-speed-commuters", v: 1, settings: S.settings, trips: S.trips, signals: S.sig, tracks: load("tracks", {}) }), "application/json"); }

function parseLL(s) { const m = String(s).match(/(-?\d+(?:\.\d+)?)°?\s*,\s*(-?\d+(?:\.\d+)?)/); return m ? [+m[1], +m[2]] : null; }
function tripsFromTimeline(j) {
  // Google Maps Timeline export (iOS list form or Android {semanticSegments}); uses visits at home/office.
  const segs = Array.isArray(j) ? j : (j.semanticSegments || []);
  const H = S.settings.home, O = S.settings.office;
  if (!H || !O) return { err: "請先設定家與公司，才能從時間軸找出通勤" };
  const hx = toXY(H.lat, H.lon), ox = toXY(O.lat, O.lon);
  const visits = [];
  for (const s of segs) {
    const v = s.visit && s.visit.topCandidate; if (!v) continue;
    const ll = parseLL(v.placeLocation && (v.placeLocation.latLng || v.placeLocation)); if (!ll) continue;
    const xy = toXY(ll[0], ll[1]); const place = dxy(xy, hx) < 200 ? "H" : dxy(xy, ox) < 200 ? "O" : null;
    visits.push({ place, t0: Date.parse(s.startTime), t1: Date.parse(s.endTime) });
  }
  visits.sort((a, b) => a.t0 - b.t0);
  const out = [];
  for (let i = 0; i < visits.length - 1; i++) {
    const a = visits[i], b = visits[i + 1];
    if (!a.place || !b.place || a.place === b.place) continue;
    const dur = (b.t0 - a.t1) / 1000; if (dur < 300 || dur > 7200) continue;
    const t0 = new Date(a.t1), dir = a.place === "H" ? "am" : "pm";
    const wd = t0.getDay(); if (wd === 0 || wd === 6) continue;
    out.push({ id: dateStr(t0) + "_" + dir + "_" + pad(t0.getHours()) + pad(t0.getMinutes()), date: dateStr(t0), dir, depart: Math.round(tod(t0)), arrive: Math.round(tod(new Date(b.t0))), duration: Math.round(dur), routeId: null, stops: null, source: "timeline" });
  }
  return { trips: out };
}
async function importFiles(files) {
  const msgs = [];
  for (const f of files) {
    try {
      const txt = await f.text();
      if (/\.gpx$/i.test(f.name) || txt.includes("<gpx")) {
        const doc = new DOMParser().parseFromString(txt, "application/xml");
        const pts = [...doc.querySelectorAll("trkpt")].map(p => [Date.parse(p.querySelector("time") && p.querySelector("time").textContent), +p.getAttribute("lat"), +p.getAttribute("lon"), 0, 0]).filter(p => isFinite(p[0]));
        const tracks = load("tracks", {}); const id = "import_" + dateStr(new Date(pts[0][0])) + "_" + pad(new Date(pts[0][0]).getHours()) + pad(new Date(pts[0][0]).getMinutes());
        tracks[id] = pts; save("tracks", tracks); msgs.push(`${f.name}：匯入 ${pts.length} 個軌跡點`);
        continue;
      }
      const j = JSON.parse(txt);
      if (j && j.app === "super-speed-commuters") {
        S.settings = Object.assign(S.settings, j.settings || {}); saveSettings();
        const ids = new Set(S.trips.map(t => t.id)); S.trips = S.trips.concat((j.trips || []).filter(t => !ids.has(t.id))); save("trips", S.trips);
        for (const [k, v] of Object.entries(j.signals || {})) { const cur = S.sig[k] || { obs: [], manual: null }; cur.obs = cur.obs.concat(v.obs || []).slice(-60); cur.manual = cur.manual || v.manual || null; cur._m = null; S.sig[k] = cur; }
        save("signals", S.sig);
        const tracks = Object.assign(load("tracks", {}), j.tracks || {}); save("tracks", tracks);
        msgs.push(`${f.name}：已還原備份`); continue;
      }
      const res = tripsFromTimeline(j);
      if (res.err) { msgs.push(res.err); continue; }
      const ids = new Set(S.trips.map(t => t.id)); const add = res.trips.filter(t => !ids.has(t.id));
      S.trips = S.trips.concat(add).sort((a, b) => a.id < b.id ? -1 : 1); save("trips", S.trips);
      msgs.push(`${f.name}：從時間軸找到 ${res.trips.length} 趟通勤，新增 ${add.length} 趟`);
    } catch (e) { msgs.push(`${f.name}：讀不懂這個檔案`); }
  }
  $("impMsg").textContent = msgs.join("；"); buildProfile(); renderAll();
}

/* ---------------- shell ---------------- */
let toastT;
function toast(t) { const el = $("toast"); el.textContent = t; el.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 3200); }
function show(v) {
  for (const id of ["plan", "ride", "sig", "set"]) $("v-" + id).hidden = id !== v;
  document.querySelectorAll("#tabs button").forEach(b => { if (b.dataset.v === v) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  window.scrollTo(0, 0);
}
function renderAll() { renderPlan(); renderSignals(); renderSettings(); }

async function boot() {
  try { S.data = await (await fetch("data/routes.json")).json(); } catch (e) { document.body.innerHTML = "<p style='padding:24px'>路線資料載入失敗，請重新整理。</p>"; return; }
  P = S.data.proj;
  $("dAm").onclick = () => { S.dir = "am"; renderPlan(); }; $("dPm").onclick = () => { S.dir = "pm"; renderPlan(); };
  $("sAm").onclick = () => { S.sigPeriod = "am"; S.editSig = null; renderSignals(); }; $("sPm").onclick = () => { S.sigPeriod = "pm"; S.editSig = null; renderSignals(); };
  $("startBtn").onclick = startRide; $("rStop").onclick = () => finishRide(false); $("rStamp").onclick = stampGreen;
  document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => { show(b.dataset.v); if (b.dataset.v === "sig") renderSignals(); });
  $("setHome").onclick = () => useCurrentAs("home"); $("setOffice").onclick = () => useCurrentAs("office");
  $("optVoice").onchange = e => { S.settings.voice = e.target.checked; saveSettings(); };
  $("optRecord").onchange = e => { S.settings.record = e.target.checked; saveSettings(); };
  $("optDeadline").onchange = e => { S.settings.deadline = e.target.value || "09:00"; saveSettings(); renderPlan(); };
  $("expGpx").onclick = exportGpx; $("expJson").onclick = exportJson;
  $("impFile").onchange = e => { importFiles([...e.target.files]); e.target.value = ""; };
  $("clearAll").onclick = () => {
    $("clearBox").innerHTML = '<span class="small">確定要刪除這支手機上的家、公司、紀錄、號誌觀察？</span><button class="btn danger" id="clearYes">刪除</button><button class="btn" id="clearNo">取消</button>';
    $("clearYes").onclick = () => { try { Object.keys(localStorage).filter(k => k.startsWith(K)).forEach(k => localStorage.removeItem(k)); } catch (e) { } location.reload(); };
    $("clearNo").onclick = () => location.reload();
  };
  buildProfile();
  renderAll();
  setInterval(() => { if (!R.on && !$("v-plan").hidden) renderPlan(); if (!$("v-sig").hidden) renderSignals(); }, 15000);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { });
  window.__ssc = { S, R, fitCycle, sigModel, estimate, onFix, startRide, finishRide, addObs };
}
boot();
})();
