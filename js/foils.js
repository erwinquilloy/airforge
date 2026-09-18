"use strict";
/* ==========================================================================
   Airfoils: NACA 4/5-digit (incl. reflexed 5-digit) generators, Selig/Lednicer
   import, section property estimates and a linear-vortex panel method.
   Every airfoil is resampled to a shared cosine x-grid (K panels per surface)
   so sections can be blended and lofted point-to-point.
   ========================================================================== */
const K = 60;
const XG = Array.from({length: K + 1}, (_, i) => 0.5 * (1 - Math.cos(Math.PI * i / K)));

function interpY(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] > x) hi = m; else lo = m; }
  const t = (x - xs[lo]) / ((xs[hi] - xs[lo]) || 1);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}
function sortedSurface(pts) {
  const s = pts.slice().sort((a, b) => a[0] - b[0]), xs = [], ys = [];
  for (const [x, y] of s) { if (xs.length && Math.abs(x - xs[xs.length - 1]) < 1e-7) continue; xs.push(x); ys.push(y); }
  return {xs, ys};
}
function makeFoil(id, name, upperPts, lowerPts, source, extra) {
  const U = sortedSurface(upperPts), L = sortedSurface(lowerPts);
  const yu = XG.map(x => interpY(U.xs, U.ys, x)), yl = XG.map(x => interpY(L.xs, L.ys, x));
  yu[0] = yl[0] = (yu[0] + yl[0]) / 2;
  yu[K] = yl[K] = (yu[K] + yl[K]) / 2;
  return finishFoil(Object.assign({id, name, yu, yl, source}, extra || {}));
}

function nacaFoil(code) {
  code = String(code).trim();
  let camber, t;
  if (/^\d{4}$/.test(code)) {
    const m = +code[0] / 100, p = +code[1] / 10; t = +code.slice(2) / 100;
    camber = x => {
      if (m === 0 || p === 0) return [0, 0];
      return x < p ? [m / (p * p) * (2 * p * x - x * x), 2 * m / (p * p) * (p - x)]
                   : [m / ((1 - p) ** 2) * (1 - 2 * p + 2 * p * x - x * x), 2 * m / ((1 - p) ** 2) * (p - x)];
    };
  } else if (/^\d{5}$/.test(code) && (code[2] === "0" || code[2] === "1")) {
    const L = +code[0], P = +code[1], Q = +code[2]; t = +code.slice(3) / 100;
    if (L < 1) return null;
    const cl = L * 0.15, sc = cl / 0.3;
    if (Q === 0) {
      const tbl = {1: [0.0580, 361.4], 2: [0.1260, 51.64], 3: [0.2025, 15.957], 4: [0.2900, 6.643], 5: [0.3910, 3.230]}[P];
      if (!tbl) return null;
      const [r, k1r] = tbl, k1 = k1r * sc;
      camber = x => x < r
        ? [k1 / 6 * (x ** 3 - 3 * r * x * x + r * r * (3 - r) * x), k1 / 6 * (3 * x * x - 6 * r * x + r * r * (3 - r))]
        : [k1 * r ** 3 / 6 * (1 - x), -k1 * r ** 3 / 6];
    } else {                                                          // reflexed mean line
      const tbl = {2: [0.1300, 51.99, 0.000764], 3: [0.2170, 15.793, 0.00677], 4: [0.3180, 6.520, 0.0303], 5: [0.4410, 3.191, 0.1355]}[P];
      if (!tbl) return null;
      const [r, k1r, k21] = tbl, k1 = k1r * sc, c3 = k21 * (1 - r) ** 3 + r ** 3;
      camber = x => x < r
        ? [k1 / 6 * ((x - r) ** 3 - c3 * x + r ** 3), k1 / 6 * (3 * (x - r) ** 2 - c3)]
        : [k1 / 6 * (k21 * (x - r) ** 3 - c3 * x + r ** 3), k1 / 6 * (3 * k21 * (x - r) ** 2 - c3)];
    }
  } else return null;
  if (!(t >= 0.03 && t <= 0.3)) return null;
  const up = [], lo = [];
  for (let i = 0; i <= 240; i++) {
    const x = 0.5 * (1 - Math.cos(Math.PI * i / 240));
    const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    const [yc, dy] = camber(x), th = Math.atan(dy);
    up.push([x - yt * Math.sin(th), yc + yt * Math.cos(th)]);
    lo.push([x + yt * Math.sin(th), yc - yt * Math.cos(th)]);
  }
  up[0] = lo[0] = [0, 0];
  const reflex = code.length === 5 && code[2] === "1";
  return makeFoil("naca" + code, "NACA " + code, up, lo, "analytic", {reflex});
}

