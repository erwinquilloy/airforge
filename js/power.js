"use strict";
/* ==========================================================================
   Powertrain: battery (with sag) -> ESC -> brushless motor (Kv, Rm, Io)
   -> propeller (empirical Ct/Cp vs advance ratio). All SI inside.
   ========================================================================== */
const ESC_EFF = 0.95;
function propCoef(Din, Pin, J) {
  const pd = Pin / Din, ct0 = 0.075 + 0.07 * pd, cp0 = 0.018 + 0.085 * pd * pd, J0 = 1.12 * pd + 0.08;
  const x = Math.max(0, J / J0);
  return {ct: ct0 * (1 - Math.pow(x, 1.5)), cp: cp0 * Math.max(0.2, 1 + 0.3 * x - 0.9 * Math.pow(x, 2.5)), J0};
}
const propMass = Din => 0.16 * Din * Din;
const escMass = imax => 0.35 * imax + 4;

/* Approximate pack dimensions (mm) from chemistry, cells and capacity */
function batteryDims(p) {
  if (p.battDims === "manual") return {L: p.battL, W: p.battW, H: p.battH};
  const ch = CHEM[p.chem], Wh = p.cells * ch.v * p.capacity / 1000;
  if (p.chem === "liion") {                                        // 21700 cells, 4.5 Ah each, in two rows
    const par = Math.max(1, Math.ceil(p.capacity / 4500)), n = p.cells * par, rows = n > 3 ? 2 : 1;
    return {L: 72, W: 21.5 * Math.ceil(n / rows), H: 21.5 * rows};
  }
  const H = Math.min(60, p.cells * (5.5 + p.capacity / 1000 * 1.1)), W = Math.min(55, 30 + p.capacity / 1000 * 2.5);
  return {L: Math.max(40, Wh / 0.30 * 1000 / (W * H)), W, H};
}
function pack(p) {
  const ch = CHEM[p.chem];
  return {V0: p.cells * ch.v, R: p.cells * ch.rRef * 1000 / p.capacity, Wh: p.cells * ch.v * p.capacity / 1000, ch};
}

/* thrust (N), torque etc. of one prop at rev/s n */
function propAt(Din, Pin, rho, V, n) {
  const D = Din * 0.0254, J = n > 0 ? V / (n * D) : 99, {ct, cp} = propCoef(Din, Pin, J);
  return {T: ct * rho * n * n * D ** 4, Q: cp * rho * n * n * D ** 5 / (2 * Math.PI), J};
}

/* Full throttle operating point with nMot identical motors sharing the pack */
function fullThrottle(m, Din, Pin, rho, V, pk, nMot) {
  const Kt = 60 / (2 * Math.PI * m.kv), Reff = m.rm + nMot * pk.R / ESC_EFF;
  let lo = 0, hi = pk.V0 * m.kv / 60;
  for (let i = 0; i < 40; i++) {
    const n = (lo + hi) / 2, I = (pk.V0 - n * 60 / m.kv) / Reff;
    const {Q} = propAt(Din, Pin, rho, V, n);
    if (Kt * (I - m.io) > Q) lo = n; else hi = n;
  }
  const n = lo, I = (pk.V0 - n * 60 / m.kv) / Reff, pr = propAt(Din, Pin, rho, V, n);
  const Ib = nMot * I / ESC_EFF, Vb = pk.V0 - pk.R * Ib;
  return {n, rpm: n * 60, T: pr.T, I, Ib, Vb, Pb: Ib * Vb, tipMach: n * Math.PI * Din * 0.0254 / 343};
}

/* Operating point that delivers Treq (N per motor). Returns null if unreachable. */
function forThrust(m, Din, Pin, rho, V, Treq, pk, nMot) {
  const nmax = pk.V0 * m.kv / 60;
  if (Treq <= 0) Treq = 1e-3;
  if (propAt(Din, Pin, rho, V, nmax).T < Treq) return null;
  let lo = 0, hi = nmax;
  for (let i = 0; i < 34; i++) { const n = (lo + hi) / 2; if (propAt(Din, Pin, rho, V, n).T < Treq) lo = n; else hi = n; }
  const n = hi, pr = propAt(Din, Pin, rho, V, n), Kt = 60 / (2 * Math.PI * m.kv);
  const I = pr.Q / Kt + m.io, Vm = I * m.rm + n * 60 / m.kv;
  const Pb = nMot * Vm * I / ESC_EFF, disc = pk.V0 * pk.V0 - 4 * pk.R * Pb;
  if (disc < 0) return null;
  const Vb = (pk.V0 + Math.sqrt(disc)) / 2, thr = Vm / Vb;
  if (thr > 1.001) return null;
  return {n, rpm: n * 60, T: Treq, I, Vm, throttle: thr, Pb, Ib: Pb / Vb, Vb, etaProp: Treq * V / (pr.Q * 2 * Math.PI * n || 1), etaMotor: pr.Q * 2 * Math.PI * n / (Vm * I)};
}
