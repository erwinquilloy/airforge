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
  const dPin = Math.min(c.pinDepth, (c.s1 - c.s0) / 2 - 2);
  if (c.pinsIn.length) add(c.s0 + dPin);
  if (c.pinsOut.length) add(c.s1 - dPin);
  const ys = [...S].sort((a, b) => a - b), N = ys.length, nU = c.U.length;
  const P = ys.map(s => foilPts(c.sectionAt(s), c.U, c.minTE));
  const gridIdx = c.U.map(u => XG.findIndex(x => Math.abs(x - u) < 1e-9));

  const stateOf = j => {
    const m = (ys[j] + ys[j + 1]) / 2;
    return {cs: !!cs && m > cs.a && m < cs.b, bays: c.bays.filter(b => m > b.a && m < b.b),
      hpIn: hpInOK && m > cs.a - cs.depth && m < cs.a, hpOut: hpOutOK && m > cs.b && m < cs.b + cs.depth,
      pinIn: c.pinsIn.length > 0 && m < c.s0 + dPin, pinOut: c.pinsOut.length > 0 && m > c.s1 - dPin};
  };
  const sig = st => [st.cs, st.bays.map(b => b.id).join("."), st.hpIn, st.hpOut, st.pinIn, st.pinOut].join("|");
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
    for (const sp of c.spars) h.push({key: "sp" + sp.id, fn: j => { const q = sp.line(ys[j]); return holeRing(q[0], q[1], sp.r, 24); }});
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
      faces.push({j, pts: [...arr.slice(b.ia, b.ib + 1), [arr[b.ib][0], z], [arr[b.ia][0], z]], holes: [], sign: inB ? 1 : -1});
    }
    const keysA = new Set(A.hk.map(h => h.key)), keysB = new Set(B.hk.map(h => h.key));
    for (const h of A.hk) if (!keysB.has(h.key) && !claimed.has(h.key)) discs.push({j, ring: h.fn(j), sign: -1});
    for (const h of B.hk) if (!keysA.has(h.key) && !claimed.has(h.key)) discs.push({j, ring: h.fn(j), sign: 1});
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
  /* One straight spar run per wing panel: a cranked wing needs its own tube outboard of the kink. */
  const kinkSeg = W.cranked ? bounds.findIndex(v => Math.abs(v - W.yk) < 12) : -1;
  const spars = [];
  A.tubes.forEach((t, id) => {
    const r = t.tube[0] / 2 + clr, pos = t.pos;
    const runs = kinkSeg > 0 ? [[0, kinkSeg], [kinkSeg, bounds.length - 1]] : [[0, bounds.length - 1]];
    runs.forEach(([segFrom, segMax], ri) => {
      const y0 = bounds[segFrom], y1 = bounds[segMax];
      const yA = Math.max(y0 + 1, Math.min(y0 + (y1 - y0) * 0.1, W.blendEnd)), yB = y1 - (y1 - y0) * 0.1;
      const pt = y => { const w = W.wingAt(y), [up, lo, x] = skin(w, pos); return [x, (up + lo) / 2]; };
      const PA = pt(yA), PB = pt(yB);
      const line = y => { const u = (y - yA) / (yB - yA); return [lerp(PA[0], PB[0], u), lerp(PA[1], PB[1], u)]; };
      const fits = y => {
        const w = W.wingAt(y), [lx, lz] = line(y), u = (lx - w.x) / w.c;
        if (u < 0.05 || u > 0.9) return false;
        const [up, lo] = skin(w, u);
        return up - r - 1.2 >= lz && lo + r + 1.2 <= lz;
      };
      let segs = segFrom;
      for (let i = segFrom + 1; i <= segMax; i++) {
        let ok = true;
        for (let k = 0; k <= 10; k++) if (!fits(lerp(bounds[i - 1], bounds[i], k / 10) * 0.999 + 0.001)) ok = false;
        if (ok) segs = i; else break;
      }
      if (segs > segFrom) spars.push({id: id * 4 + ri, tube: t.tube, segFrom, segs, yStart: bounds[segFrom], yEnd: bounds[segs], line, r});
    });
  });
  const sparXAt = y => spars.filter(sp => y >= sp.yStart - 1 && y <= sp.yEnd + 1).map(sp => [sp.line(y)[0], sp.r]);

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
  const servo = p.servoType === "custom" ? {L: p.servoL, W: p.servoW, H: p.servoH, mass: p.servoMass} : SERVOS[p.servoType] || SERVOS.ds041;
  const bays = [];
  const makeBay = (id, sMid, lenS, xFront, xBack, depth, side, kind, meta) => {
    const w = W.wingAt(sMid), ua = (xFront - w.x) / w.c, ub = (xBack - w.x) / w.c;
    if (ua < 0.06 || ub > 0.92 || ub - ua < 0.02) return null;
    return {id, a: sMid - lenS / 2, b: sMid + lenS / 2, ua, ub, depth, side, kind, meta};
  };
  if (wcs) {
    const wm = W.wingAt((wcs.a + wcs.b) / 2), [zu, zl] = skin(wm, wcs.uH - 0.12), thick = zu - zl;
    const stand = p.servoOrient === "stand" || (p.servoOrient === "auto" && thick >= servo.H + 3);
    const chord = (stand ? servo.W : servo.H) + 2 * 2.4 + 0.4, depth = (stand ? servo.H : servo.W) + 1, lenS = servo.L + 22 + 0.4;
    let sMid = lerp(wcs.a + lenS / 2 + 2, Math.max(wcs.a + lenS / 2 + 2, wcs.b - lenS / 2 - 2), p.servoPos);
    const seg = bounds.findIndex((v, i) => i < bounds.length - 1 && sMid >= v && sMid < bounds[i + 1]);
    const lo = bounds[seg] + (pin ? p.pinDepth : 0) + 4 + lenS / 2, hi = bounds[seg + 1] - (pin ? p.pinDepth : 0) - 4 - lenS / 2;
    if (hi > lo) sMid = Math.min(hi, Math.max(lo, sMid));
    const xBack = wm.x + wcs.uH * wm.c - 3, xFront = xBack - chord;
    const bay = makeBay("servo", sMid, lenS, W.wingAt(sMid).x + (wcs.uH * W.wingAt(sMid).c - p.servoGap - chord), W.wingAt(sMid).x + wcs.uH * W.wingAt(sMid).c - p.servoGap, depth, "bottom", "servo", {stand, servo});
    void xFront;
    if (bay && !sparXAt(sMid).some(([sx, sr]) => sx + sr + 2 > W.wingAt(sMid).x + bay.ua * W.wingAt(sMid).c)) bays.push(bay);
    else warns.push("The servo pocket collides with a spar; move the hinge line aft or the spar forward.");
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
      bays: segBays, spars: spars.filter(sp => si >= sp.segFrom && si < sp.segs), pinsIn, pinsOut, pinR, pinDepth: p.pinDepth, meta: true});
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
      const info = [...spars.filter(sp => si >= sp.segFrom && si < sp.segs).map(sp => `${tubeLabel(sp.tube)} bore`), nPins ? `${nPins} × ${pin[0]} mm pin pockets` : "", segBays.length ? segBays.map(b => b.kind === "servo" ? "servo pocket" : "hardpoint pocket").join(", ") : ""].filter(Boolean).join(", ");
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
    for (let si = 0; si < pb.length - 1; si++) {
      const s0 = pb[si], s1 = pb[si + 1];
      const pinAt = sy => {
        if (!pin || sy <= 0.5 || sy >= len - 1) return [];
        const a2 = at(sy), u = Math.min(tcs ? tcs.uH - 0.12 : 0.6, (a2.fA.xt || 0.3) + (rodLine ? 0.18 : 0)), P = foilPts(a2, [0, u], p.minTE);
        return P.up[1][1] - P.lo[1][1] >= 2 * pinR + 2 ? [[P.lo[1][0], (P.up[1][1] + P.lo[1][1]) / 2]] : [];
      };
      const pIn = pinAt(s0), pOut = pinAt(s1);
      const rodHere = rodLine && s0 < rodLine.sEnd - 1 ? [{id: 9, line: rodLine.line, r: rodLine.r}] : [];
      const rodBreak = rodHere.length && rodLine.sEnd < s1 ? rodLine.sEnd : null;
      // a rod that stops inside the segment is modelled as a pocket to its end
      const spRod = rodHere.length && rodBreak ? [] : rodHere;
      const local = buildLiftSeg({s0, s1, step: quick ? 30 : 12, breaks: [], sectionAt: at, U: Up, minTE: p.minTE * 0.8, cs: tcs ? {...tcs, pin: tcs.pinR ? {line: tcs.line, r: tcs.pinR} : null} : null,
        bays: [], spars: spRod, pinsIn: pIn, pinsOut: pOut, pinR, pinDepth: Math.min(p.pinDepth, 14), meta: false});
      let csMesh = null;
      if (tcs && tcs.b > s0 + 1 && tcs.a < s1 - 1) {
        const a = tcs.a >= s0 ? tcs.a + p.hingeGap / 2 : s0 + 0.3, b = tcs.b <= s1 ? tcs.b - p.hingeGap / 2 : s1 - 0.3;
        const hornG = lerp(tcs.a + 5, tcs.b - 5, p.tailHornPos), hornS = hornG > a + 3 && hornG < b - 3 ? hornG : null;
        csMesh = buildCSPart({a, b, step: quick ? 30 : 12, sectionAt: at, U: Up, minTE: p.minTE * 0.8, iH: tcs.iH, line: tcs.line, pinR: tcs.pinR, horn: hornS, hornDepth: p.hornLen * 0.85, hornSide: p.tailHornSide}).mesh;
        if (tcs.pinR) bom.hingePin += (b - a) + 2 * tcs.depth;
      }
      for (const side of mirrored ? [1, -1] : [1]) {
        const sd = [spanDir[0], side * spanDir[1], spanDir[2]], th = side > 0 ? thick : [thick[0], -thick[1], thick[2]];
        const Rw = placeRows([1, 0, 0], sd, th), tw = [root.x, side * root.y, root.z];
        const Rp = [[1, 0, 0], vcross(sd, [1, 0, 0]), sd];
        const sfx = `${mirrored ? (side > 0 ? "_R" : "_L") : ""}${pb.length > 2 ? "_" + (si + 1) : ""}`;
        const nPins = pIn.length + pOut.length;
        const info = [rodHere.length ? `${rod[0]} mm rod bore` : "", nPins ? `${nPins} × ${pin[0]} mm pin pockets` : ""].filter(Boolean).join(", ");
        part(name + sfx, group, local.transformed(Rw, tw), Rp, {seg: si, settings, info});
        if (csMesh) part((opt.csName || "elevator") + sfx, "ctrl", csMesh.transformed(Rw, tw), Rp, {seg: si, settings: "Stand on its end, 2 walls. Hinge pin through the pockets."});
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
    const addOpening = (id, x0, x1, ang, w, kind) => {
      x0 = Math.max(4, x0); x1 = Math.min(F.L - 4, x1);
      if (x1 - x0 < 6) return null;
      const idx = idxRun((x0 + x1) / 2, ang, w);
      const clash = openings.find(o => o.x1 > x0 - 2 && o.x0 < x1 + 2 && o.idx.some(k => idx.some(q => Math.abs(((q - k + nRing + nRing / 2) % nRing) - nRing / 2) <= 1)));
      if (clash) { warns.push(`The ${kind} overlaps the ${clash.kind}; drag it to a clear spot.`); return null; }
      const o = {id, x0, x1, ang, w, kind, idx}; openings.push(o); return o;
    };
    const hatches = [];
    const hatchSpec = (id, label, x0, len, width) => { const o = addOpening(id, x0, x0 + len, Math.PI / 2, width / 2, label); if (o) hatches.push(o); };
    if (p.hatchBatt) hatchSpec("hatchBatt", "battery hatch", p.hatchBattAuto ? L.xw + p.battX - p.hatchBattLen / 2 : p.hatchBattX, p.hatchBattLen, p.hatchBattW);
    if (p.hatchAv) hatchSpec("hatchAv", "avionics hatch", p.hatchAvX, p.hatchAvLen, p.hatchAvW);
    if (p.deck) hatchSpec("deck", "canopy bay", L.xw + p.deckX, p.deckLen, p.deckW);
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
      if (p.motorLayout !== "tractor") {
        const xc0 = 3, xc1 = Math.min(xs - 4, 3 + cam * 1.25), [hwc, , zcc] = F.profile((xc0 + xc1) / 2);
        const floorZ = zcc - cam * 0.55 - 2, wIn = hwc - t + 0.4;
        nose.add(plate(rect(xc0, -wIn, xc1, wIn), [], 2).transformed(ID3, [0, 0, floorZ]));
        for (const s of [1, -1]) nose.add(plate(rect(xc0, 0, xc1, cam * 1.05 + 2), [circle(xc0 + cam * 0.55, zcc - floorZ, 1.1, 14)], 2).transformed([[1, 0, 0], [0, 0, 1], [0, 1, 0]], [0, s * (cam / 2 + 0.4) + (s > 0 ? 0 : -2), floorZ]));
      }
      part("fpv_nose", "fuse", nose, [[0, -1, 0], [0, 0, 1], [-1, 0, 0]], {settings: "Stand on the open front. PETG/ASA, 3 perimeters. Camera pivots on M2 screws; the spigot slides into the fuselage."});
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