function parseDat(text, fallbackName) {
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  let name = fallbackName || "Imported";
  const pts = [];
  for (const ln of lines) {
    const m = ln.match(/^(-?\d*\.?\d+(?:[eE][-+]?\d+)?)[\s,]+(-?\d*\.?\d+(?:[eE][-+]?\d+)?)$/);
    if (m) pts.push([+m[1], +m[2]]); else if (!pts.length) name = ln.slice(0, 40);
  }
  if (pts.length < 10) throw new Error("Found fewer than 10 coordinate pairs. Paste Selig format: a name line, then 'x y' pairs from the trailing edge over the top to the leading edge and back.");
  if (pts[0][0] > 1.5) {                                                 // Lednicer
    const nu = Math.round(pts[0][0]), rest = pts.slice(1);
    return makeFoil(uidFoil(name), name, rest.slice(0, nu), rest.slice(nu), "imported");
  }
  let iLE = 0;
  pts.forEach((p, i) => { if (p[0] < pts[iLE][0]) iLE = i; });
  const a = pts.slice(0, iLE + 1), b = pts.slice(iLE);
  const avg = s => s.reduce((q, p) => q + p[1], 0) / s.length;
  const [up, lo] = avg(a) >= avg(b) ? [a, b] : [b, a];
  const xmin = pts[iLE][0], xmax = Math.max(...pts.map(p => p[0])), sc = 1 / ((xmax - xmin) || 1);
  const norm = s => s.map(p => [(p[0] - xmin) * sc, (p[1] - pts[iLE][1]) * sc]);
  return makeFoil(uidFoil(name), name, norm(up), norm(lo), "imported");
}
function uidFoil(name) { return "u_" + name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) + "_" + Math.random().toString(36).slice(2, 6); }

function finishFoil(f) {
  const {yu, yl} = f;
  let tMax = 0, xt = 0, cMax = 0, xc = 0, area = 0, per = 0;
  const zc = XG.map((_, i) => (yu[i] + yl[i]) / 2);
  for (let i = 0; i <= K; i++) {
    const th = yu[i] - yl[i];
    if (th > tMax) { tMax = th; xt = XG[i]; }
    if (Math.abs(zc[i]) > Math.abs(cMax)) { cMax = zc[i]; xc = XG[i]; }
    if (i) {
      const dx = XG[i] - XG[i - 1];
      area += dx * (th + yu[i - 1] - yl[i - 1]) / 2;
      per += Math.hypot(dx, yu[i] - yu[i - 1]) + Math.hypot(dx, yl[i] - yl[i - 1]);
    }
  }
  // camber-line slope on the grid (used by the VLM boundary condition)
  const slope = XG.map((x, i) => {
    const a = Math.max(0, i - 1), b = Math.min(K, i + 1);
    return (zc[b] - zc[a]) / ((XG[b] - XG[a]) || 1);
  });
  // thin-airfoil theory
  const N = 180; let I0 = 0, A1 = 0, A2 = 0;
  for (let j = 0; j < N; j++) {
    const th = Math.PI * (j + 0.5) / N, x = (1 - Math.cos(th)) / 2, d = Math.PI / N;
    const dz = interpY(XG, slope, x);
    I0 += dz * (Math.cos(th) - 1) * d; A1 += dz * Math.cos(th) * d; A2 += dz * Math.cos(2 * th) * d;
  }
  A1 *= 2 / Math.PI; A2 *= 2 / Math.PI;
  return Object.assign(f, {
    t: tMax, xt, camber: cMax, xc, areaC: area, perC: per, zc, slope,
    aL0: -I0 / Math.PI, cm0: Math.PI / 4 * (A2 - A1),
    a2d: 0.93 * 2 * Math.PI * (1 + 0.77 * tMax),
    clOpt: 0.1 + 8 * Math.max(0, cMax),
    symmetric: Math.abs(cMax) < 0.002,
  });
}
const thicknessAt = (f, x) => interpY(XG, f.yu, x) - interpY(XG, f.yl, x);
const midAt = (f, x) => interpY(XG, f.zc, x);
const slopeAt = (f, x) => interpY(XG, f.slope, x);

