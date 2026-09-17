"use strict";
/* ==========================================================================
   Potential-flow surface pressure around the aircraft: a slender-body source
   line for the fuselage plus the solved VLM horseshoes of every lifting
   surface. Inviscid and linear — use it to compare port locations, then
   confirm in a viscous CFD code with the exported assembly STL.
   ========================================================================== */
function flowContext(A, alphaRad) {
  const L = A.L, srcs = [];
  if (L.hasFuse) {
    const n = 48, dx = L.fuse.L / n;
    const area = x => { const [hw, hh] = L.fuse.profile(Math.min(L.fuse.L, Math.max(0, x))); return Math.PI * hw * hh; };
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) * dx, q = (area(x + dx / 2) - area(x - dx / 2));   // dA/dx · dx, with V∞ = 1
      srcs.push([x, 0, L.fuse.profile(x)[2], q]);
    }
  }
  const ae = A.aero, G = ae.G0.map((g, i) => g + alphaRad * ae.Ga[i]);
  return {srcs, panels: ae.panels, G, alpha: alphaRad};
}
function velocityAt(P, ctx) {
  const v = [1, 0, ctx.alpha];
  for (const [sx, sy, sz, q] of ctx.srcs) {
    const dx = P[0] - sx, dy = P[1] - sy, dz = P[2] - sz, r2 = dx * dx + dy * dy + dz * dz + 4, k = q / (4 * Math.PI * r2 * Math.sqrt(r2));
    v[0] += k * dx; v[1] += k * dy; v[2] += k * dz;
  }
  const w = [0, 0, 0];
  ctx.panels.forEach((pn, i) => { const g = ctx.G[i]; if (!g) return; const o = [0, 0, 0]; horseshoe(P, pn.A, pn.B, o, 0.5); w[0] += g * o[0]; w[1] += g * o[1]; w[2] += g * o[2]; });
  return [v[0] + w[0], v[1] + w[1], v[2] + w[2]];
}
const cpAt = (P, ctx) => { const v = velocityAt(P, ctx); return 1 - (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]); };

/* Pressure at the intake and exhaust ports and the cooling flow they drive at cruise */
function coolingEstimate(A) {
  const p = A.p, L = A.L;
  if (!L.hasFuse || !(p.intake || p.exhaust) || !A.perf.cruise) return null;
  const ctx = flowContext(A, A.perf.cruise.alpha), ports = [];
  const surf = (x, deg) => { const [hw, hh, zc] = L.fuse.profile(Math.min(L.fuse.L, Math.max(0, x))), a = deg * D2R, c = Math.cos(a), s = Math.sin(a);
    return [x, hw * Math.sign(c) * Math.pow(Math.abs(c), 2 / 2.6) + 3 * c, zc + hh * Math.sign(s) * Math.pow(Math.abs(s), 2 / 2.6) + 3 * s]; };
  const depth = p.intakeL * Math.tan(7 * D2R);
  let cpI = null, cpE = null;
  if (p.intake) { cpI = cpAt(surf(p.intakeX + p.intakeL * 0.8, p.intakeAng), ctx); ports.push({kind: "intake", cp: cpI}); }
  if (p.exhaust) { cpE = cpAt(surf(p.exhaustX + 10, p.exhaustAng), ctx); ports.push({kind: "exhaust", cp: cpE}); }
  const rho = A.rho, V = A.perf.cruise.V, q = 0.5 * rho * V * V;
  const res = {ports, cpI, cpE, V};
  if (p.intake && p.exhaust) {
    const eta = 0.6, dCp = cpI + eta * (1 - cpI) - cpE;
    const nI = p.intakeMirror ? 2 : 1, Ai = nI * p.intakeW * depth * 1e-6, Ae = p.exhaustArea * Ai;
    const Aeff = 0.62 / Math.sqrt(1 / (Ai * Ai) + 1 / (Ae * Ae));
    const flow = dCp > 0 ? Aeff * Math.sqrt(2 * dCp * q / rho) : 0;            // m³/s
    const heatRemoved = rho * flow * 1005 * 15;                                  // W at a 15 K air temperature rise
    const Pb = A.perf.cruise.Pb, Ib = A.perf.cruise.Ib || 0;
    const heatLoad = Pb * (1 - ESC_EFF) + Ib * Ib * A.pk.R;
    Object.assign(res, {dCp, flowLs: flow * 1000, heatRemoved, heatLoad});
  }
  return res;
}
