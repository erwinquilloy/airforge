"use strict";
/* ==========================================================================
   Vortex lattice method (VLM) for all lifting surfaces with symmetry,
   Trefftz-plane induced drag and strip-theory profile drag / stall.
   Linearized in alpha and tail incidence: every quantity is stored as a
   basis (0, per-alpha, per-incidence) so polars cost almost nothing.
   ========================================================================== */
function segVel(P, A, B, out, core) {
  const r1x = P[0] - A[0], r1y = P[1] - A[1], r1z = P[2] - A[2];
  const r2x = P[0] - B[0], r2y = P[1] - B[1], r2z = P[2] - B[2];
  const cx = r1y * r2z - r1z * r2y, cy = r1z * r2x - r1x * r2z, cz = r1x * r2y - r1y * r2x;
  const c2 = cx * cx + cy * cy + cz * cz;
  const r1 = Math.sqrt(r1x * r1x + r1y * r1y + r1z * r1z), r2 = Math.sqrt(r2x * r2x + r2y * r2y + r2z * r2z);
  const r0x = B[0] - A[0], r0y = B[1] - A[1], r0z = B[2] - A[2];
  const l2 = r0x * r0x + r0y * r0y + r0z * r0z;
  if (c2 < core * core * l2 || r1 < 1e-9 || r2 < 1e-9) return;
  const k = (r0x * (r1x / r1 - r2x / r2) + r0y * (r1y / r1 - r2y / r2) + r0z * (r1z / r1 - r2z / r2)) / (4 * Math.PI * c2);
  out[0] += k * cx; out[1] += k * cy; out[2] += k * cz;
}
const FAR = 1e6;
function horseshoe(P, A, B, out, core) {
  const Af = [A[0] + FAR, A[1], A[2]], Bf = [B[0] + FAR, B[1], B[2]];
  segVel(P, Af, A, out, core); segVel(P, A, B, out, core); segVel(P, B, Bf, out, core);
  // mirror image (y -> -y): far -> B' -> A' -> far
  const Am = [A[0], -A[1], A[2]], Bm = [B[0], -B[1], B[2]], Amf = [Am[0] + FAR, Am[1], Am[2]], Bmf = [Bm[0] + FAR, Bm[1], Bm[2]];
  segVel(P, Bmf, Bm, out, core); segVel(P, Bm, Am, out, core); segVel(P, Am, Amf, out, core);
}

function blendSlope(st, u) { return lerp(slopeAt(st.fA, u), slopeAt(st.fB, u), st.s); }

