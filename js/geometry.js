"use strict";
/* ==========================================================================
   Aircraft assembly: turns the analysis into printable parts.
   Canonical frames: lifting surfaces are lofted with x = chord, s = span,
   z = thickness; fuselage shells with u = y, s = x, v = z. Each part keeps
   world triangles (viewer, assembly STL) and a print rotation.
   ========================================================================== */
const PETG_NOTE = "PETG or ASA, 3 perimeters, 30% infill, flat on the bed.";

/* ---------------- lifting segment: skin with pockets, bores and control-surface cut ---------------- */
function buildLiftSeg(c) {
  const S = new Set([+c.s0.toFixed(4), +c.s1.toFixed(4)]);
  const add = v => { if (v > c.s0 + 0.2 && v < c.s1 - 0.2) S.add(+v.toFixed(4)); };
  const nReg = Math.max(1, Math.ceil((c.s1 - c.s0) / c.step));
  for (let i = 1; i < nReg; i++) add(c.s0 + (c.s1 - c.s0) * i / nReg);
  for (const b of c.breaks || []) add(b);
  const cs = c.cs && c.cs.b > c.s0 + 0.2 && c.cs.a < c.s1 - 0.2 ? c.cs : null;
  const hpInOK = !!(cs && cs.pin && cs.a - cs.depth > c.s0 + 0.2), hpOutOK = !!(cs && cs.pin && cs.b + cs.depth < c.s1 - 0.2);
  if (cs) { add(cs.a); add(cs.b); if (hpInOK) add(cs.a - cs.depth); if (hpOutOK) add(cs.b + cs.depth); }
  for (const b of c.bays) { add(b.a); add(b.b); }
  for (const sp of c.spars) { add(sp.yStart); add(sp.yEnd); }           // a bore that stops mid-segment becomes a pocket
  const dPin = Math.min(c.pinDepth, (c.s1 - c.s0) / 2 - 2);
  if (c.pinsIn.length) add(c.s0 + dPin);
  if (c.pinsOut.length) add(c.s1 - dPin);
  const ys = [...S].sort((a, b) => a - b), N = ys.length, nU = c.U.length;
  const P = ys.map(s => foilPts(c.sectionAt(s), c.U, c.minTE));
  const gridIdx = c.U.map(u => XG.findIndex(x => Math.abs(x - u) < 1e-9));

  const stateOf = j => {
    const m = (ys[j] + ys[j + 1]) / 2;
    return {cs: !!cs && m > cs.a && m < cs.b, bays: c.bays.filter(b => m > b.a && m < b.b), spars: c.spars.filter(sp => m > sp.yStart - 1e-6 && m < sp.yEnd + 1e-6),
      hpIn: hpInOK && m > cs.a - cs.depth && m < cs.a, hpOut: hpOutOK && m > cs.b && m < cs.b + cs.depth,
      pinIn: c.pinsIn.length > 0 && m < c.s0 + dPin, pinOut: c.pinsOut.length > 0 && m > c.s1 - dPin};
  };
  const sig = st => [st.cs, st.bays.map(b => b.id).join("."), st.spars.map(sp => sp.id).join("."), st.hpIn, st.hpOut, st.pinIn, st.pinOut].join("|");
  const outerOf = st => j => {
    const {lo, up} = P[j], out = [], idx = [], lastLo = st.cs ? cs.iH : nU - 1;
    for (let i = 0; i <= lastLo;) {
      out.push(lo[i]); idx.push(gridIdx[i]);
      const b = st.bays.find(q => q.side === "bottom" && q.ia === i);
      if (b) { const z = b.roof(ys[j]); out.push([lo[b.ia][0], z], [lo[b.ib][0], z]); idx.push(-1, -1); i = b.ib; continue; }
      i++;
    }
    for (let i = lastLo; i >= 1;) {
      out.push(up[i]); idx.push(gridIdx[i] >= 0 ? 2 * K + 1 - gridIdx[i] : -1);
      const b = st.bays.find(q => q.side === "top" && q.ib === i);
      if (b) { const z = b.roof(ys[j]); out.push([up[b.ib][0], z], [up[b.ia][0], z]); idx.push(-1, -1); i = b.ia; continue; }
      i--;
    }
    return {out, idx};
  };
  const holeFns = st => {
    const h = [];
    for (const sp of st.spars) h.push({key: "sp" + sp.id, axis: sp.axis, r: sp.r, fn: j => { const q = sp.line(ys[j]); return holeRing(q[0], q[1], sp.r, 24); }});
    if (st.hpIn) h.push({key: "hpIn", fn: j => { const q = cs.pin.line(ys[j]); return holeRing(q[0], q[1], cs.pin.r, 14); }});
    if (st.hpOut) h.push({key: "hpOut", fn: j => { const q = cs.pin.line(ys[j]); return holeRing(q[0], q[1], cs.pin.r, 14); }});
    if (st.pinIn) c.pinsIn.forEach((q, i) => h.push({key: "pi" + i, fn: () => holeRing(q[0], q[1], c.pinR, 14)}));
    if (st.pinOut) c.pinsOut.forEach((q, i) => h.push({key: "po" + i, fn: () => holeRing(q[0], q[1], c.pinR, 14)}));
    return h;
  };
  const zones = [];
  for (let j = 0; j < N - 1; j++) {
    const st = stateOf(j), g = sig(st), zl = zones[zones.length - 1];
    if (zl && zl.sig === g) zl.j1 = j + 1;
    else zones.push({sig: g, st, j0: j, j1: j + 1});
  }
  for (const z of zones) {
    const of = outerOf(z.st), hs = holeFns(z.st);
    const cache = new Map(), get = j => { if (!cache.has(j)) cache.set(j, of(j)); return cache.get(j); };
    z.outers = [j => get(j).out]; z.meta = [j => get(j).idx]; z.hk = hs; z.holes = hs.map(h => h.fn);
  }
  const faces = [], discs = [];
  for (let zi = 1; zi < zones.length; zi++) {
    const A = zones[zi - 1], B = zones[zi], j = B.j0, {lo, up} = P[j];
    const claimed = new Set();
    if (A.st.cs !== B.st.cs) {
      const pts = [...lo.slice(cs.iH), ...up.slice(cs.iH).reverse()], holes = [];
      if (A.st.hpIn && B.st.cs) { holes.push(A.hk.find(h => h.key === "hpIn").fn(j)); claimed.add("hpIn"); }
      if (B.st.hpOut && A.st.cs) { holes.push(B.hk.find(h => h.key === "hpOut").fn(j)); claimed.add("hpOut"); }
      faces.push({j, pts, holes, sign: B.st.cs ? 1 : -1});
    }
    const ids = new Set([...A.st.bays, ...B.st.bays].map(b => b.id));
    for (const id of ids) {
      const inA = A.st.bays.some(b => b.id === id), inB = B.st.bays.some(b => b.id === id);
      if (inA === inB) continue;
      const b = (inA ? A : B).st.bays.find(q => q.id === id), z = b.roof(ys[j]);
      const arr = b.side === "bottom" ? lo : up;
      const pts = [...arr.slice(b.ia, b.ib + 1), [arr[b.ib][0], z], [arr[b.ia][0], z]];
      const holes = [], side = inA ? A : B, other = inA ? B : A;
      for (const h of side.hk) {                                         // a bore dying here opens into the pocket
        if (claimed.has(h.key) || other.hk.some(q => q.key === h.key)) continue;
        const ring = h.fn(j);
        if (ring.every(q => inPoly(q[0], q[1], pts))) { holes.push(ring); claimed.add(h.key); }
      }
      faces.push({j, pts, holes, sign: inB ? 1 : -1});
    }
    const keysA = new Set(A.hk.map(h => h.key)), keysB = new Set(B.hk.map(h => h.key));
    const gone = A.hk.filter(h => !keysB.has(h.key) && !claimed.has(h.key));
    const born = B.hk.filter(h => !keysA.has(h.key) && !claimed.has(h.key));
    for (const h of gone.slice()) {                                      // same bore, thinner tube: an annulus, not two discs
      const mate = h.axis && born.find(q => q.axis === h.axis);
      if (!mate) continue;
      const wide = h.r >= mate.r ? h : mate, thin = h.r >= mate.r ? mate : h;
      faces.push({j, pts: wide.fn(j), holes: [thin.fn(j)], sign: wide === h ? -1 : 1});
      gone.splice(gone.indexOf(h), 1); born.splice(born.indexOf(mate), 1);
    }
    for (const h of gone) discs.push({j, ring: h.fn(j), sign: -1});
    for (const h of born) discs.push({j, ring: h.fn(j), sign: 1});
  }
  return loftZoned(ys, zones, faces, discs, !!c.meta);
}

/* ---------------- control surface part with rounded, pinned leading edge and horn ---------------- */
function buildCSPart(c) {
  const n = Math.max(1, Math.ceil((c.b - c.a) / c.step)), ys = Array.from({length: n + 1}, (_, i) => c.a + (c.b - c.a) * i / n);
  const P = ys.map(s => foilPts(c.sectionAt(s), c.U, c.minTE)), nU = c.U.length;
  let iP = c.iH + 1;
  for (let j = 0; j < ys.length; j++) { const xp = c.line(ys[j])[0]; while (iP < nU - 2 && (P[j].lo[iP][0] < xp + 0.8 || P[j].up[iP][0] < xp + 0.8)) iP++; }
  const radius = j => { const [xp, zp] = c.line(ys[j]), [zu, zl] = skinAtX(P[j], xp); return Math.max(0.8, Math.min(zu - zp, zp - zl) - 0.05); };
  const ring = j => {
    const {lo, up} = P[j], [xp, zp] = c.line(ys[j]), R = radius(j), out = [];
    for (let i = iP; i < nU; i++) out.push(lo[i]);
    for (let i = nU - 1; i >= iP; i--) out.push(up[i]);
    for (let k = 0; k <= 10; k++) { const a = (90 + 18 * k) * D2R; out.push([xp + R * Math.cos(a), zp + R * Math.sin(a)]); }
    return out;
  };
  const holes = c.pinR ? [j => { const q = c.line(ys[j]); return holeRing(q[0], q[1], c.pinR, 14); }] : [];
  const m = loftZoned(ys, [{j0: 0, j1: ys.length - 1, outers: [ring], holes}], [], [], false);
  const minR = Math.min(...ys.map((_, j) => radius(j)));
  if (c.horn != null && c.horn > c.a + 2 && c.horn < c.b - 2) {
    const sh = c.horn, Ph = foilPts(c.sectionAt(sh), c.U, c.minTE), [xp, zp] = c.line(sh), R = Math.max(0.8, Math.min(...skinAtX(Ph, xp).map((z, i) => i ? zp - z : z - zp)));
    const sg = c.hornSide === "top" ? 1 : -1, si = sg > 0 ? 0 : 1;           // horn on the upper or lower skin
    const z0 = zp + sg * R, hd = c.hornDepth, outline = [[xp - 1, z0 - sg * 1.4]];
    for (let x = xp + 2; x <= xp + 16; x += 2) outline.push([x, skinAtX(Ph, x)[si] - sg * 1.4]);
    outline.push([xp + 16, z0 + sg * 3], [xp + 5, z0 + sg * hd], [xp - 1, z0 + sg * hd]);
    const horn = plate(outline, [circle(xp + 1.5, z0 + sg * (hd - 3.2), 0.75, 12), circle(xp + 1.5, z0 + sg * (hd - 6.8), 0.75, 12)], 2.4);
    m.add(horn.transformed([[1, 0, 0], [0, 0, 1], [0, 1, 0]], [0, sh - 1.2, 0]));
  }
  return {mesh: m, minR};
}

/* ---------------- fuselage shell segment with openings ---------------- */
function buildFuseSeg(F, x0, x1, t, openings, step, n) {
  const S = new Set([x0, x1]), add = v => { if (v > x0 + 0.2 && v < x1 - 0.2) S.add(+v.toFixed(4)); };
  const nReg = Math.max(1, Math.ceil((x1 - x0) / step));
  for (let i = 1; i < nReg; i++) add(x0 + (x1 - x0) * i / nReg);
  const ops = openings.filter(o => o.x1 > x0 + 0.2 && o.x0 < x1 - 0.2);
  for (const o of ops) { add(o.x0); add(o.x1); }
  const ys = [...S].sort((a, b) => a - b), N = ys.length;
  const rings = ys.map(x => ({o: F.ring(x, n), i: F.ring(x, n, -t)}));
  const active = j => { const m = (ys[j] + ys[j + 1]) / 2; return ops.filter(o => m > o.x0 && m < o.x1); };
  const zones = [];
  for (let j = 0; j < N - 1; j++) {
    const a = active(j), g = a.map(o => o.id).join(","), zl = zones[zones.length - 1];
    if (zl && zl.sig === g) zl.j1 = j + 1; else zones.push({sig: g, act: a, j0: j, j1: j + 1});
  }
  for (const z of zones) {
    if (!z.act.length) { z.outers = [j => rings[j].o]; z.holes = [j => rings[j].i.slice().reverse()]; continue; }
    const open = new Set(); z.act.forEach(o => o.idx.forEach(k => open.add(k)));
    const runs = []; let start = null;
    const firstKept = [...Array(n).keys()].find(k => !open.has(k) && open.has((k - 1 + n) % n));
    for (let q = 0; q < n; q++) {
      const k = (firstKept + q) % n;
      if (!open.has(k)) { if (start === null) start = k; }
      else if (start !== null) { runs.push([start, (k - 1 + n) % n]); start = null; }
    }
    if (start !== null) runs.push([start, (firstKept - 1 + n) % n]);
    for (const [a, b] of runs.slice()) if (a === b) {                  // one index of skin between two openings
      runs.splice(runs.indexOf(runs.find(q => q[0] === a && q[1] === b)), 1);
      open.add(a);
    }
    const seq = (a, b) => { const r = []; for (let k = a; ; k = (k + 1) % n) { r.push(k); if (k === b) break; } return r; };
    z.outers = runs.map(([a, b]) => j => { const ks = seq(a, b); return [...ks.map(k => rings[j].o[k]), ...ks.slice().reverse().map(k => rings[j].i[k])]; });
    z.holes = [];
  }
  const faces = [];
  for (let zi = 1; zi < zones.length; zi++) {
    const A = zones[zi - 1], B = zones[zi], j = B.j0;
    for (const o of ops) {
      const inA = A.act.includes(o), inB = B.act.includes(o);
      if (inA === inB) continue;
      const k0 = (o.idx[0] - 1 + n) % n, k1 = (o.idx[o.idx.length - 1] + 1) % n, ks = [];
      for (let k = k0; ; k = (k + 1) % n) { ks.push(k); if (k === k1) break; }
      faces.push({j, pts: [...ks.map(k => rings[j].o[k]), ...ks.slice().reverse().map(k => rings[j].i[k])], holes: [], sign: inB ? 1 : -1});
    }
  }
  return loftZoned(ys, zones, faces, [], false).transformed([[0, 1, 0], [1, 0, 0], [0, 0, 1]]);   // (y, x, z) -> (x, y, z)
}

/* ==========================================================================
   Aircraft assembly
   ========================================================================== */