function clMax2D(f, Re) {
  const rf = Math.min(1.02, Math.max(0.62, 0.9 + 0.11 * Math.log10(Re / 2e5)));
  const base = 0.75 + 3.0 * Math.min(f.t, 0.14) + 9 * Math.max(0, f.camber) - (f.reflex ? 0.12 : 0);
  return base * rf;
}
const cfFlat = Re => Math.max(1.328 / Math.sqrt(Math.max(Re, 1e3)), 0.074 / Math.pow(Re, 0.2) - 1742 / Re);
function cdSection(f, Re, cl) {
  Re = Math.max(Re, 2e4);
  const ff = 1 + 2 * f.t + 60 * f.t ** 4;
  return 2 * cfFlat(Re) * ff + 0.0035 * Math.pow(2e5 / Re, 0.7) + 0.011 * (cl - f.clOpt) ** 2;
}

/* ---- linear-strength vortex panel method (inviscid) -----------------------
   Nodes run clockwise: lower TE -> LE -> upper TE. Solutions for the two
   freestream components are stored so Cp at any angle is a superposition. */
function panelSolve(f) {
  if (f._panel) return f._panel;
  const X = [], Y = [];
  for (let i = K; i >= 0; i--) { X.push(XG[i]); Y.push(f.yl[i]); }
  for (let i = 1; i <= K; i++) { X.push(XG[i]); Y.push(f.yu[i]); }
  const N = X.length - 1;                                            // panels
  const xc = [], yc = [], th = [], S = [];
  for (let j = 0; j < N; j++) {
    xc.push((X[j] + X[j + 1]) / 2); yc.push((Y[j] + Y[j + 1]) / 2);
    th.push(Math.atan2(Y[j + 1] - Y[j], X[j + 1] - X[j])); S.push(Math.hypot(X[j + 1] - X[j], Y[j + 1] - Y[j]) || 1e-9);
  }
  const AN = Array.from({length: N + 1}, () => new Float64Array(N + 1));
  const AT = Array.from({length: N}, () => new Float64Array(N + 1));
  for (let i = 0; i < N; i++) {
    const cn1 = new Float64Array(N), cn2 = new Float64Array(N), ct1 = new Float64Array(N), ct2 = new Float64Array(N);
    for (let j = 0; j < N; j++) {
      if (i === j) { cn1[j] = -1; cn2[j] = 1; ct1[j] = Math.PI / 2; ct2[j] = Math.PI / 2; continue; }
      const dx = xc[i] - X[j], dy = yc[i] - Y[j];
      const A = -dx * Math.cos(th[j]) - dy * Math.sin(th[j]);
      const B = dx * dx + dy * dy;
      const C = Math.sin(th[i] - th[j]), D = Math.cos(th[i] - th[j]);
      const E = dx * Math.sin(th[j]) - dy * Math.cos(th[j]);
      const Fv = Math.log(1 + S[j] * (S[j] + 2 * A) / B);
      const G = Math.atan2(E * S[j], B + A * S[j]);
      const Pv = dx * Math.sin(th[i] - 2 * th[j]) + dy * Math.cos(th[i] - 2 * th[j]);
      const Qv = dx * Math.cos(th[i] - 2 * th[j]) - dy * Math.sin(th[i] - 2 * th[j]);
      cn2[j] = D + 0.5 * Qv * Fv / S[j] - (A * C + D * E) * G / S[j];
      cn1[j] = 0.5 * D * Fv + C * G - cn2[j];
      ct2[j] = C + 0.5 * Pv * Fv / S[j] + (A * D - C * E) * G / S[j];
      ct1[j] = 0.5 * C * Fv - D * G - ct2[j];
    }
    AN[i][0] = cn1[0]; AN[i][N] = cn2[N - 1];
    AT[i][0] = ct1[0]; AT[i][N] = ct2[N - 1];
    for (let j = 1; j < N; j++) { AN[i][j] = cn1[j] + cn2[j - 1]; AT[i][j] = ct1[j] + ct2[j - 1]; }
  }
  AN[N][0] = 1; AN[N][N] = 1;                                          // Kutta condition
  const rhsS = new Float64Array(N + 1), rhsC = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) { rhsS[i] = Math.sin(th[i]); rhsC[i] = -Math.cos(th[i]); }
  const lu = luFactor(AN.map(r => Float64Array.from(r)));
  const gS = luSolve(lu, rhsS), gC = luSolve(lu, rhsC);                 // alpha = 0 and alpha = 90° bases
  const vt = (g, base) => Array.from({length: N}, (_, i) => base[i] + AT[i].reduce((s, a, j) => s + a * g[j], 0));
  const vtS = vt(gS, th.map(t => Math.cos(t))), vtC = vt(gC, th.map(t => Math.sin(t)));
  const clOf = g => { let c = 0; for (let j = 0; j < N; j++) c += (g[j] + g[j + 1]) / 2 * S[j]; return 4 * Math.PI * c; };   // unknowns are gamma/(2πV)
  f._panel = {N, X, Y, xc, yc, vtS, vtC, clS: clOf(gS), clC: clOf(gC)};
  return f._panel;
}
/* Cp at panel midpoints for angle alpha (rad) */
function panelCp(f, alpha) {
  const P = panelSolve(f), ca = Math.cos(alpha), sa = Math.sin(alpha);
  return P.vtS.map((v, i) => 1 - (ca * v + sa * P.vtC[i]) ** 2);
}
const panelCl = (f, alpha) => { const P = panelSolve(f); return Math.cos(alpha) * P.clS + Math.sin(alpha) * P.clC; };
/* angle giving a target inviscid Cl (small-angle inversion) */
const panelAlphaForCl = (f, cl) => { const P = panelSolve(f); return Math.atan2(cl - P.clS, P.clC); };
/* Cp at the loft ring index (ring: lower LE..TE then upper TE..LE+1) */
function ringCp(f, alpha) {
  const cp = panelCp(f, alpha), N = cp.length, node = new Float64Array(N + 1);
  node[0] = cp[0]; node[N] = cp[N - 1];
  for (let n = 1; n < N; n++) node[n] = (cp[n - 1] + cp[n]) / 2;
  const ring = new Float64Array(2 * K + 1);
  for (let n = 0; n <= K; n++) ring[K - n] = node[n];                   // lower: node n = lo[K-n]
  for (let n = K + 1; n <= 2 * K; n++) ring[3 * K + 1 - n] = node[n];   // upper
  return ring;
}