/* Build and solve. L = layout; res = {ns, nc, nsTail} */
function solveVLM(L, res) {
  const {ns, nc} = res;
  const surfs = [];
  const half = L.wing.half;
  const wingSt = [];
  for (let i = 0; i <= ns; i++) wingSt.push(L.wing.wingAt(half * (1 - Math.cos(Math.PI * i / ns)) / 2));
  surfs.push({name: "wing", kind: "wing", st: wingSt, trim: false});
  for (const s of L.surfaces) if (s.mirrored && s.kind !== "fin") {
    let st = s.st;
    if (res.nsTail && st.length - 1 > res.nsTail) { const step = Math.ceil((st.length - 1) / res.nsTail); st = st.filter((_, i) => i % step === 0 || i === st.length - 1); }
    surfs.push({name: s.name, kind: s.kind, st, trim: !!s.trim});
  }
  const panels = [], strips = [];
  for (const sf of surfs) {
    sf.strips = [];
    for (let k = 0; k < sf.st.length - 1; k++) {
      const S0 = sf.st[k], S1 = sf.st[k + 1];
      const tx = S1.x - S0.x, ty = S1.y - S0.y, tz = S1.z - S0.z;
      const ds = Math.hypot(ty, tz) || 1e-9;
      const n0 = [0, -tz / ds, ty / ds];
      const c = (S0.c + S1.c) / 2;
      const strip = {surf: sf.name, kind: sf.kind, y: (S0.y + S1.y) / 2, z: (S0.z + S1.z) / 2, y0: S0.y, z0: S0.z, y1: S1.y, z1: S1.z,
        c, ds, n0, S0, S1, panels: [], xq: (S0.x + S1.x) / 2 + 0.25 * c, twist: (S0.twist + S1.twist) / 2};
      for (let m = 0; m < nc; m++) {
        const ub = (m + 0.25) / nc, uc = (m + 0.75) / nc;
        const A = [S0.x + ub * S0.c, S0.y, S0.z], B = [S1.x + ub * S1.c, S1.y, S1.z];
        const C = [(S0.x + uc * S0.c + S1.x + uc * S1.c) / 2, (S0.y + S1.y) / 2, (S0.z + S1.z) / 2];
        const delta = strip.twist * D2R - (blendSlope(S0, uc) + blendSlope(S1, uc)) / 2;
        const pn = {A, B, C, n0, delta, trim: sf.trim, ly: B[1] - A[1], xm: (A[0] + B[0]) / 2, strip: strips.length, core: 0.02};
        strip.panels.push(panels.length); panels.push(pn);
      }
      sf.strips.push(strips.length); strips.push(strip);
    }
  }
  const N = panels.length, M = [];
  const v = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const row = new Float64Array(N), Pi = panels[i];
    for (let j = 0; j < N; j++) {
      v[0] = v[1] = v[2] = 0;
      const Pj = panels[j];
      horseshoe(Pi.C, Pj.A, Pj.B, v, 1e-4);
      row[j] = v[1] * Pi.n0[1] + v[2] * Pi.n0[2];
    }
    M.push(row);
  }
  const lu = luFactor(M);
  const r0 = new Float64Array(N), ra = new Float64Array(N), rt = new Float64Array(N);
  panels.forEach((pn, i) => { r0[i] = -pn.delta; ra[i] = -pn.n0[2]; rt[i] = pn.trim ? -1 : 0; });
  const G0 = luSolve(lu, r0), Ga = luSolve(lu, ra), Gt = luSolve(lu, rt);

  const S = L.wing.S, mac = L.wing.mac;
  const sumF = (G, f) => panels.reduce((s, pn, i) => s + f(pn) * G[i] * pn.ly, 0);
  const CL = G => 4 * sumF(G, () => 1) / S;
  const CM = G => -4 * sumF(G, pn => pn.xm) / (S * mac);
  const aero = {
    N, strips, surfs, panels: panels.map(pn => ({A: pn.A, B: pn.B})), G0, Ga, Gt,
    CL0: CL(G0), CLa: CL(Ga), CLt: CL(Gt),
    Cm0: CM(G0), Cma: CM(Ga), Cmt: CM(Gt),
  };
  // strip circulation bases
  for (const st of strips) {
    let g0 = 0, ga = 0, gt = 0;
    for (const i of st.panels) { g0 += G0[i]; ga += Ga[i]; gt += Gt[i]; }
    Object.assign(st, {g0, ga, gt, cl0: 2 * g0 / st.c, cla: 2 * ga / st.c, clt: 2 * gt / st.c, area2: 2 * st.c * st.ds / S});
  }
  // Trefftz-plane induced drag as a quadratic in alpha (incidence held at 0)
  const eps = 2e-4 * L.p.span;                                    // small core: larger values smear tip vortices
  const cdiFor = alpha => {
    const edges = [];
    for (const sf of surfs) {
      const ids = sf.strips, G = ids.map(i => strips[i].g0 + alpha * strips[i].ga);
      for (let k = 0; k <= ids.length; k++) {
        const g = (k > 0 ? G[k - 1] : 0) - (k < ids.length ? G[k] : 0);
        const st = strips[ids[Math.min(k, ids.length - 1)]];
        const y = k < ids.length ? st.y0 : st.y1, z = k < ids.length ? st.z0 : st.z1;
        edges.push([y, z, g], [-y, z, -g]);
      }
    }
    let sum = 0;
    for (const st of strips) {
      const G = st.g0 + alpha * st.ga;
      let w = 0;
      for (const [ye, ze, g] of edges) {
        const dy = st.y - ye, dz = st.z - ze, r2 = dy * dy + dz * dz + eps * eps;
        w += (-g * dz * st.n0[1] + g * dy * st.n0[2]) / (2 * Math.PI * r2);
      }
      sum += G * w * st.ds;
    }
    return -2 * sum / S;
  };
  const f0 = cdiFor(0), fp = cdiFor(1), fm = cdiFor(-1);
  aero.cdi = [f0, (fp - fm) / 2, (fp + fm) / 2 - f0];
  aero.xnp = -aero.Cma / aero.CLa * mac;                               // neutral point from nose (mm)
  const k = aero.cdi[2] / (aero.CLa ** 2);
  aero.e = Math.min(1.2, Math.max(0.3, 1 / (Math.PI * L.wing.AR * Math.max(k, 1e-6))));
  // root bending moment per unit total lift (wing strips, one side)
  const a1 = (1 - aero.CL0) / aero.CLa;
  let mom = 0, lift = 0;
  for (const st of strips) {
    const l = (st.cl0 + a1 * st.cla) * st.c * st.ds;
    lift += l;
    if (st.kind === "wing") mom += l * st.y;
  }
  aero.rootMomentPerLift = mom / (2 * lift);                            // mm
  return aero;
}

/* Evaluate the linear model at a lift coefficient. Returns alpha (rad), incidence and strip cls. */
function aeroAtCL(aero, CL, it = 0) {
  const alpha = (CL - aero.CL0 - aero.CLt * it) / aero.CLa;
  return {alpha, cdi: aero.cdi[0] + aero.cdi[1] * alpha + aero.cdi[2] * alpha * alpha};
}
function stripCl(st, alpha, it = 0) { return st.cl0 + alpha * st.cla + it * st.clt; }
function stripFoilCl(st, Re) { return Math.min(clMax2D(st.S0.fA, Re) * (1 - st.S0.s) + clMax2D(st.S0.fB, Re) * st.S0.s, clMax2D(st.S1.fA, Re) * (1 - st.S1.s) + clMax2D(st.S1.fB, Re) * st.S1.s); }
function stripCd(st, Re, cl) {
  const s = (st.S0.s + st.S1.s) / 2;
  return lerp(cdSection(st.S0.fA, Re, cl), cdSection(st.S1.fB, Re, cl), s);
}

/* Stall: first wing strip to reach its section clmax. */
function stallFor(aero, rho, V, it = 0) {
  let best = {alpha: 1, y: 0};
  for (const st of aero.strips) {
    if (st.kind !== "wing") continue;
    const Re = rho * V * st.c / 1000 / 1.81e-5, clm = stripFoilCl(st, Re) * 0.95;
    if (st.cla <= 0) continue;
    const a = (clm - st.cl0 - it * st.clt) / st.cla;
    if (a < best.alpha) best = {alpha: a, y: st.y, clm};
  }
  best.CL = aero.CL0 + aero.CLa * best.alpha + aero.CLt * it;
  return best;
}

/* Profile drag of all VLM strips at CL and speed */
function profileCD(aero, rho, V, alpha, it = 0) {
  let cd = 0;
  for (const st of aero.strips) {
    const Re = rho * V * st.c / 1000 / 1.81e-5;
    cd += stripCd(st, Re, stripCl(st, alpha, it)) * st.area2;
  }
  return cd;
}
