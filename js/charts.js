"use strict";
/* ==========================================================================
   Canvas charts that read their colors from CSS tokens: multi-series line
   charts with legend, direct labels and a hover crosshair; scatter plots;
   and the CG strip.
   ========================================================================== */
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function sizeCanvas(cv) {
  const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(r.width * dpr)); cv.height = Math.max(1, Math.round(r.height * dpr));
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return {g, w: r.width, h: r.height};
}
function niceTicks(lo, hi, n = 4) {
  const span = hi - lo || 1, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map(s => s * mag).find(s => s >= step0 * 0.999);
  const ticks = []; for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-6; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}
const tickFmt = v => Math.abs(v) >= 100 || v % 1 === 0 ? fmtN(v) : Math.abs(v) >= 1 ? fmtN(v, 1) : fmtN(v, 2);

function frame(cv, xr, yr, opt) {
  const {g, w, h} = sizeCanvas(cv);
  const Lm = 42, Rm = opt.rightPad ?? 12, Tm = 12, Bm = 26;
  let [x0, x1] = xr, [y0, y1] = yr;
  if (y1 - y0 < 1e-9) { y1 += 1; y0 -= 1; }
  if (x1 - x0 < 1e-9) { x1 += 1; x0 -= 1; }
  const xt = niceTicks(x0, x1), yt = niceTicks(y0, y1);
  const X = v => Lm + (v - x0) / (x1 - x0) * (w - Lm - Rm), Y = v => h - Bm - (v - y0) / (y1 - y0) * (h - Tm - Bm);
  g.clearRect(0, 0, w, h);
  g.font = "10.5px 'IBM Plex Mono', ui-monospace, monospace"; g.lineWidth = 1;
  g.textAlign = "right"; g.textBaseline = "middle";
  for (const v of yt) { const y = Math.round(Y(v)) + 0.5; g.strokeStyle = css(v === 0 ? "--rule" : "--rule2"); g.beginPath(); g.moveTo(Lm, y); g.lineTo(w - Rm, y); g.stroke(); g.fillStyle = css("--muted"); g.fillText(tickFmt(v), Lm - 6, y); }
  g.textAlign = "center"; g.textBaseline = "top";
  for (const v of xt) g.fillText(tickFmt(v), X(v), h - Bm + 7);
  g.textAlign = "left"; g.fillText(opt.yLabel || "", Lm + 4, Tm - 2);
  g.textAlign = "right"; g.textBaseline = "bottom"; g.fillText(opt.xLabel || "", w - Rm, h - Bm - 3);
  return {g, w, h, X, Y, Lm, Rm, Tm, Bm, x0, x1, y0, y1};
}
function tipFor(wrap) {
  let tip = wrap.querySelector(".tip");
  if (!tip) { tip = document.createElement("div"); tip.className = "tip"; tip.hidden = true; wrap.appendChild(tip); }
  return tip;
}
function legendFor(wrap, series) {
  let lg = wrap.querySelector(".legend");
  if (series.length < 2) { if (lg) lg.remove(); return; }
  if (!lg) { lg = document.createElement("div"); lg.className = "legend"; wrap.insertBefore(lg, wrap.firstChild); }
  lg.innerHTML = series.map(s => `<span><i style="background:var(${s.color})${s.dash ? ";background:repeating-linear-gradient(90deg,var(" + s.color + ") 0 4px,transparent 4px 7px)" : ""}"></i>${esc(s.name)}</span>`).join("");
}
function interpSeries(pts, x) {
  if (!pts.length || x < pts[0][0] || x > pts[pts.length - 1][0]) return null;
  for (let i = 1; i < pts.length; i++) if (pts[i][0] >= x) { const a = pts[i - 1], b = pts[i], t = (x - a[0]) / ((b[0] - a[0]) || 1); return a[1] + t * (b[1] - a[1]); }
  return null;
}