/* ---- small dense LU solver --------------------------------------------- */
function luFactor(A) {
  const n = A.length, piv = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    let p = k, mx = Math.abs(A[k][k]);
    for (let i = k + 1; i < n; i++) if (Math.abs(A[i][k]) > mx) { mx = Math.abs(A[i][k]); p = i; }
    piv[k] = p; if (p !== k) { const t = A[p]; A[p] = A[k]; A[k] = t; }
    const akk = A[k][k] || 1e-12, rk = A[k];
    for (let i = k + 1; i < n; i++) {
      const ri = A[i], m = (ri[k] /= akk);
      if (m) for (let j = k + 1; j < n; j++) ri[j] -= m * rk[j];
    }
  }
  return {A, piv, n};
}
function luSolve({A, piv, n}, b) {
  const x = Float64Array.from(b);
  for (let k = 0; k < n; k++) { const p = piv[k]; if (p !== k) { const t = x[p]; x[p] = x[k]; x[k] = t; } }
  for (let i = 1; i < n; i++) { let s = x[i]; const r = A[i]; for (let j = 0; j < i; j++) s -= r[j] * x[j]; x[i] = s; }
  for (let i = n - 1; i >= 0; i--) { let s = x[i]; const r = A[i]; for (let j = i + 1; j < n; j++) s -= r[j] * x[j]; x[i] = s / (r[i] || 1e-12); }
  return x;
}

const FOILS = {};
const addFoil = f => (FOILS[f.id] = f);
["2410", "2411", "2412", "3410", "3412", "4412", "5412", "2415", "4415", "6409", "23012", "23015", "23109", "23110", "23111", "23112", "23115", "25110", "25112", "0008", "0009", "0010", "0011", "0012", "0015"].forEach(c => addFoil(nacaFoil(c)));
