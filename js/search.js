"use strict";
/* ==========================================================================
   Design search: power-plant ranking and the mission optimizer
   (differential evolution). Both run in small chunks so the page stays live.
   ========================================================================== */

/* Hard feasibility for a finished analysis; returns a list of violations (0 = feasible) */
function powerViolations(A) {
  const v = [], p = A.p, f = A.perf, mm = A.motor;
  if (f.static1.I > mm.imax * 1.05) v.push(["Motor current", (f.static1.I - mm.imax) / mm.imax]);
  if (p.cells > mm.maxCells) v.push(["Cell count", (p.cells - mm.maxCells) / mm.maxCells]);
  if (A.cRate > A.pk.ch.maxC) v.push(["Battery C-rate", (A.cRate - A.pk.ch.maxC) / A.pk.ch.maxC]);
  if (f.static1.tipMach > 0.7) v.push(["Prop tip speed", f.static1.tipMach - 0.7]);
  if (!f.cruise) v.push(["No level flight", 1]);
  if (A.nLift) {
    if (!f.hover || f.hover.TW < 1.4) v.push(["Hover thrust", 1.4 - (f.hover ? f.hover.TW : 0)]);
    if (f.hover && f.hover.Ifull > A.liftMotor.imax * 1.05) v.push(["Lift motor current", (f.hover.Ifull - A.liftMotor.imax) / A.liftMotor.imax]);
  } else if (f.TW < p.minTW) v.push(["Launch thrust", (p.minTW - f.TW) / p.minTW]);
  const L = A.L;
  if (L.nacelles.length) { const clear = L.nacelles[0].y - (L.hasFuse ? p.fuseW / 2 : L.wing.bw2) - p.propD * IN / 2; if (clear < 8) v.push(["Prop clears fuselage", (8 - clear) / 50]); }
  return v;
}

const LAB_OBJ = {
  range: {label: "Range", f: A => A.perf.range, fmt: v => fmtN(v, 1) + " km"},
  endurance: {label: "Endurance", f: A => A.perf.endurance, fmt: v => fmtN(v) + " min"},
  speed: {label: "Top speed", f: A => A.perf.Vmax, fmt: v => fmtN(v) + " m/s"},
  climb: {label: "Thrust-to-weight", f: A => A.nLift && A.perf.hover ? A.perf.hover.TW : A.perf.TW, fmt: v => fmtN(v, 2)},
};

/* Generator: yields progress 0..1, returns ranked rows */
function* rankPowertrains(base, objKey) {
  const rows = [], obj = LAB_OBJ[objKey];
  const combos = [];
  for (const m of MOTORS) for (const [d, pt] of PROPS) for (let c = 2; c <= Math.min(6, m.maxCells); c++) {
    const v = pt / d; if (v < 0.35 || v > 0.9) continue;
    combos.push([m, d, pt, c]);
  }
  for (let i = 0; i < combos.length; i++) {
    const [m, d, pt, c] = combos[i];
    // same stored energy for every cell count, so packs compare fairly
    const Wh = base.cells * CHEM[base.chem].v * base.capacity / 1000;
    const q = Object.assign({}, base, {motorId: m.id, propD: d, propP: pt, cells: c, capacity: Math.round(Wh * 1000 / (c * CHEM[base.chem].v) / 50) * 50});
    try {
      const A = analyze(q, {res: "coarse", assumeBalanced: true});
      const viol = powerViolations(A);
      if (!viol.length) rows.push({motorId: m.id, motor: m.name, propD: d, propP: pt, cells: c, capacity: q.capacity, score: obj.f(A), mtow: A.mtow, range: A.perf.range, endurance: A.perf.endurance, vmax: A.perf.Vmax, tw: A.perf.TW, amps: A.perf.static1.Ib, hoverTW: A.perf.hover ? A.perf.hover.TW : null});
    } catch (e) { /* skip unsolvable combination */ }
    if (i % 6 === 5) yield (i + 1) / combos.length;
  }
  rows.sort((a, b) => b.score - a.score);
  return rows;
}

/* ---------------- mission optimizer ---------------- */
const OPT_OBJ = {
  mass: {label: "takeoff mass", f: A => A.mtow, show: v => fmtN(v) + " g", sign: 1},
  endurance: {label: "endurance", f: A => -A.perf.endurance, show: v => fmtN(-v) + " min", sign: -1},
  range: {label: "range", f: A => -A.perf.range, show: v => fmtN(-v, 1) + " km", sign: -1},
  material: {label: "printed material", f: A => A.printMass, show: v => fmtN(v) + " g", sign: 1},
  ld: {label: "cruise L/D", f: A => -(A.perf.cruise ? A.perf.cruise.LD : 0), show: v => fmtN(-v, 1), sign: -1},
};