/* Multi-series line chart */
function lineChart(cv, cfg, hoverX) {
  const wrap = cv.parentElement, series = cfg.series.filter(s => s.pts.length);
  legendFor(wrap, series);
  if (!series.length) { const {g, w, h} = sizeCanvas(cv); g.clearRect(0, 0, w, h); return; }
  const xs = series.flatMap(s => s.pts.map(p => p[0])), ys = series.flatMap(s => s.pts.map(p => p[1])).concat((cfg.markers || []).map(m => m.y));
  const F = frame(cv, [cfg.xMin ?? Math.min(...xs), cfg.xMax ?? Math.max(...xs)], [cfg.yMin ?? Math.min(...ys), cfg.yMax ?? Math.max(...ys) * (cfg.headroom || 1.06)], {...cfg, rightPad: series.length > 1 && cfg.directLabels !== false ? 58 : 12});
  const {g, X, Y} = F;
  g.save(); g.beginPath(); g.rect(F.Lm, F.Tm - 4, F.w - F.Lm - F.Rm + 2, F.h - F.Tm - F.Bm + 8); g.clip();
  for (const b of cfg.bands || []) { g.fillStyle = css(b.color); g.globalAlpha = b.alpha || 0.12; g.fillRect(X(b.x0), F.Tm, X(b.x1) - X(b.x0), F.h - F.Tm - F.Bm); g.globalAlpha = 1; }
  for (const s of series) {
    if (s.area) {
      g.beginPath(); s.pts.forEach((p, i) => (i ? g.lineTo : g.moveTo).call(g, X(p[0]), Y(p[1])));
      g.lineTo(X(s.pts[s.pts.length - 1][0]), Y(Math.max(F.y0, 0))); g.lineTo(X(s.pts[0][0]), Y(Math.max(F.y0, 0))); g.closePath();
      g.globalAlpha = 0.1; g.fillStyle = css(s.color); g.fill(); g.globalAlpha = 1;
    }
    g.beginPath(); s.pts.forEach((p, i) => (i ? g.lineTo : g.moveTo).call(g, X(p[0]), Y(p[1])));
    g.strokeStyle = css(s.color); g.lineWidth = 2; g.setLineDash(s.dash ? [5, 4] : []); g.stroke(); g.setLineDash([]);
  }
  for (const v of cfg.vlines || []) {
    g.strokeStyle = css("--muted"); g.setLineDash([3, 3]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(X(v.x) + 0.5, F.Tm); g.lineTo(X(v.x) + 0.5, F.h - F.Bm); g.stroke(); g.setLineDash([]);
    g.fillStyle = css("--ink2"); g.font = "11px Barlow, sans-serif"; g.textAlign = "left"; g.textBaseline = "top"; g.fillText(v.label, X(v.x) + 4, F.Tm + 2);
  }
  g.restore();
  for (const m of cfg.markers || []) {
    g.beginPath(); g.arc(X(m.x), Y(m.y), 4.5, 0, Math.PI * 2); g.fillStyle = css("--raise"); g.fill();
    g.lineWidth = 2; g.strokeStyle = css(m.color || "--s2"); g.stroke();
    g.fillStyle = css("--ink2"); g.font = "11px Barlow, sans-serif"; g.textAlign = "center"; g.textBaseline = m.below ? "top" : "bottom";
    g.fillText(m.label, Math.min(F.w - F.Rm - 16, Math.max(F.Lm + 16, X(m.x))), Y(m.y) + (m.below ? 8 : -8));
  }
  if (series.length > 1 && cfg.directLabels !== false) {                   // direct labels at line ends, nudged apart
    const ends = series.map(s => ({s, y: Y(s.pts[s.pts.length - 1][1])})).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12;
    g.font = "11px Barlow, sans-serif"; g.textAlign = "left"; g.textBaseline = "middle"; g.fillStyle = css("--ink2");
    for (const e of ends) g.fillText(e.s.short || e.s.name, F.w - F.Rm + 6, Math.min(F.h - F.Bm, Math.max(F.Tm, e.y)));
  }
  if (hoverX != null) {
    g.strokeStyle = css("--muted"); g.lineWidth = 1; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(X(hoverX) + 0.5, F.Tm); g.lineTo(X(hoverX) + 0.5, F.h - F.Bm); g.stroke(); g.setLineDash([]);
    for (const s of series) { const y = interpSeries(s.pts, hoverX); if (y == null) continue; g.beginPath(); g.arc(X(hoverX), Y(y), 3.5, 0, Math.PI * 2); g.fillStyle = css(s.color); g.fill(); }
  }
  const tip = tipFor(wrap);
  cv.onpointermove = e => {
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left;
    if (mx < F.Lm || mx > F.w - F.Rm) { tip.hidden = true; lineChart(cv, cfg); return; }
    const xv = F.x0 + (mx - F.Lm) / (F.w - F.Lm - F.Rm) * (F.x1 - F.x0);
    const near = series[0].pts.reduce((b, p) => Math.abs(p[0] - xv) < Math.abs(b[0] - xv) ? p : b, series[0].pts[0])[0];
    lineChart(cv, cfg, near);
    const vals = series.map(s => { const y = interpSeries(s.pts, near); return y == null ? null : `${s.short || s.name} ${(cfg.fmtY || tickFmt)(y)}`; }).filter(Boolean);
    tip.textContent = `${(cfg.fmtX || tickFmt)(near)}${cfg.xUnit ? " " + cfg.xUnit : ""} · ${vals.join(" · ")}${cfg.tipExtra ? cfg.tipExtra(near) : ""}`;
    tip.hidden = false;
    const ty = Math.min(...series.map(s => interpSeries(s.pts, near)).filter(v => v != null).map(Y));
    tip.style.left = Math.min(r.width - 90, Math.max(90, X(near))) + "px"; tip.style.top = (isFinite(ty) ? ty : F.Tm) + (wrap.querySelector(".legend")?.offsetHeight || 0) - 6 + "px";
  };
  cv.onpointerleave = () => { tip.hidden = true; lineChart(cv, cfg); };
}

/* Scatter with one highlighted point */
function scatterChart(cv, cfg) {
  const wrap = cv.parentElement, pts = cfg.pts;
  if (!pts.length) { const {g, w, h} = sizeCanvas(cv); g.clearRect(0, 0, w, h); return; }
  const F = frame(cv, [Math.min(...pts.map(p => p[0])), Math.max(...pts.map(p => p[0]))], [0, Math.max(...pts.map(p => p[1])) * 1.08], cfg);
  const {g, X, Y} = F;
  g.fillStyle = css("--s1"); g.globalAlpha = 0.35;
  for (const q of pts) { g.beginPath(); g.arc(X(q[0]), Y(q[1]), 2.4, 0, Math.PI * 2); g.fill(); }
  g.globalAlpha = 1;
  if (cfg.best) {
    g.beginPath(); g.arc(X(cfg.best[0]), Y(cfg.best[1]), 6, 0, Math.PI * 2); g.lineWidth = 2; g.strokeStyle = css("--raise"); g.stroke();
    g.beginPath(); g.arc(X(cfg.best[0]), Y(cfg.best[1]), 4.5, 0, Math.PI * 2); g.fillStyle = css("--s2"); g.fill();
  }
  const tip = tipFor(wrap);
  cv.onpointermove = e => {
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    let bi = -1, bd = 150;
    pts.forEach((q, i) => { const d = (X(q[0]) - mx) ** 2 + (Y(q[1]) - my) ** 2; if (d < bd) { bd = d; bi = i; } });
    if (bi < 0) { tip.hidden = true; return; }
    tip.hidden = false; tip.textContent = cfg.fmt(pts[bi]);
    tip.style.left = Math.min(r.width - 70, Math.max(70, X(pts[bi][0]))) + "px"; tip.style.top = Y(pts[bi][1]) - 6 + "px";
  };
  cv.onpointerleave = () => { tip.hidden = true; };
}

/* Horizontal CG strip: positions in mm from the wing root leading edge */
function cgStrip(cv, c) {
  const {g, w, h} = sizeCanvas(cv);
  const vals = [c.fwd, c.aft, c.np, c.actual, c.target, 0, c.mac1];
  const lo = Math.min(...vals) - 20, hi = Math.max(...vals) + 20;
  const L = 14, R = 14, X = v => L + (v - lo) / (hi - lo) * (w - L - R), yb = h * 0.52;
  g.clearRect(0, 0, w, h);
  g.fillStyle = css("--rule2"); g.fillRect(X(c.mac0), yb - 5, X(c.mac1) - X(c.mac0), 10);
  g.fillStyle = css("--good"); g.globalAlpha = 0.28; g.fillRect(X(c.fwd), yb - 12, X(c.aft) - X(c.fwd), 24); g.globalAlpha = 1;
  g.font = "10.5px 'IBM Plex Mono', monospace"; g.fillStyle = css("--muted"); g.textAlign = "center"; g.textBaseline = "top";
  for (const v of niceTicks(lo, hi, 6)) { g.fillRect(X(v), yb + 14, 1, 4); g.fillText(fmtN(v), X(v), yb + 20); }
  const mark = (x, label, color, up, shape) => {
    g.strokeStyle = css(color); g.fillStyle = css(color); g.lineWidth = 2;
    g.beginPath(); g.moveTo(X(x), yb - 16); g.lineTo(X(x), yb + 12); g.stroke();
    if (shape === "dot") { g.beginPath(); g.arc(X(x), yb, 5, 0, Math.PI * 2); g.fill(); }
    if (shape === "tri") { g.beginPath(); g.moveTo(X(x) - 5, yb - 22); g.lineTo(X(x) + 5, yb - 22); g.lineTo(X(x), yb - 15); g.fill(); }
    g.fillStyle = css("--ink2"); g.font = "11px Barlow, sans-serif"; g.textBaseline = up ? "bottom" : "top";
    g.fillText(label, Math.min(w - 40, Math.max(40, X(x))), up ? yb - 24 : yb + 32);
  };
  mark(c.np, "Neutral point", "--s3", true, "tri");
  mark(c.target, "Target CG", "--s1", false, null);
  mark(c.actual, "Actual CG", c.ok ? "--good" : "--bad", true, "dot");
}