function buildAircraft(A, opts = {}) {
  const L = A.L, p = A.p, W = L.wing, parts = [], zUse = p.bedZ - 8, clr = p.fitClear, manual = p.cutMode === "manual";
  const quick = !!opts.preview, step = quick ? 40 : 14, fuseStep = quick ? 25 : 10, nRing = quick ? 28 : 40;
  const insR = p.insertHole / 2, bossR = insR + 2.2, clearR = p.screwClear / 2;
  const bom = {inserts: 0, m3screws: 0, pins: [], hingePin: 0, servos: 0, straps: 0};
  const part = (name, group, mesh, printR, extra) => parts.push(Object.assign({name, group, mesh, printR, seg: 0}, extra || {}));
  const partInfo = (name, info) => { const q = parts.find(v => v.name === name); if (q) q.info = q.info ? q.info + ", " + info : info; };
  const U = XG.filter((_, i) => !quick || i % 2 === 0 || i === K);
  const insertU = u => { if (!U.some(v => Math.abs(v - u) < 1e-6)) { U.push(u); U.sort((a, b) => a - b); } };
  const warns = [];

  /* ================= wing features ================= */
  const half = W.half;
  let bounds = cutBounds(half, zUse, p.wingCuts, manual);
  if (W.cranked && W.yk > 15 && W.yk < half - 15) {                    // a cranked wing always splits at the kink
    if (!bounds.some(v => Math.abs(v - W.yk) < 12)) bounds = [...bounds, W.yk].sort((a, b) => a - b);
    for (let i = 1; i < bounds.length; i++) {
      const len = bounds[i] - bounds[i - 1];
      if (len > zUse) { const n = Math.ceil(len / zUse); for (let k = 1; k < n; k++) bounds.push(bounds[i - 1] + len * k / n); bounds.sort((a, b) => a - b); }
    }
  }
  const pin = p.pinSize !== "none" ? tubeFromKey(p.pinSize) : null, pinR = pin ? pin[0] / 2 + clr : 0;
  const skin = (w, u) => {                                             // twist-aware skin z at chord fraction u
    const P = foilPts(w, [0, u], p.minTE);
    return [P.up[1][1], P.lo[1][1], P.lo[1][0]];
  };
  /* Spar runs. A continuous tube has to be straight and square to the centerline to pass through
     both wings, so its bore is held at constant x and constant world z while the sections drift
     around it. One tube per side may instead follow each panel's own sweep and dihedral. */
  const kinkSeg = W.cranked ? bounds.findIndex(v => Math.abs(v - W.yk) < 12) : -1;
  const spars = [];
  /* The hinge line and the servo pocket are known before the control surface is cut, so a bore is
     never placed inside the aileron or through the space the servo has to live in. */
  const servo = p.servoType === "custom" ? {L: p.servoL, W: p.servoW, H: p.servoH, mass: p.servoMass} : SERVOS[p.servoType] || SERVOS.ds041;
  const uHinge = p.ctrlSurf ? XG.reduce((best, x) => Math.abs(x - p.hingePos) < Math.abs(best - p.hingePos) ? x : best, XG[0]) : 1;
  const csFrom = p.ctrlSurf ? p.csStart * half : Infinity, csTo = p.ctrlSurf ? p.csEnd * half : -Infinity;
  const pocketBand = p.ctrlSurf ? Math.max(servo.H, servo.W) + 4.8 + p.servoGap : 0;   // enough for the servo lying flat
  const fitsAt = (y, lx, lzCanon, r, intoPocket) => {
    const w = W.wingAt(y), u = (lx - w.x) / w.c;
    if (u < 0.05 || u > 0.9) return false;
    const keep = r + 4 + (intoPocket ? 0 : pocketBand);                // a wire channel ends in the pocket; a spar may not
    if (y >= csFrom - 20 && y <= csTo + 20 && u > uHinge - keep / w.c) return false;
    const [up, lo] = skin(w, u);
    return up - r - 1.2 >= lzCanon && lo + r + 1.2 <= lzCanon;
  };
  const reachOf = (line, r, y0, y1) => {                              // furthest y the bore still fits inside the skin
    let y = y0;
    for (let q = y0; q <= y1; q += 4) { const pt = line(q); if (!fitsAt(Math.min(q, y1 - 0.001), pt[0], pt[1], r)) break; y = q; }
    return y;
  };
  const committed = [], sparPorts = [];                               // bores already fixed, and where one crosses the shell
  const crosses = (line, r, yEnd) => committed.some(q => {            // two bores may never meet inside the skin
    for (let y = 0, yTop = Math.min(q.yEnd, yEnd); y <= yTop; y += 8)
      if (Math.abs(q.line(y)[0] - line(y)[0]) < q.r + r + 3) return true;
    return false;
  });
  const commit = sp => { committed.push({line: sp.line, r: sp.r, yEnd: sp.yEnd}); spars.push(sp); };
  const socketFor = od => TUBES.find(q => q[1] >= od) || TUBES[TUBES.length - 1];
  /* Where the section runs out of depth for the main tube, a thinner one carries on outboard,
     sliding into the end of the main tube — the way Titan and the Interceptor step their spars. */
  /* the span a level bore covers around a seed station, without leaving the skin */
  const spanAround = (line, r, seed, yLo, yHi) => {
    if (!fitsAt(seed, line(seed)[0], line(seed)[1], r)) return null;
    let a = seed, b = seed;
    for (let y = seed; y >= yLo; y -= 4) { const q = line(y); if (!fitsAt(Math.max(y, yLo), q[0], q[1], r)) break; a = Math.max(y, yLo); }
    for (let y = seed; y <= yHi; y += 4) { const q = line(y); if (!fitsAt(Math.min(y, yHi), q[0], q[1], r)) break; b = Math.min(y, yHi); }
    return [a, b];
  };
  /* A wingtip spar: its own straight tube in the outer wing, parallel to the main spar and at
     whatever chord station the thinner outer sections can take — the Trooper's 10 x 500 mm
     wingtip spars beside its 10 x 1000 mm main spars, all retained by the printed parts. */
  const tipSpar = (run, nm) => {
    if (!p.sparStep) return;
    const lap = Math.max(25, 0.07 * half);
    const from0 = Math.max(run.yStart + 30, run.yEnd - lap), yHi0 = half * 0.97;
    if (yHi0 - from0 < 90) return;                                     // nothing worth a second tube
    /* a tube cannot bend, so it stays within one panel of a cranked wing */
    const kink = W.cranked && W.yk > 10 && W.yk < half - 10 ? W.yk : 0;
    const mid0 = (from0 + yHi0) / 2;
    const from = kink && mid0 > kink ? Math.max(from0, kink + 2) : from0;
    const yHi = kink && mid0 <= kink ? Math.min(yHi0, kink - 2) : yHi0;
    if (yHi - from < 90) return;
    const seed = (from + yHi) / 2, anchor = W.wingAt(seed);
    let best = null;
    for (const tube of [run.tube, ...TUBES.filter(q => q[0] < run.tube[0]).reverse()]) {
      const r2 = tube[0] / 2 + clr;
      for (let u = 0.08; u <= 0.88; u += 0.02) {
        const sk = skin(anchor, u), x = sk[2], zc = (sk[0] + sk[1]) / 2;
        const line = y => [x, zc];                                     // straight, square to the centerline, in the panel
        const sp = spanAround(line, r2, seed, from, yHi);
        if (!sp || sp[1] - sp[0] < 90 || sp[1] < run.yEnd + 40) continue;
        if (crosses(line, r2, sp[1])) continue;
        if (!best || sp[1] > best.sp[1] + 5) best = {tube, r2, line, sp, u};
      }
      if (best) break;                                                 // the largest tube that fits wins
    }
    if (!best) return;
    commit({id: run.id + 300, tube: best.tube, yStart: best.sp[0], yEnd: best.sp[1], line: best.line, r: best.r2, continuous: false, tip: true});
    L.note("Structure", nm + ": the outer wing carries its own " + tubeLabel(best.tube) + " from " + fmtN(best.sp[0]) + " to "
      + fmtN(best.sp[1]) + " mm at " + fmtN(best.u * 100) + "% chord, parallel to the main spar and overlapping it by "
      + fmtN(Math.max(0, run.yEnd - best.sp[0])) + " mm. It is held by the printed parts, not glued.");
  };
  A.tubes.forEach((t, id) => {
    const r = t.tube[0] / 2 + clr, pos = t.pos, nm = id ? "Rear spar" : "Main spar";
    const w0 = W.wingAt(Math.min(half * 0.2, Math.max(2, W.blendEnd)));
    const levelAt = u => {                                             // level tube through the root section at u
      const sk = skin(w0, u), zW = W.dihZ(w0.y) + (sk[0] + sk[1]) / 2, x = sk[2];
      return {u, x, line: y => [x, zW - W.dihZ(y)]};                    // constant x and world z; canonical z drifts
    };
    /* One tube through both wings has to be straight and square to the centerline, so it cannot
       follow sweep: at the chord fraction asked for it may leave the planform a short way out.
       Slide it along the chord to where it reaches furthest, keeping the asked-for position
       unless moving really buys span. On a delta this puts it just ahead of the trailing edge. */
    const gap = Math.max(3, 0.09 * W.wingAt(0).c);                     // keep the two runs a useful distance apart
    const clear = c => !crosses(c.line, r + gap - 3, half * 0.97);
    const asked = levelAt(pos);
    let cont = Object.assign(asked, {reach: clear(asked) ? reachOf(asked.line, r, 0, half * 0.97) : 0});
    if (cont.reach < half * 0.75) {                                    // the asked-for line runs out of wing early
      const all = [];
      for (let u = Math.max(0.06, pos - 0.3); u <= Math.min(0.9, pos + 0.3); u += 0.02) {
        const c = levelAt(u);
        if (clear(c)) all.push(Object.assign(c, {reach: reachOf(c.line, r, 0, half * 0.97)}));
      }
      /* Slide to wherever a straight tube through both wings reaches furthest — on a delta that
         is just ahead of the straight trailing edge. The tips are simply too thin for any tube;
         a wingtip spar picks the outer wing up. Only move when it really buys span. */
      const far = Math.max(0, ...all.map(c => c.reach));
      const worth = p.sparLayout === "continuous" ? cont.reach : cont.reach + 0.15 * half;
      const good = far >= worth ? all.filter(c => c.reach >= far - 0.05 * half).sort((a, b) => Math.abs(a.u - pos) - Math.abs(b.u - pos)) : [];
      if (good.length) cont = good[0];
    }
    const contReach = cont.reach;
    /* A straight bore can be flown three ways: one tube all the way through, a tube per wing
       telescoping into a socket glued in the fuselage (Titan / Interceptor), or — when it cannot
       reach — a tube per side following the sweep with a separate joiner across the middle. */
    /* With a fuselage to glue sockets into, each wing carries its own tube and plugs in —
       that works at any sweep and dihedral, which one tube through the middle cannot.
       A wing with no fuselage has nothing to socket into, so it takes a tube all the way. */
    const socketing = L.hasFuse && (p.sparLayout === "telescope" || (p.sparLayout === "auto" && contReach < half * 0.5));
    const mode = p.sparLayout === "continuous" ? (contReach > half * 0.15 ? "cont" : "perside")
      : p.sparLayout === "telescope" || p.sparLayout === "perside" || p.sparLayout === "joiner" ? "perside"
      : contReach >= half * 0.5 ? "cont" : "perside";
    const where = " square to the centerline at " + fmtN(cont.u * 100) + "% of the root chord"
      + (Math.abs(cont.u - pos) > 0.03 ? " (asked for " + fmtN(pos * 100) + "%, but a straight tube cannot follow the sweep)" : "");
    if (mode === "cont") {
      const short = contReach < half * 0.85
        ? " " + nm + " reaches " + fmtN(contReach) + " mm of the " + fmtN(half) + " mm half span; outboard of that the section is too thin for the tube." : "";
      const main = {id: id * 4, tube: t.tube, yStart: 0, yEnd: contReach, line: cont.line, r, continuous: true, axis: "a" + id + "_c"};
      commit(main);
      L.note("Structure", nm + " is one continuous " + tubeLabel(t.tube) + " through the fuselage," + where + ", reaching " + fmtN(contReach) + " mm each side. It is the wing joiner: slide it out and the wings come off." + short);
      tipSpar(main, nm);
      if (L.hasFuse) sparPorts.push({x: cont.x, z: W.dihZ(0) + cont.line(0)[1], d: t.tube[0], label: nm.toLowerCase()});
      return;
    }
    if (p.sparLayout === "continuous" || p.sparLayout === "telescope") warns.push(nm + ": a straight tube square to the centerline leaves the skin after " + fmtN(contReach) + " mm, so it cannot be " + (p.sparLayout === "telescope" ? "telescoped into a fuselage socket" : "run through in one piece") + ". Reduce dihedral and sweep, or use the joiner layout.");
    const panels = W.cranked && W.yk > 15 && W.yk < half - 15 ? [[0, W.yk], [W.yk, half * 0.97]] : [[0, half * 0.97]];
    panels.forEach(([y0, y1], ri) => {
      /* A tube is straight: hold x and the section-relative height, so the bore is square to the
         centerline in plan and lies in the panel, following its dihedral. Anchoring it to a chord
         fraction instead would sweep it with the wing, which no straight tube can do. */
      const yA = Math.max(y0 + 1, Math.min(y0 + (y1 - y0) * 0.1, W.blendEnd));
      const atU = u => { const sk = skin(W.wingAt(yA), u); return {u, x: sk[2], line: y => [sk[2], (sk[0] + sk[1]) / 2]}; };
      let best = null;                                                  // slide along the chord to where it reaches furthest
      for (let u = Math.max(0.06, pos - 0.3); u <= Math.min(0.9, pos + 0.3); u += 0.02) {
        const c = atU(u), reach = reachOf(c.line, r, y0, y1);
        if (!best || reach > best.reach + 0.02 * half || (reach > best.reach - 0.02 * half && Math.abs(u - pos) < Math.abs(best.u - pos))) best = Object.assign(c, {reach});
      }
      const asked = atU(pos), askedReach = reachOf(asked.line, r, y0, y1);
      const picked = askedReach >= (y1 - y0) * 0.75 + y0 || !best || best.reach < askedReach + 0.15 * half ? Object.assign(asked, {reach: askedReach}) : best;
      const line = picked.line, end = picked.reach;
      if (end <= y0 + 20) return;
      if (crosses(line, r, end)) {
        if (ri === 0) warns.push(nm + ": no room for a tube in the inner panel clear of the other spar; move one of the spar positions.");
        return;                                                        // an outer panel is picked up by the wingtip spar
      }
      const run = {id: id * 4 + ri + 1, tube: t.tube, yStart: y0, yEnd: end, line, r, continuous: false, axis: "a" + id + "_" + ri};
      if (socketing && y0 < 1) {
        const sock = socketFor(t.tube[0]);
        const hwF = L.fuse.profile(Math.max(4, Math.min(line(0)[0], L.fuse.L - 4)))[0];
        const overlap = Math.min(70, Math.max(25, 0.07 * half));
        Object.assign(run, {telescope: true, socket: sock, overlap, sockLen: hwF + overlap + 6});
        const dx = (line(40)[0] - line(0)[0]) / 40, dz = (line(40)[1] - line(0)[1] + W.dihZ(40) - W.dihZ(0)) / 40;
        const inLine = Math.abs(dx) < 0.02 && Math.abs(dz) < 0.02;      // both sides on one axis: one tube can do both
        L.note("Structure", nm + ": one " + tubeLabel(t.tube) + " per wing, " + fmtN(end - y0 + overlap) + " mm long, sliding "
          + fmtN(overlap) + " mm into a " + tubeLabel(sock) + " socket glued into that side of the fuselage, so the wings pull off. Sand the socket or the tube for a snug sliding fit."
          + (inLine ? " The wing is flat and unswept here, so the two sockets can instead be one " + tubeLabel(sock) + " tube " + fmtN(2 * (hwF + overlap)) + " mm long straight through the fuselage." : ""));
      }
      commit(run);
      tipSpar(run, nm);
      if (L.hasFuse && y0 < 1) sparPorts.push({x: line(0)[0], z: W.dihZ(0) + line(0)[1], d: (run.socket || t.tube)[0], label: nm.toLowerCase()});
    });
    L.note("Structure", nm + ": one straight tube per side" + (p.sparLayout === "perside" ? "" : " (a continuous tube would reach only " + fmtN(contReach) + " mm)") + ".");
    /* center joiner: a short straight tube square to the centerline that carries the root bending
       across the fuselage and lets the wings come off, as on printed twin-spar airframes */
    if (id === 0 && p.sparLayout !== "perside" && !(socketing && spars.some(sp => sp.telescope))) {
      /* try the offset as given, then mirrored: on a swept wing only one side of the spar is clear */
      let best = null;
      for (const off of [p.joinerPos, -p.joinerPos]) {
        const jPos = Math.min(0.8, Math.max(0.06, pos + off));
        const jw = W.wingAt(Math.min(half * 0.2, Math.max(2, W.blendEnd))), jsk = skin(jw, jPos);
        const jx = jsk[2], jz = W.dihZ(jw.y) + (jsk[0] + jsk[1]) / 2;
        const jline = y => [jx, jz - W.dihZ(y)];
        const jEnd = Math.min(reachOf(jline, r, 0, half * p.joinerReach), half * p.joinerReach);
        if (!crosses(jline, r, jEnd) && jEnd > half * 0.12 && (!best || jEnd > best.jEnd)) best = {jPos, jline, jEnd};
      }
      if (best) {
        commit({id: 99, tube: t.tube, yStart: 0, yEnd: best.jEnd, line: best.jline, r, continuous: true, joiner: true});
        if (L.hasFuse) sparPorts.push({x: best.jline(0)[0], z: W.dihZ(0) + best.jline(0)[1], d: t.tube[0], label: "center joiner"});
        L.note("Structure", "Center joiner: one " + tubeLabel(t.tube) + " through the fuselage at " + fmtN(best.jPos * 100) + "% chord, " + fmtN(best.jEnd) + " mm into each wing, carrying the root bending between the panels.");
      } else warns.push("No room for a center joiner tube clear of the main spar; change the joiner offset, or bolt or glue the wing panels to the fuselage instead.");
    }
  });
  const sparXAt = y => spars.filter(sp => y >= sp.yStart - 1 && y <= sp.yEnd + 1).map(sp => [sp.line(y)[0], sp.r]);
  /* what to buy: a continuous tube spans both sides, otherwise one tube per side per run */
  bom.sparRuns = spars.map(sp => ({tube: sp.tube, len: sp.yEnd - sp.yStart + (sp.telescope ? sp.overlap : 0) + (sp.continuous && !sp.telescope ? sp.yEnd : 0), count: sp.continuous && !sp.telescope ? 1 : 2, continuous: sp.continuous && !sp.telescope, telescope: !!sp.telescope, tip: !!sp.tip, joiner: !!sp.joiner,
    role: sp.joiner ? "Center joiner" : sp.tip ? (sp.id % 300 < 4 ? "Main" : "Rear") + " wingtip spar" : (sp.id < 4 ? "Main spar" : "Rear spar")
      + (sp.telescope ? ", telescopes into the fuselage socket" : sp.continuous ? ", continuous" : W.cranked && sp.yStart > 1 ? ", outer panel" : W.cranked ? ", inner panel" : "")}));
  for (const sp of spars) if (sp.telescope)                           // the socket each wing tube slides into
    bom.sparRuns.push({tube: sp.socket, len: sp.sockLen, count: 2, socket: true,
      role: (sp.id < 4 ? "Main" : "Rear") + " spar socket, glued into each side of the fuselage"});

  /* control surfaces (ailerons / elevons) */
  let wcs = null;
  const hingeD = HINGE_PINS[p.hingePin]?.d || 0;
  if (p.ctrlSurf) {
    const a = Math.max(W.blendEnd + 5, p.csStart * half), b = Math.min(half - 6, p.csEnd * half);
    if (b - a > 40) {
      const uH = XG.reduce((best, x) => Math.abs(x - p.hingePos) < Math.abs(best - p.hingePos) ? x : best, XG[0]);
      insertU(uH);
      const lineEnd = y => {
        const w = W.wingAt(y), P = foilPts(w, U, p.minTE), iH = U.indexOf(uH), xh = P.lo[iH][0];
        let xp = xh + p.hingeGap + 2, R = 2;
        for (let it = 0; it < 4; it++) { const [zu, zl] = skinAtX(P, xp); R = (zu - zl) / 2; xp = xh + p.hingeGap + R; }
        const [zu, zl] = skinAtX(P, xp);
        return [xp, (zu + zl) / 2];
      };
      const Pa = lineEnd(a), Pb = lineEnd(b);
      const line = y => { const u = (y - a) / (b - a); return [lerp(Pa[0], Pb[0], u), lerp(Pa[1], Pb[1], u)]; };
      wcs = {a, b, uH, line, depth: 12, pinR: hingeD ? hingeD / 2 + clr : 0};
    } else warns.push("Control surface span is too short to cut; widen the start and end positions.");
  }

  /* servo, VTOL hardpoint pockets */
  const bays = [];
  const makeBay = (id, sMid, lenS, xFront, xBack, depth, side, kind, meta) => {
    const w = W.wingAt(sMid), ua = (xFront - w.x) / w.c, ub = (xBack - w.x) / w.c;
    if (ua < 0.06 || ub > 0.92 || ub - ua < 0.02) return null;
    return {id, a: sMid - lenS / 2, b: sMid + lenS / 2, ua, ub, depth, side, kind, meta};
  };
  if (wcs) {
    const wm = W.wingAt((wcs.a + wcs.b) / 2), [zu, zl] = skin(wm, wcs.uH - 0.12), thick = zu - zl;
    const canStand = p.servoOrient === "stand" || (p.servoOrient === "auto" && thick >= servo.H + 3);
    const lenS = servo.L + 22 + 0.4;
    let sMid = lerp(wcs.a + lenS / 2 + 2, Math.max(wcs.a + lenS / 2 + 2, wcs.b - lenS / 2 - 2), p.servoPos);
    const seg = bounds.findIndex((v, i) => i < bounds.length - 1 && sMid >= v && sMid < bounds[i + 1]);
    const lo = bounds[seg] + (pin ? p.pinDepth : 0) + 4 + lenS / 2, hi = bounds[seg + 1] - (pin ? p.pinDepth : 0) - 4 - lenS / 2;
    if (hi > lo) sMid = Math.min(hi, Math.max(lo, sMid));
    /* Fit the pocket between the rear spar and the hinge. A straight spar sits at a different
       chord fraction out here than at the root, so the room asked for inboard may not be free:
       slide the pocket toward the hinge, then inboard where the chord is deeper, and stand the
       servo up where the section allows — whichever combination actually fits. */
    const sWant = sMid, sIn = wcs.a + lenS / 2 + 2, sOut = Math.max(sIn, wcs.b - lenS / 2 - 2);
    let bay = null, usedGap = p.servoGap, stand = false, usedS = sMid;
    for (let step = 0; step <= 24 && !bay; step++) {
      const sTry = Math.min(sOut, Math.max(sIn, sWant - step * 12));
      const wT = W.wingAt(sTry), xH = wT.x + wcs.uH * wT.c;
      const sk = skin(wT, wcs.uH - 0.12), deep = sk[0] - sk[1] >= servo.H + 3;
      const ways = p.servoOrient === "flat" ? [false] : p.servoOrient === "stand" ? [true] : deep ? [true, false] : [false];
      for (const upright of ways) {
        const chord = (upright ? servo.W : servo.H) + 2 * 2.4 + 0.4, depth = (upright ? servo.H : servo.W) + 1;
        for (let gap = p.servoGap; gap >= 1 && !bay; gap -= 1) {
          const cand = makeBay("servo", sTry, lenS, xH - gap - chord, xH - gap, depth, "bottom", "servo", {stand: upright, servo});
          if (cand && !sparXAt(sTry).some(([sx, sr]) => sx + sr + 2 > wT.x + cand.ua * wT.c)) { bay = cand; usedGap = gap; stand = upright; usedS = sTry; }
        }
        if (bay) break;
      }
      if (sTry <= sIn + 0.1 && step > 0) break;
    }
    if (bay) {
      bays.push(bay);
      if (Math.abs(usedS - sWant) > 1 || usedGap < p.servoGap - 0.5)
        L.note("Systems", `Servo pocket sits ${fmtN(usedS)} mm out and ${fmtN(usedGap)} mm ahead of the hinge, ${stand ? "standing" : "lying flat"} — that is what fits between the rear spar and the hinge here.`);
    } else warns.push("The servo pocket cannot be fitted between the rear spar and the hinge anywhere along the aileron. Move the hinge aft, move the rear spar forward, or choose a slimmer servo.");
  }
  let hardpoints = null;
  if (p.vtol === "quad") {
    const yb = p.vtolBoomY * half, w = W.wingAt(yb), sx = sparXAt(yb);
    const frontX = (sx.length ? Math.max(...sx.map(([x, r]) => x + r)) : w.x + 0.28 * w.c) + 3;
    const rearBack = wcs ? w.x + wcs.uH * w.c - 4 : w.x + 0.66 * w.c;
    const hpA = makeBay("hpF", yb, 34, frontX, frontX + 18, 9, "bottom", "hardpoint"), hpB = makeBay("hpR", yb, 34, rearBack - 18, rearBack, 9, "bottom", "hardpoint");
    if (hpA && hpB) {
      for (const sv of bays.filter(q => q.kind === "servo")) if (sv.b > hpB.a - 4 && sv.a < hpB.b + 4) { const shift = hpB.b + 6 - sv.a; sv.a += shift; sv.b += shift; }
      bays.push(hpA, hpB); hardpoints = {yb, hpA, hpB};
    } else warns.push("VTOL hardpoints do not fit at the boom station; move the booms.");
  }
  /* keep every pocket inside one printed segment, clear of the joiner pins */
  for (const b of bays.slice()) {
    const len = b.b - b.a, mid = (b.a + b.b) / 2, seg = Math.max(0, bounds.findIndex((v, i) => i < bounds.length - 1 && mid >= v && mid < bounds[i + 1]));
    const lo = bounds[seg] + (pin ? p.pinDepth : 0) + 3, hi = bounds[seg + 1] - (pin ? p.pinDepth : 0) - 3;
    if (hi - lo < len) { bays.splice(bays.indexOf(b), 1); warns.push(`The ${b.kind === "servo" ? "servo" : "VTOL hardpoint"} pocket does not fit between wing cuts; move the cuts.`); if (b.kind === "hardpoint") hardpoints = null; continue; }
    const shift = Math.min(hi - b.b, Math.max(lo - b.a, 0));
    b.a += shift; b.b += shift;
  }
  if (hardpoints && !bays.includes(hardpoints.hpA)) hardpoints = null;
  for (const b of bays) { insertU(b.ua); insertU(b.ub); }
  for (const b of bays) {
    b.ia = U.indexOf(b.ua); b.ib = U.indexOf(b.ub);
    const lowest = s => { const w = W.wingAt(s), P = foilPts(w, U, p.minTE); let z = Infinity; for (let i = b.ia; i <= b.ib; i++) z = Math.min(z, P.lo[i][1]); return z; };
    const topMin = s => { const w = W.wingAt(s), P = foilPts(w, U, p.minTE); let z = Infinity; for (let i = b.ia; i <= b.ib; i++) z = Math.min(z, P.up[i][1]); return z; };
    b.zBot = Math.min(lowest(b.a), lowest(b.b), lowest((b.a + b.b) / 2));
    const ceiling = Math.min(topMin(b.a), topMin(b.b)) - 1.2;
    b.roofZ = Math.min(b.zBot + b.depth, ceiling);
    b.protrudes = b.zBot + b.depth - ceiling;
    b.roof = () => b.roofZ;
    if (b.protrudes > 0.5) warns.push(`${b.kind === "servo" ? "Servo" : "Hardpoint"} pocket is ${fmtN(b.protrudes, 1)} mm deeper than the wing; the ${b.kind === "servo" ? "servo cover" : "block"} will stand proud.`);
  }
  const iH = wcs ? U.indexOf(wcs.uH) : -1;
  if (wcs) wcs.iH = iH;

  /* Wire channels. A bore from the root face to the servo pocket carries the servo lead,
     and on a twin the ESC leads get their own bore out to the nacelle station. The bore
     dies at the pocket wall, where the loft turns it into an opening into the pocket. */
  const wirePorts = [];
  if (p.wireCh) {
    const sizes = [];                                                  // the chosen size first, then thinner
    for (let d = p.wireD; d >= 2.9; d -= 1) sizes.push(d);
    const runIn = (yEnd, uE, zEnd, id, label, mouth) => {               // root -> (uE, zEnd) at yEnd
      const w1 = W.wingAt(yEnd), xFix = w1.x + uE * w1.c;              // straight: one x, one height
      const line = () => [xFix, zEnd];
      for (const d of sizes) {
        const rw = d / 2 + clr;
        if (mouth && !holeRing(mouth.x, mouth.z, rw, 24).every(q => inPoly(q[0], q[1], mouth.poly))) continue;
        let ok = true;
        for (let y = 0; y <= yEnd && ok; y += 3) {
          const yc = Math.min(y, yEnd - 0.01), q = line(yc);
          if (!fitsAt(yc, q[0], q[1], rw, true) || sparXAt(yc).some(([sx, sr]) => Math.abs(sx - q[0]) < sr + rw + 1.5)) ok = false;
        }
        if (!ok) continue;
        spars.push({id, tube: null, yStart: 0, yEnd, line, r: rw, wire: true, label, d});
        const q0 = line(0);
        wirePorts.push({x: q0[0], z: W.dihZ(0) + q0[1], lateral: true, label, d});
        return d;
      }
      return 0;
    };
    const cut = (d, what) => d && d < p.wireD - 0.01
      ? ` It was narrowed from ${fmtN(p.wireD)} mm because that is all the ${what} carries.` : "";
    const sv = bays.find(b => b.kind === "servo");
    if (sv) {
      const w = W.wingAt(sv.a), P = foilPts(w, U, p.minTE);
      let loMax = -Infinity; for (let i = sv.ia; i <= sv.ib; i++) loMax = Math.max(loMax, P.lo[i][1]);
      const poly = [...P.lo.slice(sv.ia, sv.ib + 1), [P.lo[sv.ib][0], sv.roofZ], [P.lo[sv.ia][0], sv.roofZ]];
      const uE = (sv.ua + sv.ub) / 2, zE = (loMax + sv.roofZ) / 2;
      const d = runIn(sv.a, uE, zE, 210, "servo lead", {x: w.x + uE * w.c, z: zE, poly});
      if (d) L.note("Systems", `Servo lead: a ${fmtN(d)} mm channel runs ${fmtN(sv.a)} mm from the root face into the servo pocket.${cut(d, "wing")}`);
      else warns.push("No room for a servo wire channel inside the wing, even at 3 mm: the run from the root to the pocket leaves the skin or meets a spar. Move the spar or the pocket, or run the lead outside.");
    }
    if (p.wireEsc && p.motorLayout === "twin") for (const [i, nc] of L.nacelles.entries()) {
      const yn = Math.abs(nc.y);
      if (yn < 30 || yn > half - 10) continue;
      const w = W.wingAt(yn), sx = sparXAt(yn);
      let d = 0;
      for (let uE = 0.12; uE <= 0.72 && !d; uE += 0.04) {               // wherever it clears the spars and the skin
        const sk = skin(w, uE);
        d = runIn(yn - 4, uE, (sk[0] + sk[1]) / 2, 220 + i, "ESC leads", null);
      }
      if (d) L.note("Systems", `ESC leads: a ${fmtN(d)} mm channel runs from the root face to ${fmtN(yn)} mm, under the nacelle. Open its end into the nacelle with a ${fmtN(d)} mm drill through the top skin before gluing the nacelle on.${cut(d, "wing")}`);
      else warns.push("No room for an ESC wire channel out to the nacelle; run the motor leads along the outside of the wing.");
    }
  }

  /* joiner pins at a cut, clear of spars, pockets and the hinge cut */
  const pinsAt = yc => {
    if (!pin) return [];
    const w = W.wingAt(yc), out = [], spU = sparXAt(yc).map(([x, r]) => [(x - w.x) / w.c, r]);
    const csHere = wcs && yc > wcs.a - 1 && yc < wcs.b + 1, uMax = csHere ? wcs.uH - (pinR + 3) / w.c : 0.85;
    for (const u0 of [0.13, Math.min(0.68, uMax)]) {
      let best = null;
      for (let du = 0; du <= 0.12 && !best; du += 0.01) for (const u of [u0 + du, u0 - du]) {
        if (best || u < 0.06 || u > uMax) continue;
        if (spU.some(([su, sr]) => Math.abs(su - u) * w.c < pinR + sr + 2.5)) continue;
        if (bays.some(b => yc > b.a - p.pinDepth - 2 && yc < b.b + p.pinDepth + 2 && u > b.ua - 0.03 && u < b.ub + 0.03)) continue;
        if (out.some(q => Math.abs(q[2] - u) * w.c < 2 * pinR + 3)) continue;
        const [up, lo, x] = skin(w, u);
        if (up - lo >= 2 * pinR + 2.4) best = [x, (up + lo) / 2, u];
      }
      if (best) out.push(best);
    }
    return out.map(q => [q[0], q[1]]);
  };

  /* ================= wing segments ================= */
  const toWorld = side => (x, s, z) => [x, side * s, W.dihZ(s) + z];
  const standRoot = side => side > 0 ? [[1, 0, 0], [0, 0, -1], [0, 1, 0]] : [[1, 0, 0], [0, 0, 1], [0, -1, 0]];
  const flatUp = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], flatDown = [[1, 0, 0], [0, -1, 0], [0, 0, -1]];
  const nSeg = bounds.length - 1;
  let vtolBoom = null, hornMark = null, servoMark = null, tailHornMark = null;
  for (let si = 0; si < nSeg; si++) {
    const s0 = bounds[si], s1 = bounds[si + 1];
    const segBays = bays.filter(b => b.a >= s0 - 0.1 && b.b <= s1 + 0.1);
    const pinsIn = pinsAt(s0), pinsOut = s1 < half - 1 ? pinsAt(s1) : [];
    const local = buildLiftSeg({s0, s1, step, breaks: W.breaks, sectionAt: W.wingAt, U, minTE: p.minTE, cs: wcs ? {...wcs, pin: wcs.pinR ? {line: wcs.line, r: wcs.pinR} : null} : null,
      bays: segBays, spars: spars.filter(sp => sp.yStart < s1 - 0.5 && sp.yEnd > s0 + 0.5), pinsIn, pinsOut, pinR, pinDepth: p.pinDepth, meta: true});
    const extras = [];
    // control surface piece within this segment
    if (wcs && wcs.b > s0 + 1 && wcs.a < s1 - 1) {
      const a = wcs.a >= s0 ? wcs.a + p.hingeGap / 2 : s0 + 0.3, b = wcs.b <= s1 ? wcs.b - p.hingeGap / 2 : s1 - 0.3;
      const servoAll = bays.find(q => q.kind === "servo");
      const hornG = p.hornAuto && servoAll ? (servoAll.a + servoAll.b) / 2 : lerp(wcs.a + 6, wcs.b - 6, p.hornPos);
      const hornS = hornG > a + 3 && hornG < b - 3 ? hornG : null;
      const csPart = buildCSPart({a, b, step, sectionAt: W.wingAt, U, minTE: p.minTE, iH, line: wcs.line, pinR: wcs.pinR, horn: hornS, hornDepth: p.hornLen, hornSide: p.hornSide});
      if (hornS != null) { const [hx, hz] = wcs.line(hornS); hornMark = {s: hornS, x: hx, z: hz}; }
      if (wcs.pinR && csPart.minR < wcs.pinR + 0.8) warns.push("The hinge pin is too thick for the control surface nose; choose a thinner pin or move the hinge forward.");
      extras.push({name: L.tailless ? "elevon" : "aileron", group: "ctrl", mesh: csPart.mesh, print: "stand", settings: "Stand on its end, 2 walls, 15% infill. Slide the hinge pin through the wing pockets and this part."});
      if (wcs.pinR) bom.hingePin += (b - a) + 2 * wcs.depth;
    }
    for (const b of segBays) {
      const w = W.wingAt((b.a + b.b) / 2), xa = w.x + b.ua * w.c, xb = w.x + b.ub * w.c, xm = (xa + xb) / 2, sm = (b.a + b.b) / 2;
      if (b.kind === "servo") {
        servoMark = {s: sm, x: xm, z: b.zBot};
        const sv = b.meta.servo, dc = (b.meta.stand ? sv.W : sv.H) + 0.4, pad = 11;
        const th = Math.max(2, b.roofZ - 0.3 - b.zBot);
        const ins = [[xm, b.a + pad / 2], [xm, b.b - pad / 2]];
        const frame = plate(rect(xa + 0.25, b.a + 0.25, xb - 0.25, b.b - 0.25), [rect(xm - dc / 2, sm - (sv.L + 0.5) / 2, xm + dc / 2, sm + (sv.L + 0.5) / 2), ...ins.map(q => circle(q[0], q[1], insR, 16))], th)
          .transformed(ID3, [0, 0, b.zBot]);
        extras.push({name: "servo_frame", group: "ctrl", mesh: frame, print: "flat", settings: "PETG, 3 perimeters. Glue into the pocket, then press in 2 × M3 heat-set inserts from below."});
        const cover = plate(rect(xa + 0.25, b.a + 0.25, xb - 0.25, b.b - 0.25), [...ins.map(q => circle(q[0], q[1], clearR, 14)), rect(xb - 7.5, b.b - pad - 13, xb - 1.5, b.b - pad - 1)], 1.2)
          .transformed(ID3, [0, 0, b.zBot - 1.2]);
        extras.push({name: "servo_cover", group: "ctrl", mesh: cover, print: "flat", settings: "PETG or LW-PLA, 2 perimeters. Screws on with 2 × M3; the slot passes the pushrod."});
        bom.inserts += 2; bom.m3screws += 2; bom.servos++;
      } else {
        const th = Math.max(3, b.roofZ - 0.3 - (b.zBot - 1));
        const block = plate(rect(xa + 0.25, b.a + 0.25, xb - 0.25, b.b - 0.25), [circle(xm, b.a + 8, insR, 16), circle(xm, b.b - 8, insR, 16)], th).transformed(ID3, [0, 0, b.zBot - 1]);
        extras.push({name: `vtol_hardpoint_${b.id === "hpF" ? "front" : "rear"}`, group: "vtol", mesh: block, print: "flat", settings: "PETG, 4 perimeters, 40% infill. Glue into the pocket; press in 2 × M3 inserts from below."});
        bom.inserts += 2;
      }
    }
    // VTOL saddle, boom clamps and motor mounts, built where the hardpoints are
    if (hardpoints && hardpoints.yb >= s0 && hardpoints.yb < s1) {
      const {yb, hpA, hpB} = hardpoints, w = W.wingAt(yb);
      const xa = w.x + hpA.ua * w.c, xb = w.x + hpB.ub * w.c, zTop = Math.min(hpA.zBot, hpB.zBot) - 1;
      const holes = [hpA, hpB].flatMap(h => { const xm = w.x + (h.ua + h.ub) / 2 * w.c; return [circle(xm, h.a + 8, clearR, 14), circle(xm, h.b - 8, clearR, 14)]; });
      const d = A.L.booms.find(q => q.role === "vtol")?.tube[0] || 16, rb = d / 2;
      const zc = zTop - 4 - rb - 3;
      const sad = new Mesh().add(plate(roundRect(xa - 4, yb - 20, xb + 4, yb + 20, 4), holes, 4).transformed(ID3, [0, 0, zTop - 4]));
      for (const xc of [w.x + (hpA.ua + hpA.ub) / 2 * w.c, w.x + (hpB.ua + hpB.ub) / 2 * w.c])
        sad.add(plate([[yb - rb - 5, zc - rb - 5], [yb + rb + 5, zc - rb - 5], [yb + rb + 5, zTop - 3.5], [yb - rb - 5, zTop - 3.5]], [holeRing(yb, zc, rb + 0.15, 28).reverse()], 16).transformed([[0, 0, 1], [1, 0, 0], [0, 1, 0]], [xc - 8, 0, 0]));
      extras.push({name: "vtol_boom_saddle", group: "vtol", mesh: sad, print: "down", settings: "PETG, 4 perimeters, 40% infill. Bolts to the wing hardpoints with 4 × M3."});
      bom.m3screws += 4;
      const Rprop = p.liftPropD * IN / 2, xf = w.x - Rprop - 20, xr = w.x + w.c + Rprop + 20;
      vtolBoom = {yb, zc, xf, xr, d};
      for (const [xm, tag] of [[xf, "front"], [xr, "rear"]]) {
        const mm = new Mesh();
        mm.add(plate([[yb - rb - 5, zc - rb - 5], [yb + rb + 5, zc - rb - 5], [yb + rb + 5, zc + rb + 3], [yb - rb - 5, zc + rb + 3]], [holeRing(yb, zc, rb + 0.15, 28).reverse()], 16).transformed([[0, 0, 1], [1, 0, 0], [0, 1, 0]], [xm - 8, 0, 0]));
        mm.add(mountPlate(p.liftMountPattern, A.liftMotor, d + 10).transformed(ID3, [xm, yb, zc + rb + 2]));
        extras.push({name: `lift_motor_mount_${tag}`, group: "vtol", mesh: mm, print: "flat", settings: PETG_NOTE + " Clamp to the boom, motor screws into the plate."});
      }
    }
    for (const side of [1, -1]) {
      const map = toWorld(side), sfx = side > 0 ? "R" : "L", segSfx = nSeg > 1 ? "_" + (si + 1) : "";
      const nPins = pinsIn.length + pinsOut.length;
      const info = [...spars.filter(sp => sp.yStart < s1 - 0.5 && sp.yEnd > s0 + 0.5).map(sp => sp.wire ? `${fmtN(sp.d)} mm ${sp.label} channel` : `${tubeLabel(sp.tube)} ${sp.joiner ? "joiner" : "spar"} bore`), nPins ? `${nPins} × ${pin[0]} mm pin pockets` : "", segBays.length ? segBays.map(b => b.kind === "servo" ? "servo pocket" : "hardpoint pocket").join(", ") : ""].filter(Boolean).join(", ");
      part(`wing_${sfx}${segSfx}`, "wing", local.mapped(map, side < 0), standRoot(side), {seg: si, cp: true, side, info,
        settings: "Stand on the root face. 1–2 walls, 0% infill, 3 bottom layers, no supports. Add 2 perimeters around bores with a slicer modifier."});
      if (nPins) bom.pins.push(...Array(nPins).fill(p.pinDepth * 2));
      for (const ex of extras) {
        const nm = `${ex.name}_${sfx}${ex.name.startsWith("aileron") || ex.name.startsWith("elevon") ? segSfx : ""}`;
        const R = ex.print === "stand" ? standRoot(side) : ex.print === "down" ? flatDown : flatUp;
        part(nm, ex.group, ex.mesh.mapped(map, side < 0), R, {seg: si, side, settings: ex.settings});
      }
    }
  }
  bom.pins = bom.pins.map(v => v / 2);                                   // each pin shared by two pockets

  /* ================= tail panels ================= */
  const rod = !L.tailless && p.stabSpar !== "none" ? tubeFromKey(p.stabSpar) : null;
  const tbayA = (sMid, lenS) => [sMid - lenS / 2, sMid + lenS / 2];
  const panelParts = (st, name, group, mirrored, settings, opt = {}) => {
    const root = st[0], tip = st[st.length - 1];
    const spanDir = vnorm([0, tip.y - root.y, tip.z - root.z]), len = Math.hypot(tip.y - root.y, tip.z - root.z);
    const thick = vcross([1, 0, 0], spanDir);
    const pb = cutBounds(len, zUse, p.tailCuts, manual && opt.cuttable);
    const at = s => { const t = Math.min(1, Math.max(0, s / len)), fi = t * (st.length - 1), i0 = Math.min(st.length - 2, Math.floor(fi)), u = fi - i0, a = st[i0], b = st[i0 + 1]; return {x: lerp(a.x, b.x, u) - root.x, c: lerp(a.c, b.c, u), fA: a.fA, fB: a.fB, s: 0, twist: 0}; };
    const Up = XG.filter((_, i) => !quick || i % 2 === 0 || i === K);
    let rodLine = null;
    if (rod && opt.rod) {
      const r = rod[0] / 2 + clr, P0 = foilPts(at(0), [0, 0.3], p.minTE), P1 = foilPts(at(len * 0.85), [0, 0.3], p.minTE);
      const x0 = P0.lo[1][0], x1 = P1.lo[1][0], z0 = (P0.lo[1][1] + P0.up[1][1]) / 2, z1 = (P1.lo[1][1] + P1.up[1][1]) / 2;
      const line = s => [lerp(x0, x1, s / (len * 0.85)), lerp(z0, z1, s / (len * 0.85))];
      let sEnd = 0;
      for (let k = 1; k <= 40; k++) {
        const s = len * 0.85 * k / 40, a2 = at(s), [lx, lz] = line(s), u = (lx - a2.x) / a2.c, P = foilPts(a2, [0, u], p.minTE);
        if (u > 0.06 && u < 0.6 && P.up[1][1] - r - 1 >= lz && P.lo[1][1] + r + 1 <= lz) sEnd = s; else break;
      }
      if (sEnd > len * 0.2) rodLine = {line, r, sEnd};
    }
    let tcs = null;
    if (p.ctrlSurf && p.tailCtrl && opt.cs) {
      const a = Math.max(6, len * 0.06), b = len - 4, uH = XG.reduce((bb, x) => Math.abs(x - 0.68) < Math.abs(bb - 0.68) ? x : bb, XG[0]);
      if (!Up.includes(uH)) { Up.push(uH); Up.sort((q, r) => q - r); }
      const lineEnd = s => { const P = foilPts(at(s), Up, p.minTE), xh = P.lo[Up.indexOf(uH)][0]; let xp = xh + p.hingeGap + 1.5, R = 1.5; for (let it = 0; it < 4; it++) { const [zu, zl] = skinAtX(P, xp); R = (zu - zl) / 2; xp = xh + p.hingeGap + R; } const [zu, zl] = skinAtX(P, xp); return [xp, (zu + zl) / 2]; };
      const Pa = lineEnd(a), Pb = lineEnd(b), line = s => { const u = (s - a) / (b - a); return [lerp(Pa[0], Pb[0], u), lerp(Pa[1], Pb[1], u)]; };
      tcs = {a, b, uH, iH: Up.indexOf(uH), line, depth: 8, pinR: hingeD ? hingeD / 2 + clr : 0};
    }
    /* Servo bay in the panel itself, as on the Titan and Flightory tails: the servo lies
       flat ahead of the hinge, a glued frame carries two M3 inserts and a cover screws on.
       A printed tail is thin, so the fit is checked and the bay is skipped with advice. */
    let tbay = null;
    if (tcs && p.tailServo) {
      const lenS = servo.L + 16 + 0.4;
      const loW = lenS / 2 + 4, hiW = tcs.b - lenS / 2 - 4;
      let sMid = lerp(loW, Math.max(loW, hiW), p.tailServoPos);
      const dP = pin ? Math.min(p.pinDepth, 14) : 0;
      const segi = Math.max(0, pb.findIndex((v, i) => i < pb.length - 1 && sMid >= v - 0.001 && sMid < pb[i + 1]));
      const loS = pb[segi] + dP + 4 + lenS / 2, hiS = pb[segi + 1] - dP - 4 - lenS / 2;
      if (hiS > loS) sMid = Math.min(hiS, Math.max(loS, sMid));
      const m = at(sMid);
      const chord = servo.H + 2 * 2.2 + 0.4, want = servo.W + 1;        // lying flat: a printed tail is rarely thicker
      /* depth the panel can swallow with the bay's back edge at chord fraction ub */
      const roomAt = ub => {
        const ua = ub - chord / m.c;
        if (ua < 0.08 || ub > 0.94) return null;
        let deep = Infinity;
        for (const s of [tbayA(sMid, lenS)[0], sMid, tbayA(sMid, lenS)[1]]) {
          const P = foilPts(at(s), [0, ua, ub], p.minTE);
          deep = Math.min(deep, P.up[1][1] - P.lo[1][1] - 1, P.up[2][1] - P.lo[2][1] - 1);
        }
        const mid = m.x + (ua + ub) / 2 * m.c;
        if (rodLine && sMid < rodLine.sEnd + 4 && Math.abs(rodLine.line(Math.min(sMid, rodLine.sEnd))[0] - mid) < rodLine.r + chord / 2 + 2) return null;
        return {ua, ub, deep};
      };
      let cand = null;
      if (p.tailServoChord === "hinge") cand = roomAt((m.x + (tcs.uH - 0.02) * m.c - p.tailServoGap - m.x) / m.c);
      else for (let ub = tcs.uH - 0.03; ub >= 0.16; ub -= 0.01) {        // thickest station that still clears the rod
        const r = roomAt(ub);
        if (r && (!cand || r.deep > cand.deep + 0.15)) cand = r;
        if (cand && cand.deep >= want) break;
      }
      const what = name === "fin" ? "fin" : name === "vtail" ? "V-tail panel" : "stabiliser";
      const blister = cand ? Math.max(0, want - cand.deep) : 0;
      if (!cand)
        warns.push(`No room for a servo bay in the ${what}: every station ahead of the hinge is blocked by the tail rod or too close to an edge. Move the hinge aft, set the tail spar to none, or drive the surface with a pushrod from the fuselage.`);
      else if (hiS <= loS)
        warns.push(`The ${what} servo bay does not fit between the tail cuts; move the cuts or turn the tail servo bay off.`);
      else if (blister > p.tailBlisterMax + 0.01)
        warns.push(`The ${what} is ${fmtN(cand.deep + 1, 1)} mm thick at its deepest usable station, so a servo lying flat would need a ${fmtN(blister, 1)} mm blister on the cover — more than the ${fmtN(p.tailBlisterMax, 1)} mm allowed. Raise the blister limit, use a thicker tail airfoil or a larger tail, or drive the surface with a pushrod from the fuselage.`);
      else {
        const ua = cand.ua, ub = cand.ub, depth = Math.min(want, cand.deep);
        for (const u of [ua, ub]) if (!Up.some(v => Math.abs(v - u) < 1e-6)) Up.push(u);
        Up.sort((q, r) => q - r);
        tcs.iH = Up.indexOf(tcs.uH);                                     // Up just grew: re-index the hinge station
        tbay = {id: "tsv", a: sMid - lenS / 2, b: sMid + lenS / 2, ua, ub, depth, side: "bottom", kind: "servo", meta: {servo, blister}};
        tbay.ia = Up.indexOf(ua); tbay.ib = Up.indexOf(ub);
        const edge = (s, w) => { const P = foilPts(at(s), Up, p.minTE); let z = Infinity; for (let i = tbay.ia; i <= tbay.ib; i++) z = Math.min(z, P[w][i][1]); return z; };
        tbay.zBot = Math.min(edge(tbay.a, "lo"), edge(tbay.b, "lo"), edge(sMid, "lo"));
        const ceil = Math.min(edge(tbay.a, "up"), edge(tbay.b, "up")) - 1;
        tbay.roofZ = Math.min(tbay.zBot + depth, ceil);
        tbay.roof = () => tbay.roofZ;
        tbay.meta.blister = Math.max(0, want - (tbay.roofZ - tbay.zBot));
        L.note("Systems", `${what} servo: pocket at ${fmtN(ua * 100)}–${fmtN(ub * 100)}% chord, ${fmtN(tbay.roofZ - tbay.zBot, 1)} mm deep${tbay.meta.blister > 0.2 ? `, with a ${fmtN(tbay.meta.blister, 1)} mm blister on the cover` : ""}.`);
      }
    }
    /* the tail servo lead runs inside the panel, from the root face into the pocket */
    let twire = null;
    if (tbay && p.wireCh) {
      const sEnd = tbay.a, uE = (tbay.ua + tbay.ub) / 2;
      const Pe = foilPts(at(sEnd), Up, p.minTE);
      let loMax = -Infinity; for (let i = tbay.ia; i <= tbay.ib; i++) loMax = Math.max(loMax, Pe.lo[i][1]);
      const poly = [...Pe.lo.slice(tbay.ia, tbay.ib + 1), [Pe.lo[tbay.ib][0], tbay.roofZ], [Pe.lo[tbay.ia][0], tbay.roofZ]];
      const zE = (loMax + tbay.roofZ) / 2, xE2 = at(sEnd).x + uE * at(sEnd).c;
      const lineW = () => [xE2, zE];                                   // straight, like the spars
      const what2 = name === "fin" ? "fin" : name === "vtail" ? "V-tail panel" : "stabiliser";
      for (let d = p.wireD; d >= 2.9 && !twire; d -= 1) {
        const rw = d / 2 + clr;
        let ok = holeRing(xE2, zE, rw, 24).every(q => inPoly(q[0], q[1], poly));
        for (let s = 0; s <= sEnd && ok; s += 3) {
          const sc = Math.min(s, sEnd - 0.01), q = lineW(sc), a2 = at(sc);
          const Q = foilPts(a2, [0, Math.min(0.92, Math.max(0.03, (q[0] - a2.x) / a2.c))], p.minTE);
          if (Q.up[1][1] - rw - 1 < q[1] || Q.lo[1][1] + rw + 1 > q[1]) ok = false;
          if (rodLine && sc < rodLine.sEnd && Math.abs(rodLine.line(sc)[0] - q[0]) < rodLine.r + rw + 1.5) ok = false;
        }
        if (ok) {
          twire = {id: 8, line: lineW, r: rw, yStart: 0, yEnd: sEnd, wire: true, label: "servo lead", d};
          L.note("Systems", `${what2} servo lead: a ${fmtN(d)} mm channel runs ${fmtN(sEnd)} mm from the root face into the pocket.${d < p.wireD - 0.01 ? ` It was narrowed from ${fmtN(p.wireD)} mm because that is all the panel carries.` : ""}`);
        }
      }
      if (!twire) warns.push(`No room for a wire channel inside the ${what2}, even at 3 mm; bring the servo lead out through the root and tape it inside the fuselage.`);
    }
    const dPin = Math.min(p.pinDepth, 14);
    for (let si = 0; si < pb.length - 1; si++) {
      const s0 = pb[si], s1 = pb[si + 1];
      const bayHere = !!tbay && tbay.a >= s0 - 0.1 && tbay.b <= s1 + 0.1;
      const pinAt = sy => {
        if (!pin || sy <= 0.5 || sy >= len - 1) return [];
        const a2 = at(sy);
        let uCap = Math.min(tcs ? tcs.uH - 0.12 : 0.6, (a2.fA.xt || 0.3) + (rodLine ? 0.18 : 0));
        if (tbay && sy > tbay.a - dPin - 3 && sy < tbay.b + dPin + 3) uCap = Math.min(uCap, tbay.ua - 0.05);
        const u = uCap, P = foilPts(a2, [0, u], p.minTE);
        return P.up[1][1] - P.lo[1][1] >= 2 * pinR + 2 ? [[P.lo[1][0], (P.up[1][1] + P.lo[1][1]) / 2]] : [];
      };
      const pIn = pinAt(s0), pOut = pinAt(s1);
      // the bore runs from the root to wherever the rod still fits, ending as a pocket
      const rodHere = rodLine && s0 < rodLine.sEnd - 1 ? [{id: 9, line: rodLine.line, r: rodLine.r, yStart: 0, yEnd: rodLine.sEnd}] : [];
      const wireHere = twire && twire.yStart < s1 - 0.5 && twire.yEnd > s0 + 0.5 ? [twire] : [];
      const spRod = [...rodHere, ...wireHere];
      const local = buildLiftSeg({s0, s1, step: quick ? 30 : 12, breaks: [], sectionAt: at, U: Up, minTE: p.minTE * 0.8, cs: tcs ? {...tcs, pin: tcs.pinR ? {line: tcs.line, r: tcs.pinR} : null} : null,
        bays: bayHere ? [tbay] : [], spars: spRod, pinsIn: pIn, pinsOut: pOut, pinR, pinDepth: dPin, meta: false});
      let csMesh = null;
      if (tcs && tcs.b > s0 + 1 && tcs.a < s1 - 1) {
        const a = tcs.a >= s0 ? tcs.a + p.hingeGap / 2 : s0 + 0.3, b = tcs.b <= s1 ? tcs.b - p.hingeGap / 2 : s1 - 0.3;
        const hornG = lerp(tcs.a + 5, tcs.b - 5, p.tailHornPos), hornS = hornG > a + 3 && hornG < b - 3 ? hornG : null;
        csMesh = buildCSPart({a, b, step: quick ? 30 : 12, sectionAt: at, U: Up, minTE: p.minTE * 0.8, iH: tcs.iH, line: tcs.line, pinR: tcs.pinR, horn: hornS, hornDepth: p.hornLen * 0.85, hornSide: p.tailHornSide}).mesh;
        if (tcs.pinR) bom.hingePin += (b - a) + 2 * tcs.depth;
      }
      const hw = [];                                                   // servo frame and cover, in panel coordinates
      if (bayHere) {
        const mB = at((tbay.a + tbay.b) / 2), xa = mB.x + tbay.ua * mB.c, xb = mB.x + tbay.ub * mB.c;
        const xm = (xa + xb) / 2, sm = (tbay.a + tbay.b) / 2, sv = tbay.meta.servo;
        const dc = sv.H + 0.4, pad = 10, th = Math.max(2, tbay.roofZ - 0.3 - tbay.zBot);
        const ins = [[xm, tbay.a + pad / 2], [xm, tbay.b - pad / 2]];
        hw.push({nm: "servo_frame", mesh: plate(rect(xa + 0.25, tbay.a + 0.25, xb - 0.25, tbay.b - 0.25),
          [rect(xm - dc / 2, sm - (sv.L + 0.5) / 2, xm + dc / 2, sm + (sv.L + 0.5) / 2), ...ins.map(q => circle(q[0], q[1], insR, 16))], th).transformed(ID3, [0, 0, tbay.zBot]),
          settings: "PETG, 3 perimeters. Glue into the pocket, then press in 2 × M3 heat-set inserts from below."});
        const bl = tbay.meta.blister > 0.2 ? tbay.meta.blister + 0.6 : 0;
        const xE = xb - 0.25, sA = tbay.a + 0.25, sB = tbay.b - 0.25;
        let cover;
        if (bl) {
          /* Thin panel: the servo stands into a blister on the cover. The servo opening runs
             out to the aft edge, so it doubles as the pushrod exit and never crosses a hole. */
          const bx0 = Math.max(xa + 2.2, xm - dc / 2 - 0.6), bs0 = sm - (sv.L + 0.5) / 2 - 0.6, bs1 = sm + (sv.L + 0.5) / 2 + 0.6;
          cover = plate([[xa + 0.25, sA], [xE, sA], [xE, bs0], [bx0, bs0], [bx0, bs1], [xE, bs1], [xE, sB], [xa + 0.25, sB]],
            ins.map(q => circle(q[0], q[1], clearR, 14)), 1.2).transformed(ID3, [0, 0, tbay.zBot - 1.2]);
          const w = 1.4, z0 = tbay.zBot - 1.2, g = 0.3;
          const wx = bx0 - g, ws0 = bs0 - g, ws1 = bs1 + g;              // opening a shade wider than the plate's notch,
          cover.add(plate([[wx - w, ws0 - w], [xE, ws0 - w], [xE, ws0], [wx, ws0], [wx, ws1], [xE, ws1], [xE, ws1 + w], [wx - w, ws1 + w]], [], bl + 0.5)
            .transformed(ID3, [0, 0, z0 - bl]));                         // so this U-shaped wall overlaps the plate instead
                                                                         // of meeting it edge to edge; open aft for the pushrod
          cover.add(plate(roundRect(wx - w + 0.35, ws0 - w + 0.35, xE - 0.35, ws1 + w - 0.35, 1.2), [], 1.8)
            .transformed(ID3, [0, 0, z0 - bl - 1.4]));                   // cap overlaps the wall the same way
        } else {
          cover = plate(rect(xa + 0.25, sA, xE, sB),
            [...ins.map(q => circle(q[0], q[1], clearR, 14)), rect(xb - 7.5, tbay.b - pad - 12, xb - 1.5, tbay.b - pad - 1)], 1.2)
            .transformed(ID3, [0, 0, tbay.zBot - 1.2]);
        }
        hw.push({nm: "servo_cover", mesh: cover, blister: bl,
          settings: `PETG or LW-PLA, 2 perimeters. Screws on with 2 × M3.${bl ? ` The ${fmtN(bl, 1)} mm blister houses the part of the servo the panel cannot swallow; its open aft end passes the pushrod. Print it blister up, no supports.` : " The slot passes the pushrod."}`});
      }
      for (const side of mirrored ? [1, -1] : [1]) {
        const sd = [spanDir[0], side * spanDir[1], spanDir[2]], th = side > 0 ? thick : [thick[0], -thick[1], thick[2]];
        const Rw = placeRows([1, 0, 0], sd, th), tw = [root.x, side * root.y, root.z];
        const Rp = [[1, 0, 0], vcross(sd, [1, 0, 0]), sd];
        const sfx = `${mirrored ? (side > 0 ? "_R" : "_L") : ""}${pb.length > 2 ? "_" + (si + 1) : ""}`;
        const nPins = pIn.length + pOut.length;
        const info = [rodHere.length ? `${rod[0]} mm rod bore` : "", wireHere.length ? `${fmtN(twire.d)} mm wire channel` : "", nPins ? `${nPins} × ${pin[0]} mm pin pockets` : "", bayHere ? "servo pocket" : ""].filter(Boolean).join(", ");
        part(name + sfx, group, local.transformed(Rw, tw), Rp, {seg: si, settings, info});
        if (csMesh) part((opt.csName || "elevator") + sfx, "ctrl", csMesh.transformed(Rw, tw), Rp, {seg: si, settings: "Stand on its end, 2 walls. Hinge pin through the pockets."});
        if (si === 0 && wireHere.length && L.hasFuse) {
          const q0 = twire.line(0.2), pw = [q0[0], 0, q0[1]];
          const wp = [root.x + pw[0], side * root.y + sd[1] * 0 + th[1] * pw[2], root.z + th[2] * pw[2]];
          wirePorts.push({x: wp[0], z: wp[2], y: wp[1], lateral: Math.abs(sd[1]) > 0.5, label: `${name} servo lead`, d: twire.d});
        }
        for (const q of hw) {
          part(`${name}_${q.nm}${sfx}`, "ctrl", q.mesh.transformed(Rw, tw), [[1, 0, 0], sd, vcross([1, 0, 0], sd)], {seg: si, settings: q.settings});
          if (q.nm === "servo_cover") { bom.inserts += 2; bom.m3screws += 2; bom.servos++; }
          if (q.blister) partInfo(`${name}_${q.nm}${sfx}`, `${fmtN(q.blister, 1)} mm blister`);
        }
        if (nPins) bom.pins.push(...Array(nPins).fill(Math.min(p.pinDepth, 14)));
      }
    }
  };
  for (const s of L.surfaces) panelParts(s.st, s.name, "tail", s.mirrored, "Stand on the root face. 1 wall, 0% infill, no supports.",
    {cuttable: true, rod: s.kind !== "fin", cs: true, csName: s.kind === "fin" ? "rudder" : s.kind === "vtail" ? "ruddervator" : "elevator"});
  for (const s of L.tipFins) panelParts(s.st, "tipfin", "tail", true, "Stand on the root face; glue to the wing tip.", {cs: false});
  if (p.vtol === "tailsitter" && !L.tipFins.length) for (const nc of L.nacelles) {
    const h = p.propD * IN / 2 + 25, x0 = nc.x1 - 70;
    const st = [0, 1].map(t => ({x: x0 + t * h * Math.tan(20 * D2R), y: nc.y, z: nc.z - t * h, c: lerp(70, 45, t), fA: L.fTail, fB: L.fTail, s: 0, twist: 0}));
    panelParts(st, "landing_fin", "vtol", true, "Stand on the root face; glue under the nacelle.", {cs: false});
  }

  /* ================= fuselage ================= */
  const openings = [];
  let podInfo = null;
  if (L.hasFuse) {
    const F = L.fuse, t = p.fuseWall;
    const idxRun = (x, ang, w) => {                                     // ring indices of an opening centered at angle
      const ring = F.ring(x, nRing);
      const kc = ((Math.round(ang / (2 * Math.PI) * nRing) % nRing) + nRing) % nRing;
      let m = 0, dist = 0;
      while (m < nRing / 2 - 3) { const a = ring[(kc + m) % nRing], b = ring[(kc + m + 1) % nRing]; dist += Math.hypot(b[0] - a[0], b[1] - a[1]); if (dist > w) break; m++; }
      m = Math.max(1, m);
      return Array.from({length: 2 * m + 1}, (_, i) => (kc - m + i + nRing) % nRing);
    };
    const addOpening = (id, x0, x1, ang, w, kind, optional) => {
      x0 = Math.max(4, x0); x1 = Math.min(F.L - 4, x1);
      if (x1 - x0 < 6) return null;
      const idx = idxRun((x0 + x1) / 2, ang, w);
      const clash = openings.find(o => o.x1 > x0 - 2 && o.x0 < x1 + 2 && o.idx.some(k => idx.some(q => Math.abs(((q - k + nRing + nRing / 2) % nRing) - nRing / 2) <= 2)));
      if (clash) { if (!optional) warns.push(`The ${kind} overlaps the ${clash.kind}; drag it to a clear spot.`); return null; }
      const o = {id, x0, x1, ang, w, kind, idx}; openings.push(o); return o;
    };
    if (p.noseMode === "replaceable" && p.noseStyle === "payload" && p.motorLayout !== "tractor") {
      const xn = Math.min(p.noseSplit, F.L * 0.5);
      addOpening("noseBay", 8, xn - 8, -Math.PI / 2, Math.max(8, p.fuseW * 0.28), "payload nose opening");
    }
    const hatches = [];
    const hatchSpec = (id, label, x0, len, width) => {
      /* the lid reaches 9 mm ahead of its opening for the tongue, and a lid cannot span the
         joint of a removable nose, so the opening is held clear of both */
      const noseJoint = p.noseMode === "replaceable" ? Math.min(p.noseSplit, F.L * 0.5) + 8 : 0;
      const lo = Math.max(14, noseJoint), hi = F.L - 10;
      const x = Math.min(Math.max(x0, lo), Math.max(lo, hi - len));
      if (x > x0 + 0.5) warns.push(`The ${label} would have hung over the ${x0 < 14 ? "nose" : "removable nose joint"}; it has been moved back to ${fmtN(x)} mm from the nose.`);
      const o = addOpening(id, x, Math.min(x + len, hi), Math.PI / 2, width / 2, label);
      if (o) hatches.push(o);
    };
    if (p.hatchBatt) hatchSpec("hatchBatt", "battery hatch", p.hatchBattAuto ? L.xw + p.battX - p.hatchBattLen / 2 : p.hatchBattX, p.hatchBattLen, p.hatchBattW);
    if (p.hatchAv) hatchSpec("hatchAv", "avionics hatch", p.hatchAvX, p.hatchAvLen, p.hatchAvW);
    if (p.deck) {                                                     // never wider or longer than the fuselage carries
      const x0 = Math.max(6, Math.min(L.xw + p.deckX, F.L - 40)), x1 = Math.min(F.L - 6, x0 + p.deckLen);
      let hwMin = Infinity;
      for (let x = x0; x <= x1; x += 4) hwMin = Math.min(hwMin, F.profile(x)[0]);
      const wMax = Math.max(14, 2 * hwMin - 10);
      if (p.deckW > wMax + 0.5) warns.push(`The canopy bay is ${fmtN(p.deckW)} mm wide but the fuselage only carries ${fmtN(wMax)} mm there; it has been narrowed to fit.`);
      hatchSpec("deck", "canopy bay", x0, x1 - x0, Math.min(p.deckW, wMax));
    }
    if (p.pod) {
      const cx = L.xw + p.podX + p.podL * 0.45, o = addOpening("pod", cx - 14, cx + 14, -Math.PI / 2, 10, "pod hatch");
      if (o) podInfo = {cx, o};
    }
    const intakeDepth = p.intakeL * Math.tan(7 * D2R);
    const mirrorAngs = (deg, mirror) => { const a = deg * D2R; return mirror && Math.abs(Math.cos(a)) > 0.2 ? [a, Math.PI - a] : [a]; };
    if (p.intake) for (const ang of mirrorAngs(p.intakeAng, p.intakeMirror)) addOpening("in" + ang.toFixed(2), p.intakeX, p.intakeX + p.intakeL, ang, p.intakeW / 2 + 0.3, "intake");
    if (p.exhaust) {
      const area = p.exhaustArea * p.intakeW * intakeDepth * (p.intakeMirror ? 2 : 1) / (p.exhaustMirror ? 2 : 1);
      const w = Math.min(9, p.fuseW / 5), len = Math.max(12, area / (2 * w));
      for (const ang of mirrorAngs(p.exhaustAng, p.exhaustMirror)) addOpening("ex" + ang.toFixed(2), p.exhaustX, p.exhaustX + len, ang, w, "exhaust");
    }

    /* spar pass-throughs: a tube crossing the fuselage needs a hole in both sides */
    sparPorts.forEach((sp, i) => {
      const xc = Math.max(8, Math.min(sp.x, F.L - 8)), [, hh, zc] = F.profile(xc), rp = sp.d / 2 + 1.2;
      if (Math.abs(sp.z - zc) > hh + 6) return;
      for (const sg of [1, -1]) {
        const ang = Math.atan2((sp.z - zc) / Math.max(1, hh) * 0.5, sg);
        if (!addOpening(`spar${i}_${sg}`, xc - rp, xc + rp, ang, rp, `${sp.label} pass-through`, true))
          warns.push(`The ${sp.label} crosses the fuselage where another opening already is, so its hole was left out. Move the spar or that opening, or cut the hole by hand.`);
      }
    });

    /* wire pass-throughs: a slot in the shell where a channel meets a root face */
    if (p.wireCh) wirePorts.forEach((wp, i) => {
      const xc = Math.max(10, Math.min(wp.x, F.L - 10)), [hw, hh, zc] = F.profile(xc), rp = (wp.d || p.wireD) / 2 + 1.6;
      if (Math.abs(wp.z - zc) > hh + 8) return;                         // that root face is nowhere near the shell
      const sides = wp.lateral ? (wp.y === undefined ? [1, -1] : [Math.sign(wp.y) || 1]) : [0];
      for (const sg of sides) {
        const ang = wp.lateral ? Math.atan2((wp.z - zc) / Math.max(1, hh) * 0.5, sg) : Math.PI / 2;
        const o = addOpening(`wire${i}_${sg}`, xc - rp, xc + rp, ang, rp, `${wp.label} pass-through`, true);
        if (!o) L.note("Systems", `The ${wp.label} port at ${fmtN(xc)} mm from the nose runs into another opening; bring that lead through the neighbouring opening instead.`);
      }
    });

    const sleeve = xc => {
      const [hw, hh, zc] = F.profile(xc), m = new Mesh();
      const mk = (x, dOut, dIn) => ({x, outer: F.ring(xc, nRing, -t + dOut), inner: F.ring(xc, nRing, -t + dIn), c: [0, zc]});
      m.add(loftTube([mk(xc - 10, 0.35, -1.2), mk(xc, 0.35, -1.2)]));
      m.add(loftTube([mk(xc - 3, -0.2, -1.1), mk(xc + 12, -0.2, -1.1)]));
      return m;
    };
    const endCap = (x, back) => { return plate(F.ring(x, nRing, -0.2), [], 1.4).transformed([[0, 0, 1], [1, 0, 0], [0, 1, 0]], [back ? x - 1.4 : x, 0, 0]); };
    const replaceable = p.noseMode === "replaceable";
    const xStart = replaceable ? Math.min(p.noseSplit, F.L * 0.5) : 0;
    const fb = manual ? [xStart, ...parseCuts(p.fuseCuts).filter(v => v > xStart + 20 && v < F.L - 20), F.L] : cutBounds(F.L - xStart, zUse, "", false).map(v => v + xStart);
    const nF = fb.length - 1, standX = [[0, 1, 0], [0, 0, 1], [1, 0, 0]];
    const tractorBosses = p.motorLayout === "tractor" && !replaceable;
    for (let si = 0; si < nF; si++) {
      const x0 = fb[si], x1 = fb[si + 1], mesh = buildFuseSeg(F, x0, x1, t, openings, fuseStep, nRing);
      if (si < nF - 1 && p.fuseSleeves) mesh.add(sleeve(x1));
      if (si === nF - 1) mesh.add(endCap(x1, true));
      if (si === 0 && !replaceable && p.motorLayout !== "tractor") mesh.add(endCap(0, false));
      const segOps = openings.filter(o => o.x1 > x0 && o.x0 < x1);
      part(`${p.fuseType === "pod" ? "pod" : "fuselage"}${nF > 1 ? "_" + (si + 1) : ""}`, "fuse", mesh, standX, {seg: si, info: segOps.map(o => o.kind).join(", "),
        settings: `Stand on the front face. ${fmtN(t, 1)} mm shell: 2–3 perimeters, 0% infill, supports only under hatch openings if your slicer needs them.`});
    }
    /* hatch bosses: glued into the fuselage (separate so the shell prints cleanly) */
    const bossPart = (name, list, settings) => { const m = new Mesh(); list.forEach(b => m.add(b)); part(name, "mount", m, flatUp, {settings}); };
    if (podInfo) {
      const {cx, o} = podInfo;
      let zBot = Infinity; for (let x = o.x0; x <= o.x1; x += 4) { const [hw, hh, zc] = F.profile(x); zBot = Math.min(zBot, zc - hh); }
      const zPlate = zBot - 0.3, yb = o.w - 2.4, bx = [o.x0 + 5, o.x1 - 5], bosses = [];
      for (const x of bx) for (const s of [1, -1]) bosses.push(boss(x, s * yb, zPlate + 0.1, zPlate + p.insertDepth + 3, bossR, insR));
      bossPart("pod_insert_bosses", bosses, "PETG, 100% infill. Glue above the belly hatch; press in 4 × M3 inserts.");
      const R = p.podD / 2, x0 = L.xw + p.podX, zc = zPlate - 3 - R, st = [];
      for (let j = 0; j <= (quick ? 8 : 14); j++) {
        const u = j / (quick ? 8 : 14), x = x0 + p.podL * u, r = R * (u < 0.25 ? 0.72 + 0.28 * smooth(u / 0.25) : u > 0.65 ? 1 - 0.6 * smooth((u - 0.65) / 0.35) : 1);
        st.push({x, outer: circle(0, zc, r, 28), inner: circle(0, zc, Math.max(1, r - 1.4), 28), c: [0, zc]});
      }
      const m = loftTube(st);
      m.add(plate(roundRect(o.x0 - 2, -o.w - 6, o.x1 + 2, o.w + 6, 4), bx.flatMap(x => [1, -1].map(s => circle(x, s * yb, clearR, 14))), 3).transformed(ID3, [0, 0, zPlate - 3]));
      m.add(plate(rect(cx - 14, -3, cx + 14, 3), [], zPlate - 3 - zc).transformed(ID3, [0, 0, zc]));
      m.add(plate(circle(0, zc, R * 0.4 - 0.2, 28), [], 1.4).transformed([[0, 0, 1], [1, 0, 0], [0, 1, 0]], [x0 + p.podL - 1.4, 0, 0]));
      part("underslung_pod", "mount", m, [[0, -1, 0], [0, 0, 1], [-1, 0, 0]], {settings: "Stand on the open front, 2–3 perimeters. Swappable: 4 × M3 into the belly bosses."});
      bom.inserts += 4; bom.m3screws += 4;
    }
    /* NACA duct inserts */
    for (const o of openings.filter(q => q.kind === "intake")) {
      const xm = o.x0, kc = o.idx[(o.idx.length - 1) / 2];
      const P0 = F.ring(xm, nRing)[kc], zcIn = F.profile(xm)[2];
      const en = vnorm([0, P0[0], P0[1] - zcIn]), ex = [1, 0, 0], el = vcross(en, ex);
      const surfOff = x => { const q = F.ring(x, nRing)[kc]; return (q[0] - P0[0]) * en[1] + (q[1] - P0[1]) * en[2]; };
      const Ld = o.x1 - o.x0, Wd = p.intakeW / 2, nS = quick ? 6 : 14, ys = [], wt = 1.2;
      for (let i = 0; i <= nS; i++) ys.push(Ld * i / nS);
      const halfW = s => Wd * (0.22 + 0.78 * Math.pow(smooth(s / Ld), 0.75));
      const ring = j => {
        const s = ys[j], w = halfW(s), d = Math.max(1, s * Math.tan(7 * D2R)), top = surfOff(o.x0 + s) - t;
        return [[-w - wt, top], [-w - wt, top - d - wt], [w + wt, top - d - wt], [w + wt, top], [w, top], [w, top - d], [-w, top - d], [-w, top]];
      };
      const fixed = j => { const r = ring(j); return signedArea2(r) > 0 ? r : r.slice().reverse(); };
      const duct = loftZoned(ys, [{j0: 0, j1: nS, outers: [fixed], holes: []}], [], [], false);
      const outline = []; for (let i = 0; i <= 10; i++) { const s = Ld * i / 10; outline.push([halfW(s) + 0.3, s]); }
      for (let i = 10; i >= 0; i--) { const s = Ld * i / 10; outline.push([-halfW(s) - 0.3, s]); }
      duct.add(plate(roundRect(-Wd - 7, -6, Wd + 7, Ld + 3, 3), [outline.slice().reverse()], 1.5).transformed([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, surfOff(o.x0) - t - 1.5]));
      const world = duct.transformed(placeRows(el, ex, en), [o.x0, P0[0], P0[1]]);
      part(`naca_intake${openings.filter(q => q.kind === "intake").indexOf(o) ? "_2" : ""}`, "cool", world, [ex, vscale(el, -1), vscale(en, -1)],
        {settings: "Print with the flange on the bed, 2 perimeters. Glue inside the intake opening; the 7° ramp faces forward."});
    }
    /* battery tray */
    if (p.battTray) {
      const bd = batteryDims(p), xb = L.xw + p.battX, x0 = xb - bd.L / 2 - 8, x1 = xb + bd.L / 2 + 8, halfW = bd.W / 2 + 4;
      const floorZ = (x, y) => F.zAt(x, y, -t, true);
      const ry = halfW - 5;
      let zT = -Infinity; for (let x = x0; x <= x1; x += 5) zT = Math.max(zT, floorZ(x, ry) + 3);
      const slots = [];
      for (const xs of [xb - bd.L / 4, xb + bd.L / 4]) for (const s of [1, -1]) slots.push(roundRect(xs - p.strapW / 2 - 0.5, s > 0 ? bd.W / 2 + 0.8 : -bd.W / 2 - 3.3, xs + p.strapW / 2 + 0.5, s > 0 ? bd.W / 2 + 3.3 : -bd.W / 2 - 0.8, 1));   // rounded: collinear hole edges break the triangulator
      const tray = plate(roundRect(x0, -halfW, x1, halfW, 4), slots, 2.5).transformed(ID3, [0, 0, zT]);
      for (const s of [1, -1]) {
        const prof = []; for (let x = x0 + 4; x <= x1 - 4 + 1e-6; x += (x1 - x0 - 8) / 8) prof.push([x, floorZ(x, ry) - 0.6]);
        const poly = [...prof, [x1 - 4, zT + 0.5], [x0 + 4, zT + 0.5]];
        tray.add(plate(poly, [], 2).transformed([[1, 0, 0], [0, 0, 1], [0, 1, 0]], [0, s * ry - 1, 0]));
      }
      const fits = bd.W + 2 <= 2 * (F.profile(xb)[0] - t) && bd.H + 3 <= (F.profile(xb)[2] + F.profile(xb)[1] - t) - (zT + 2.5);
      if (!fits) warns.push(`The ${fmtN(bd.L)} × ${fmtN(bd.W)} × ${fmtN(bd.H)} mm battery does not fit the fuselage at its balance position.`);
      part("battery_tray", "cool", tray, flatDown, {info: `${p.strapW} mm strap slots`, settings: "PETG, 3 perimeters. Glue the ribs to the fuselage floor; loop 2 straps through the slots."});
      bom.straps += 2;
    }
    /* canopy fairing (Titan Falcon style) on top of the lid bands */
    const surfTop = (x, y) => F.zAt(x, y, 0, false);
    function addCanopy(lid, o, loftX) {
      const tf = 1.2, wf = o.w - 2.5, xa = o.x0 + 1, xb = o.x1 - 1, cam = +p.camSize, style = p.canopyStyle;
      const H = style === "camera" ? Math.max(p.canopyH, cam + 10) : p.canopyH, hMin = tf + 1.6, E = 2.4, mA = 18;
      const shape = u => style === "camera"
        ? (u < 0.12 ? 0.8 + 0.2 * smooth(u / 0.12) : u < 0.45 ? 1 : Math.pow(1 - smooth((u - 0.45) / 0.55), 0.8))
        : (u < 0.35 ? Math.sqrt(Math.max(0, 1 - (1 - u / 0.35) ** 2)) : Math.pow(1 - smooth((u - 0.35) / 0.65), 0.8));
      const hAt = x => Math.max(hMin, H * shape((x - xa) / (xb - xa)));
      const dome = (x, y, w, h) => surfTop(x, y) - 0.4 + h * Math.pow(Math.max(0, 1 - Math.pow(Math.min(1, Math.abs(y) / w), E)), 1 / E);
      const inner = x => { const h = hAt(x) - tf, wi = wf - tf, pts = []; for (let i = mA; i >= 0; i--) { const y = -wi + 2 * wi * i / mA; pts.push([y, dome(x, y, wi, h)]); } return pts; };
      const arch = x => {
        const h = hAt(x), out = [];
        for (let i = 0; i <= mA; i++) { const y = -wf + 2 * wf * i / mA; out.push([y, dome(x, y, wf, h)]); }
        const poly = [...out, ...inner(x)];
        return signedArea2(poly) > 0 ? poly : poly.slice().reverse();
      };
      lid.add(loftX(xa, xb, arch, Math.max(6, Math.ceil((xb - xa) / (quick ? 20 : 6)))));
      const endPlate = (x, dir) => {                                   // overlaps the shell wall, never shares its edges
        const poly = inner(x - dir * 0.4), ccw = signedArea2(poly) > 0 ? poly : poly.slice().reverse();
        lid.add(plate(offsetRing(ccw, 0.35), [], 1.2).transformed([[0, 0, 1], [1, 0, 0], [0, 1, 0]], [dir > 0 ? x - 1.6 : x + 0.4, 0, 0]));
      };
      endPlate(xb, 1);
      if (style !== "camera") endPlate(xa, -1);
      if (style === "camera") {
        const x0 = xa + 2, x1 = Math.min(xb - 20, x0 + cam * 1.15), zb = surfTop(x0, 0) - 0.4;
        lid.add(plate(rect(x0, -(wf - 0.6), x1, wf - 0.6), [], 2).transformed(ID3, [0, 0, zb - 2]));
        for (const s of [1, -1]) {
          const top = Math.min(dome(x0 + cam * 0.6, s * (cam / 2 + 1.4), wf - tf, hAt(x0 + cam * 0.6) - tf) + 0.8, zb + cam + 6) - zb;
          lid.add(plate(rect(x0, -2, x1, top), [circle(x0 + cam * 0.55, cam / 2 + 1, 1.1, 14)], 2).transformed([[1, 0, 0], [0, 0, 1], [0, 1, 0]], [0, s * (cam / 2 + 0.4) + (s > 0 ? 0 : -2), zb]));
        }
      }
      if (style === "gps") {
        const xc = xa + (xb - xa) * 0.5, zt = dome(xc, 0, wf, hAt(xc)) - 1;
        lid.add(plate(roundRect(xc - 15, -15, xc + 15, 15, 3), [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) => circle(xc + a * 10, b * 10, 1.1, 12)), 2.5).transformed(ID3, [0, 0, zt]));
      }
    }
    /* FC shelf (Flightory Moose style): glued across the bay below the rim */
    function addFcShelf(o) {
      const x0 = o.x0 + 4, x1 = o.x1 - 18;
      if (x1 - x0 < 25) return;
      let zRim = Infinity; for (let x = x0; x <= x1; x += 4) zRim = Math.min(zRim, surfTop(x, 0));
      const zs = zRim - p.fcShelfDepth;
      let half = Infinity;
      for (let x = x0; x <= x1; x += 4) half = Math.min(half, F.halfAt(x, zs + 2, -t) - 0.5);
      const pat = +p.deckPattern / 2, cx = (x0 + x1) / 2;
      if (half < pat + 4) { warns.push("The FC shelf is too narrow for the stack pattern at that depth; raise the shelf or widen the fuselage."); return; }
      const holes = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) => circle(cx + a * pat, b * pat, 1.65, 12));
      for (const xs of [x0 + 6, x1 - 6]) if (Math.abs(xs - cx) > pat + 6) for (const s of [1, -1]) holes.push(roundRect(xs - 1.5, s * (half - 7) - 3, xs + 1.5, s * (half - 7) + 3, 1.2));
      part("fc_shelf", "mount", plate(roundRect(x0, -half, x1, half, 3), holes, 2).transformed(ID3, [0, 0, zs]), flatUp,
        {info: `${p.deckPattern} mm stack`, settings: "PETG, 3 perimeters, 30% infill. Glue across the bay; the slots take zip ties for ESC or receiver."});
    }
    /* hatch lids: the removed shell sector, a front tongue under the rim and a rear latch rail */
    for (const o of hatches) {
      const n0 = o.idx[0] - 1, n1 = o.idx[o.idx.length - 1] + 1;
      const ringAt = (x, k, off) => F.pt(x, 2 * Math.PI * k / nRing, off);
      const sector = (ka, kb, offOut, offIn, m) => x => {
        const out = [], inn = [];
        for (let i = 0; i <= m; i++) { const k = lerp(ka, kb, i / m); out.push(ringAt(x, k, offOut)); inn.push(ringAt(x, k, offIn)); }
        const poly = [...out, ...inn.reverse()];
        return signedArea2(poly) > 0 ? poly : poly.slice().reverse();
      };
      const [hwm] = F.profile((o.x0 + o.x1) / 2), dk = 0.45 / (2 * Math.PI * hwm / nRing);     // 0.45 mm edge clearance in ring steps
      const ka = n0 + dk, kb = n1 - dk, m = Math.max(6, (n1 - n0) * 3);
      const loftX = (x0, x1, fn, nst) => { const ys = Array.from({length: nst + 1}, (_, i) => x0 + (x1 - x0) * i / nst); return loftZoned(ys, [{j0: 0, j1: nst, outers: [j => fn(ys[j])], holes: []}], [], [], false).transformed([[0, 1, 0], [1, 0, 0], [0, 0, 1]]); };
      const nLid = Math.max(2, Math.ceil((o.x1 - o.x0) / fuseStep)), canopy = o.id === "deck";
      const mmPerK = 2 * Math.PI * hwm / nRing, bandK = 6.5 / mmPerK;
      const lid = canopy
        ? loftX(o.x0 + 0.45, o.x1 - 0.45, sector(ka, ka + bandK, 0, -t, 4), nLid)
            .add(loftX(o.x0 + 0.45, o.x1 - 0.45, sector(kb - bandK, kb, 0, -t, 4), nLid))
            .add(loftX(o.x0 + 0.45, o.x0 + 10, sector(ka + bandK * 0.5, kb - bandK * 0.5, 0, -t, m), 2))
            .add(loftX(o.x1 - 18, o.x1 - 0.45, sector(ka + bandK * 0.5, kb - bandK * 0.5, 0, -t, m), 3))
        : loftX(o.x0 + 0.45, o.x1 - 0.45, sector(ka, kb, 0, -t, m), nLid);
      const kSpan = kb - ka;
      if (canopy) addCanopy(lid, o, loftX);
      lid.add(loftX(o.x0 - 9, o.x0 + 0.45, sector(ka + kSpan * 0.2, kb - kSpan * 0.2, -t - 0.3, -t - 1.6, m), 3));        // tongue under the rim
      lid.add(loftX(o.x0 - 1, o.x0 + 7, sector(ka + kSpan * 0.2, kb - kSpan * 0.2, -t + 0.6, -t - 1.6, m), 3));          // tongue root, fused to the lid
      // rear latch: tab on the lid, rail glued in the fuselage
      const xr0 = o.x1 - 14, xr1 = o.x1 - 2, xrm = (xr0 + xr1) / 2;
      const zInner = y => F.zAt(xrm, y, -t, false);
      const yl = o.w - 1.5, magnet = p.hatchLatch === "magnets";
      const holeR = magnet ? p.magnetD / 2 : clearR, railHoleR = magnet ? p.magnetD / 2 : insR, railTh = magnet ? 3.4 : p.insertDepth + 1;
      const zTab = Math.min(zInner(yl), zInner(0)) - 3.2;
      // keep both latch holes inside the (possibly narrow) rail and tab; one center hole on slim pods
      const railTop0 = zTab - 0.25, ySpan0 = F.halfAt(xrm, railTop0, -t) + 0.8;
      const yh = Math.min(yl - 5, ySpan0 - Math.max(holeR, railHoleR) - 1.8, yl - holeR - 1.8);
      const holesXY = yh > Math.max(holeR, railHoleR) + 1.2 ? [[xr0 + 6, yh], [xr0 + 6, -yh]] : [[xr0 + 6, 0]];
      lid.add(plate(roundRect(xr0, -yl, xr1, yl, 2), holesXY.map(([x, y]) => circle(x, y, holeR, 18)), zInner(yl) + t * 0.5 - zTab).transformed(ID3, [0, 0, zTab]));
      const railTop = railTop0, ySpan = ySpan0;
      const rail = plate(roundRect(xr0, -ySpan, xr1, ySpan, 2), holesXY.map(([x, y]) => circle(x, y, railHoleR, 18)), railTh).transformed(ID3, [0, 0, railTop - railTh]);
      const lidName = {hatchBatt: "battery_hatch", hatchAv: "avionics_hatch", deck: "fpv_canopy"}[o.id];
      part(lidName, canopy ? "mount" : "fuse", lid, canopy ? flatUp : standX, {info: (canopy ? {blank: "blank fairing", camera: "camera cradle", gps: "GPS pad"}[p.canopyStyle] + ", " : "") + (magnet ? "2 × 6×3 mm magnets" : "2 × M3 screws"),
        settings: canopy ? "Print upright on the lid bands, 2 perimeters, supports only under the fairing roof if your slicer asks. Hook the tongue under the front rim, press down at the rear." : "Stand on the front edge, same shell settings as the fuselage. Hook the tongue under the front rim, then press down at the rear."});
      if (canopy && p.fcShelf) addFcShelf(o);
      part(lidName + "_rail", "fuse", rail, flatUp, {settings: magnet ? "PETG. Glue across the fuselage under the rear of the opening; glue magnets in both rail and hatch (check polarity)." : "PETG, 100% infill. Glue under the rear of the opening; press in 2 × M3 inserts."});
      if (magnet) bom.magnets = (bom.magnets || 0) + 4; else { bom.inserts += 2; bom.m3screws += 2; }
    }

    /* nose, camera cradle, firewall with bosses */
    if (replaceable) {
      const cam = +p.camSize, xs = xStart, nose = buildFuseSeg(F, 0, xs, t, openings, fuseStep, nRing);
      const [hw0, hh0, zc0] = F.profile(xs);
      const mk = (x, dOut, dIn) => ({x, outer: F.ring(xs, nRing, -t + dOut), inner: F.ring(xs, nRing, -t + dIn), c: [0, zc0]});
      if (p.noseAttach === "spigot") {
        nose.add(loftTube([mk(xs - 10, 0.35, -1.3), mk(xs, 0.35, -1.3)]));
        nose.add(loftTube([mk(xs - 3, -0.25, -1.3), mk(xs + 12, -0.25, -1.3)]));
      } else {
        const ringHoles = r => [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) => { const q = F.pt(xs, Math.atan2(b, a), -t - 3.6); return circle(q[0], q[1], r, 16); });
        const outerR = off => F.ring(xs, nRing, -t + off), innerR = F.ring(xs, nRing, -t - 7.2).reverse();
        const yz = [[0, 0, 1], [1, 0, 0], [0, 1, 0]];
        nose.add(plate(outerR(0.4), [innerR, ...ringHoles(clearR)], 3).transformed(yz, [xs - 3, 0, 0]));
        const ringM = plate(outerR(-0.1), [innerR, ...ringHoles(insR)], p.insertDepth).transformed(yz, [xs + 0.3, 0, 0]);
        part("nose_insert_ring", "fuse", ringM, [[0, 1, 0], [0, 0, 1], [1, 0, 0]], {settings: "PETG, 100% infill. Glue inside the front of the fuselage; press in 4 × M3 inserts facing forward."});
        bom.inserts += 4; bom.m3screws += 4;
      }
      const style = p.motorLayout === "tractor" ? "blank" : p.noseStyle;
      if (style === "camera") {                                        // open front with an M2 pivot cradle
        const xc0 = 3, xc1 = Math.min(xs - 4, 3 + cam * 1.25), [hwc, , zcc] = F.profile((xc0 + xc1) / 2);
        const floorZ = zcc - cam * 0.55 - 2, wIn = hwc - t + 0.4;
        nose.add(plate(rect(xc0, -wIn, xc1, wIn), [], 2).transformed(ID3, [0, 0, floorZ]));
        for (const s of [1, -1]) nose.add(plate(rect(xc0, 0, xc1, cam * 1.05 + 2), [circle(xc0 + cam * 0.55, zcc - floorZ, 1.1, 14)], 2).transformed([[1, 0, 0], [0, 0, 1], [0, 1, 0]], [0, s * (cam / 2 + 0.4) + (s > 0 ? 0 : -2), floorZ]));
      } else if (style === "payload") {                                // belly opening with a screwed shelf above it
        const [hwp, hhp, zcp] = F.profile(xs * 0.55), wIn = hwp - t - 1;
        const shelfZ = zcp - hhp * 0.25;
        const ins = [[xs * 0.3, wIn * 0.55], [xs * 0.3, -wIn * 0.55], [xs * 0.72, wIn * 0.55], [xs * 0.72, -wIn * 0.55]];
        nose.add(plate(rect(6, -wIn, xs - 6, wIn), ins.map(q => circle(q[0], q[1], insR, 16)), 3).transformed(ID3, [0, 0, shelfZ]));
        bom.inserts += 4; bom.m3screws += 4;
      } else {                                                         // blank: closed front, with a pad to glue gear to
        nose.add(plate(F.ring(1.6, nRing, -0.3), [], 1.6).transformed([[0, 0, 1], [1, 0, 0], [0, 1, 0]], [0, 0, 0]));
        const [, hhb, zcb] = F.profile(xs * 0.5);
        nose.add(plate(rect(8, -14, xs - 8, 14), [], 2).transformed(ID3, [0, 0, zcb - hhb * 0.35]));
      }
      const noseInfo = {camera: `${cam} mm camera cradle`, payload: "belly payload opening + M3 shelf", blank: "closed nose"}[style];
      part("fpv_nose", "fuse", nose, [[0, -1, 0], [0, 0, 1], [-1, 0, 0]], {info: noseInfo,
        settings: `Swappable nose module (${noseInfo}). Stand on the front face, PETG/ASA or LW-PLA with 3 perimeters. ${p.noseAttach === "spigot" ? "The spigot slides into the fuselage." : "4 × M3 into the glued insert ring."} Print one nose per payload and change it at the field.`});
    }
    for (const mo of L.motors) {
      if (mo.mount === "firewall" && mo.dir[0] < 0) {
        const [hw, hh, zc] = F.profile(0), bpts = [];
        for (const [cy, cz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const q = F.pt(0, Math.atan2(cz, cy), -t);
          bpts.push([q[0] * 0.72, zc + (q[1] - zc) * 0.72]);
        }
        const inner = mountHoles(p.mountPattern, L.main).span / 2 + clearR + 1;
        const usable = bpts.filter(([y, z]) => Math.hypot(y, z - zc) > inner);
        const side = Math.max(Math.min(hw, hh) * 1.8, ...usable.map(([y, z]) => 2 * Math.max(Math.abs(y), Math.abs(z - zc)) + 10));
        const fw = mountPlate(p.mountPattern, L.main, side, 4, usable.map(([y, z]) => circle(y, z - zc, clearR, 14)));
        part("motor_firewall", "mount", fw.transformed([[0, 0, 1], [1, 0, 0], [0, 1, 0]], [-4, 0, zc]), standX, {settings: PETG_NOTE + " Screws to the nose bosses with 4 × M3."});
        if (tractorBosses) {
          const bm = new Mesh();
          for (const [y, z] of bpts) bm.add(loftTube([0.5, 10].map(x => ({x, outer: circle(y, z, bossR, 18), inner: circle(y, z, insR, 18), c: [y, z]}))));
          part("firewall_insert_bosses", "mount", bm, standX, {settings: "PETG, 100% infill. Glue inside the nose ring; press in 4 × M3 inserts."});
          bom.inserts += 4;
        }
        bom.m3screws += 4;
      }
      if (mo.mount === "pylon") {
        const zb = mo.pylonBase - 6, zt = mo.pos[2], xm = mo.pos[0] - 6, can = L.main.can;
        const web = plate([[xm - 70, zb], [xm, zb], [xm, zt + can * 0.45], [xm - 26, zt + can * 0.45]], [], 5).transformed([[1, 0, 0], [0, 0, 1], [0, 1, 0]], [0, -2.5, 0]);
        const fw = mountPlate(p.mountPattern, L.main, 0).transformed([[0, 0, 1], [1, 0, 0], [0, 1, 0]], [xm, 0, zt]);
        part("pusher_pylon", "mount", new Mesh().add(web).add(fw), [[1, 0, 0], [0, 0, -1], [0, 1, 0]], {settings: PETG_NOTE + " Print on its side."});
      }
      if (mo.mount === "firewall" && mo.dir[0] > 0) {
        const x = mo.pos[0] - 26;
        part("motor_mount_rear", "mount", mountPlate(p.mountPattern, L.main, 0).transformed([[0, 0, 1], [1, 0, 0], [0, 1, 0]], [x, 0, mo.pos[2]]), standX, {settings: PETG_NOTE});
      }
    }
  } else {
    for (const mo of L.motors) if (mo.mount === "firewall") {
      const x = mo.pos[0] - 26 * mo.dir[0];
      part("motor_mount", "mount", mountPlate(p.mountPattern, L.main, 0).transformed([[0, 0, 1], [1, 0, 0], [0, 1, 0]], [x, 0, mo.pos[2]]), [[0, 1, 0], [0, 0, 1], [1, 0, 0]], {settings: PETG_NOTE});
    }
    if (p.deck) {
      const w0 = W.wingAt(0), x0 = L.xw + p.deckX, x1 = x0 + p.deckLen, z = w0.z + Math.max(...w0.fA.yu) * w0.c + 0.5;
      part("fpv_deck", "mount", plate(roundRect(x0, -p.deckW / 2, x1, p.deckW / 2, 5), [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) => circle((x0 + x1) / 2 + a * p.deckPattern / 2, b * p.deckPattern / 2, 1.65, 12)), 2.5).transformed(ID3, [0, 0, z]), flatUp, {settings: "PETG. Glue to the wing center section."});
    }
  }

  /* ================= nacelles ================= */
  for (const nc of L.nacelles) {
    const len = nc.x1 - nc.x0, st = [];
    for (let j = 0; j <= 8; j++) {
      const u = j / 8, x = nc.x0 + len * u, r = nc.r * (nc.push ? (u < 0.3 ? 0.55 + 0.45 * smooth(u / 0.3) : 1) : (u > 0.6 ? 1 - 0.45 * smooth((u - 0.6) / 0.4) : 1));
      st.push({x, outer: circle(0, nc.z, r, 20), inner: circle(0, nc.z, Math.max(1, r - 1.2), 20), c: [0, nc.z]});
    }
    for (const side of [1, -1]) {
      const m = loftTube(st).transformed(ID3, [0, side * nc.y, 0]);
      const xf = nc.push ? nc.x1 : nc.x0;
      m.add(mountPlate(p.mountPattern, L.main, 0).transformed([[0, 0, 1], [1, 0, 0], [0, 1, 0]], [nc.push ? xf - 4 : xf, side * nc.y, nc.z]));
      if (p.vtol === "tilttri" || p.vtol === "vector") for (const s2 of [1, -1]) m.add(plate(roundRect(0, -8, 30, 8, 3), [circle(22, 0, 1.6, 12)], 3).transformed([[1, 0, 0], [0, 0, 1], [0, 1, 0]], [xf + (nc.push ? -30 : 0), side * nc.y + s2 * (nc.r + 1.5) - 1.5, nc.z]));
      part(`nacelle_${side > 0 ? "R" : "L"}`, "mount", m, nc.push ? [[0, -1, 0], [0, 0, 1], [-1, 0, 0]] : [[0, 1, 0], [0, 0, 1], [1, 0, 0]], {settings: "Stand on the motor face. PETG/ASA, 3 perimeters, 25% infill."});
    }
  }

  /* ================= tail booms ================= */
  const saddle = (x, y, zc, d, zTop, name, group) => {
    const w = d + 10, h = Math.max(d / 2 + 5, zTop - zc + 3);
    const m = plate([[-w / 2, -(d / 2 + 5)], [w / 2, -(d / 2 + 5)], [w / 2, h], [-w / 2, h]], [circle(0, 0, d / 2 + 0.15, 28)], 12).transformed([[0, 0, 1], [1, 0, 0], [0, 1, 0]], [x - 6, y, zc]);
    part(name, group, m, [[0, 1, 0], [0, 0, 1], [1, 0, 0]], {settings: PETG_NOTE});
  };
  for (const b of L.booms.filter(q => q.role === "tail")) for (const side of b.mirrored ? [1, -1] : [1]) {
    const y = side * b.a[1], d = b.tube[0];
    if (b.mirrored) { const w = W.wingAt(Math.abs(y)); saddle(w.x + 0.3 * w.c, y, b.a[2], d, w.z, `tailboom_saddle_${side > 0 ? "R" : "L"}`, "mount"); }
    else { saddle(b.a[0] + 8, 0, b.a[2], d, b.a[2] + d, "tailboom_clamp_pod", "mount"); saddle(b.b[0] - 30, 0, b.b[2], d, b.b[2] + d / 2 + 6, "tailboom_clamp_tail", "mount"); }
  }
  for (const mo of L.vtol.lift) if (L.vtol.type === "tilttri") {
    const base = L.hasFuse && L.fuse.L > mo.pos[0] ? L.fuse.profile(mo.pos[0])[2] + L.fuse.profile(mo.pos[0])[1] - 6 : L.zWing;
    const mesh = new Mesh().add(mountPlate(p.mountPattern, L.main, 0).transformed(ID3, [mo.pos[0], 0, mo.pos[2] - 26]));
    mesh.add(plate(rect(-10, -3, 10, 3), [], Math.max(4, mo.pos[2] - 26 - base)).transformed(ID3, [mo.pos[0], 0, base]));
    part("rear_lift_mount", "vtol", mesh, flatUp, {settings: PETG_NOTE});
  }

  /* ================= gluing jigs ================= */
  if (p.jigs && !quick) {
    const stations = [...new Set([Math.max(8, W.blendEnd + 6), ...bounds.slice(1, -1).map(v => v - 12), half - 12])].filter(v => v > W.blendEnd && v < half);   // jigs sit outboard of any root blend
    let zBase = Infinity;
    for (let y = 0; y <= half; y += half / 20) { const w = W.wingAt(y), P = foilPts(w, U, p.minTE); zBase = Math.min(zBase, W.dihZ(y) + Math.min(...P.lo.map(q => q[1]))); }
    zBase -= 18;
    for (const y of stations) {
      const w = W.wingAt(y), P = foilPts(w, U, p.minTE), zOff = W.dihZ(y);
      const ring = [...P.lo, ...P.up.slice(1).reverse()].map(([x, z]) => [x, z + zOff]);
      const hole = offsetRing(signedArea2(ring) > 0 ? ring : ring.slice().reverse(), 0.35);
      const xs = hole.map(q => q[0]), zs = hole.map(q => q[1]);
      const outline = roundRect(Math.min(...xs) - 9, zBase, Math.max(...xs) + 9, Math.max(...zs) + 10, 3);
      const jig = plate(outline, [hole], 6).transformed([[1, 0, 0], [0, 0, 1], [0, 1, 0]], [0, y - 3, 0]);
      part(`jig_wing_${fmtN(y)}mm`, "jig", jig, [[1, 0, 0], [0, 0, -1], [0, 1, 0]], {settings: "Print 2 (one per side), PLA, 2 perimeters. Stand all jigs on a flat board: the common base sets incidence, washout and dihedral."});
    }
  }

  /* ================= parts you uploaded ================= */
  if (typeof userPartList === "function") for (const cp of userPartList(p)) {
    const t = userTris(cp);
    if (!t || t.length < 9) continue;
    const m = new Mesh();
    for (let i = 0; i < t.length; i += 9) m.tri([t[i], t[i + 1], t[i + 2]], [t[i + 3], t[i + 4], t[i + 5]], [t[i + 6], t[i + 7], t[i + 8]]);
    const safe = String(cp.name || "part").replace(/[^\w.-]+/g, "_").slice(0, 40) || "part";
    const note = "Your own model, exported exactly as uploaded (scaled and placed). Orientation on the bed is yours to set in the slicer.";
    part(safe + (cp.mirror ? "_R" : ""), "custom", m, ID3, {info: "uploaded", settings: note});
    if (cp.mirror) part(safe + "_L", "custom", m.mapped((x, y, z) => [x, -y, z], true), ID3, {info: "uploaded, mirrored", settings: note});
  }

  /* ================= finalize: world + print triangles ================= */
  for (const pt of parts) {
    pt.tris = new Float32Array(pt.mesh.t);
    pt.meta = pt.mesh.meta ? new Float32Array(pt.mesh.meta) : null;
    const pm = pt.mesh.transformed(pt.printR), a = pm.t;
    const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (let i = 0; i < a.length; i++) { const k = i % 3; if (a[i] < mn[k]) mn[k] = a[i]; if (a[i] > mx[k]) mx[k] = a[i]; }
    for (let i = 0; i < a.length; i++) a[i] -= mn[i % 3];
    pt.printTris = new Float32Array(a);
    pt.size = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    const [sx, sy, sz] = pt.size, bx = p.bedX, by = p.bedY, diag = Math.hypot(bx, by) - 10;
    pt.fits = sz <= p.bedZ && ((sx <= bx && sy <= by) || (sx <= by && sy <= bx) || (Math.max(sx, sy) <= diag && Math.min(sx, sy) < Math.min(bx, by) * 0.6));
    delete pt.mesh;
  }
  return {parts, spars, wingCuts: bounds, openings, wcs, bays, vtolBoom, bom, warns, servoMark, hornMark};
}