function missionDecode(x, base, M, cands) {
  const p = Object.assign({}, base);
  p.span = x[0]; p.taper = x[2];
  const S = p.span * p.span / x[1];
  if (p.wingType === "bwb") {
    const outerHalf = p.span / 2 - p.bodyWidth / 2 - p.blendLen;
    p.rootChord = Math.max(80, 2 * Math.max(1, S - p.bodyWidth * p.bodyChord) / (2 * outerHalf * (1 + p.taper)) * 0.9);
  } else p.rootChord = 2 * S / (p.span * (1 + p.taper));
  p.foilRoot = cands[Math.min(cands.length - 1, Math.floor(x[3]))];
  p.foilTip = cands[Math.min(cands.length - 1, Math.floor(x[4]))];
  if (base.fuseType !== "none") p.noseLen = Math.round(base.noseLen * p.span / base.span);
  p.payload = M.mPayload; p.altitude = M.mAltitude; p.chem = M.mChem;
  if (M.oPower) {
    const m = MOTORS[Math.min(MOTORS.length - 1, Math.floor(x[6]))], pr = PROPS[Math.min(PROPS.length - 1, Math.floor(x[7]))];
    p.motorId = m.id; p.propD = pr[0]; p.propP = pr[1]; p.cells = Math.max(2, Math.min(m.maxCells, Math.round(x[8])));
  }
  p.capacity = Math.max(300, Math.round(x[5] * 1000 / (p.cells * CHEM[p.chem].v) / 50) * 50);
  return p;
}
function missionScore(A, M) {
  const v = [], f = A.perf;
  v.push(Math.max(0, f.Vs - M.mMaxStall) / M.mMaxStall);
  v.push(Math.max(0, A.mtow - M.mMaxMass) / M.mMaxMass);
  v.push(f.cruise ? Math.max(0, M.mMinCruise - f.cruise.V) / M.mMinCruise : 1);
  if (M.mReqType === "range") v.push(Math.max(0, M.mReqValue - f.range) / M.mReqValue);
  else v.push(Math.max(0, M.mReqValue - f.endurance) / M.mReqValue);
  for (const t of A.tubes) if (!t.ok) v.push(0.5);
  const maxChord = A.L.wing.cr * (A.p.rootBlend > 0 ? A.p.rootBlendGrowth : 1);
  if (maxChord > Math.hypot(A.p.bedX, A.p.bedY) - 12) v.push(0.5);
  for (const [, amt] of powerViolations(A)) v.push(Math.max(0.05, amt));
  if (A.L.tailless && !(A.trim.CL > 0.05)) v.push(0.3);
  const bx = A.battXNeeded, lo = A.L.hasFuse ? -A.L.xw + 25 : -40, hi = A.L.wing.cr * 0.7;
  if (bx < lo) v.push((lo - bx) / 500); if (bx > hi) v.push((bx - hi) / 500);
  const viol = v.reduce((s, q) => s + q, 0);
  const obj = OPT_OBJ[M.oObjective].f(A);
  return {feasible: viol === 0, viol, obj, fit: viol === 0 ? obj : 1e7 + viol * 1e5};
}

/* Generator yielding after each generation: {gen, best, hist, cloud} */
function* runMission(base, M, cands) {
  const lo = [Math.min(M.sSpanMin, M.mMaxSpan - 10), Math.min(M.sARMin, M.sARMax), 0.35, 0, 0, 4];
  const hi = [M.mMaxSpan, Math.max(M.sARMin, M.sARMax) + 0.01, 1, cands.length - 1e-6, cands.length - 1e-6, 400];
  if (M.oPower) { lo.push(0, 0, 2); hi.push(MOTORS.length - 1e-6, PROPS.length - 1e-6, 6.49); }
  const NP = M.rPop, D = lo.length, F = 0.6, CR = 0.85;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const evalX = x => { const p = missionDecode(x, base, M, cands); try { const A = analyze(p, {res: "coarse", assumeBalanced: true, minCruise: M.mMinCruise}); return Object.assign(missionScore(A, M), {p, A, x}); } catch (e) { return {feasible: false, fit: 1e9, p, x}; } };
  const state = {gen: 0, best: null, hist: [], cloud: []};
  const track = s => {
    if (s.feasible && state.cloud.length < 5000) state.cloud.push([s.A.mtow, s.A.perf.endurance]);
    if (!state.best || s.fit < state.best.fit) state.best = s;
  };
  let pop = Array.from({length: NP}, () => lo.map((l, i) => rnd(l, hi[i])));
  let sc = [];
  for (let i = 0; i < NP; i++) { const s = evalX(pop[i]); sc.push(s); track(s); if (i % 8 === 7) yield state; }
  for (let g = 0; g < M.rGens; g++) {
    for (let i = 0; i < NP; i++) {
      let a, b, c; do a = Math.floor(Math.random() * NP); while (a === i);
      do b = Math.floor(Math.random() * NP); while (b === i || b === a);
      do c = Math.floor(Math.random() * NP); while (c === i || c === a || c === b);
      const jr = Math.floor(Math.random() * D);
      const trial = pop[i].map((v, j) => {
        if (j !== jr && Math.random() > CR) return v;
        const t = pop[a][j] + F * (pop[b][j] - pop[c][j]);
        return t < lo[j] || t > hi[j] ? rnd(lo[j], hi[j]) : t;
      });
      const s = evalX(trial); track(s);
      if (s.fit <= sc[i].fit) { pop[i] = trial; sc[i] = s; }
    }
    state.gen = g + 1;
    state.hist.push(state.best.feasible ? state.best.obj : null);
    yield state;
  }
  return state;
}
