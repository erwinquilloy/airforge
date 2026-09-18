"use strict";
/* ==========================================================================
   Layout: turns parameters into an engineering description of the aircraft —
   wing sections, tail surfaces, fuselage profile, booms, motors, nacelles and
   mounts. Aircraft frame: x aft from the nose, y starboard, z up (mm).
   Shared by the aero solver, the mass model and the solid geometry builder.
   ========================================================================== */
const D2R = Math.PI / 180;
const smooth = u => { u = Math.min(1, Math.max(0, u)); return u * u * (3 - 2 * u); };
const lerp = (a, b, t) => a + (b - a) * t;
const IN = 25.4;

function foilOf(id, fallback) { return FOILS[id] || FOILS[fallback]; }

function makeLayout(p) {
  const log = [];                                     // design rationale ("why this dimension")
  const note = (topic, text) => { if (!log.some(q => q[0] === topic && q[1] === text)) log.push([topic, text]); };   // never say the same thing twice
  const fRoot = foilOf(p.foilRoot, "naca2412"), fTip = foilOf(p.foilTip, "naca2412");
  const fTail = foilOf(p.foilTail, "naca0009");
  const hasFuse = p.fuseType !== "none";
  const tailless = p.tailType === "none" || p.tailType === "fin";
  const half = p.span / 2;
  const cr = p.rootChord, ct = cr * p.taper;
  const outerLen = half;
  // cranked wing: inner panel to the kink, then its own sweep, taper and dihedral
  const cranked = p.panels === "2" && p.wingType !== "delta";
  const yk = cranked ? p.kinkPos * half : 0, ck = cranked ? cr * p.kinkChord : cr;
  // wing–fuselage blend starts just inside the fuselage side
  const blend = hasFuse && p.wingBlend, yf = blend ? p.fuseW / 2 * 0.85 : 0, yBlendEnd = blend ? Math.min(half * 0.6, yf + p.blendSpan) : 0;
  let tanLE = Math.tan(p.sweep * D2R);
  if (p.wingType === "delta") {
    tanLE = ((cr - ct) + outerLen * Math.tan(p.teSweep * D2R)) / outerLen;
    note("Wing", `Delta leading-edge sweep ${fmtN(Math.atan(tanLE) / D2R, 1)}° follows from the ${fmtN(cr)} mm root, ${fmtN(ct)} mm tip and ${p.teSweep}° trailing edge.`);
  }
  const tanDih = Math.tan(p.dihedral * D2R), tanDih2 = Math.tan((cranked ? p.dihedralOuter : p.dihedral) * D2R);
  const tanLE2 = cranked ? Math.tan(p.sweepOuter * D2R) : 0;
  const xw = hasFuse ? p.noseLen : 0;
  const podTailless = p.fuseType === "pod" && (tailless);
  const zWing = !hasFuse ? 0 : podTailless ? 0 : p.tailType === "twinboom" ? p.fuseH * 0.32 : p.fuseH * 0.2;

  /* wing section at spanwise station y >= 0 */
  function wingAt(y) {
    const v = y / outerLen;
    let xl, c, thick = 1;
    if (!cranked) { xl = y * tanLE; c = cr + (ct - cr) * v; }
    else if (y <= yk) { xl = y * tanLE; c = lerp(cr, ck, y / Math.max(1, yk)); }
    else { xl = yk * tanLE + (y - yk) * tanLE2; c = lerp(ck, ct, (y - yk) / Math.max(1, half - yk)); }
    if (blend && y < yBlendEnd) {
      const k = 1 - smooth((y - yf) / (yBlendEnd - yf));            // 1 at the fuselage side, 0 where the blend ends
      const c2 = c * (1 + (p.blendChord - 1) * k);
      xl -= (c2 - c) * 0.6; c = c2; thick = 1 + (p.blendThick - 1) * k;
    }
    return {x: xw + xl, y, z: dihZ(y), c, fA: fRoot, fB: fTip, s: v, twist: -p.washout * v, thick};
  }
  const dihZ = y => zWing + (cranked && y > yk ? yk * tanDih + (y - yk) * tanDih2 : y * tanDih);
  const wingBreaks = [0, yf, yBlendEnd, cranked ? yk : 0, half].filter((v, i, a) => v >= 0 && v <= half && a.indexOf(v) === i).sort((a, b) => a - b);
  if (blend) note("Wing", `Root blended into the fuselage over ${fmtN(yBlendEnd - yf)} mm: chord ×${p.blendChord}, thickness ×${p.blendThick} at the fuselage side.`);

  // integrate wing reference quantities
  let S2 = 0, c2 = 0, xc = 0, yc = 0, xCent = 0; const NI = 400;
  for (let i = 0; i < NI; i++) {
    const y = (i + 0.5) / NI * half, w = wingAt(y), dy = half / NI;
    S2 += w.c * dy; c2 += w.c * w.c * dy; xc += w.x * w.c * dy; yc += y * w.c * dy; xCent += (w.x + 0.42 * w.c) * w.c * dy;
  }
  const S = 2 * S2, mac = 2 * c2 / S, xMacLE = 2 * xc / S, yMac = yc / S2;
  const AR = p.span ** 2 / S;
  const xacW = xMacLE + 0.25 * mac;
  const wing = {half, S, mac, xMacLE, yMac, AR, xacW, xCentroid: xCent / S2, cr, ct, tanLE, bw2: 0, y0: 0, blendEnd: yBlendEnd, cranked, yk, dihZ, wingAt, breaks: wingBreaks, fRoot, fTip};
  const xTEat = y => { const w = wingAt(y); return w.x + w.c; };

  /* ---- fuselage ---- */
  const fuse = {type: p.fuseType, W: p.fuseW, H: p.fuseH, L: 0, wall: p.fuseWall};
  /* ---- tail surfaces (each surface: list of stations {x,y,z,c,fA,fB,s,twist}, mirrored flag) ---- */
  const surfaces = [];
  const tipFins = [];
  const booms = [];
  let tail = {Sh: 0, Sv: 0, arm: 0};
  const tl = 0.7;
  const panel = (root, dir, len, crr, ctt, tanSw, n, foil) => {
    const st = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, c = lerp(crr, ctt, t);
      st.push({x: root[0] + len * t * tanSw, y: root[1] + dir[1] * len * t, z: root[2] + dir[2] * len * t, c, fA: foil, fB: foil, s: t, twist: 0});
    }
    return st;
  };
  const arm = p.tailArm * p.span;
  let tailX = xacW + arm, zTail = zWing;
  if (!tailless) {
    const Sh = p.hVol * S * mac / arm, Sv = p.vVol * S * p.span / arm;
    tail = {Sh, Sv, arm};
    note("Tail", `Horizontal area ${fmtN(Sh / 1e4, 1)} dm² from tail volume ${p.hVol} × wing area × MAC ÷ ${fmtN(arm)} mm arm; vertical ${fmtN(Sv / 1e4, 1)} dm² from volume ${p.vVol}.`);
  }
  // fuselage length depends on the tail
  const fuseLenFor = xEnd => Math.max(xEnd, xw + cr);
  /* Side and plan profile from the shape controls. Returns [half width, half height, center z]:
     the section is a superellipse whose top and bottom halves can have different flatness. */
  const shapeOf = (x, L, pod) => {
    const W = p.fuseW / 2, hTop = p.fuseH * p.topFrac, hBot = p.fuseH * (1 - p.topFrac), bd = p.boomD / 2;
    const xm0 = Math.min(L * 0.7, Math.max(25, p.maxAtX * L));                       // widest station
    const xm1 = pod ? L * 0.62 : Math.min(L * 0.92, Math.max(xm0 + 10, xw + cr * 1.05));   // start of the tail cone
    let s = 1, e = 0;
    if (x <= xm0) {
      const u = Math.min(1, Math.max(0, x / xm0));
      s = p.noseBlunt + (1 - p.noseBlunt) * Math.pow(Math.max(0, 1 - (1 - u) ** 2), 0.5 * p.noseShape);
    } else if (x > xm1) {
      const v = Math.min(1, (x - xm1) / Math.max(1, L * (pod ? 1 : 0.95) - xm1));
      e = Math.pow(0.5 - 0.5 * Math.cos(Math.PI * v), p.tailShape);
      const endS = pod ? 0.45 : Math.min(1, Math.max(bd / Math.max(W, (hTop + hBot) / 2), p.fuseType === "full" ? 0.4 : 0.05));
      s = 1 + (endS - 1) * e;
    }
    const top = hTop * s, bot = hBot * s;
    const rise = (hTop - top) * p.tailRise * (x > xm1 ? 1 : 0);
    return [Math.max(1.5, W * s), Math.max(1.5, (top + bot) / 2), (top - bot) / 2 + rise];
  };

  if (p.tailType === "conv" || p.tailType === "ttail" || p.tailType === "vtail") {
    // tail height: top of fuselage/boom line
    if (p.fuseType === "podboom" || p.fuseType === "full") {
      const Lguess = tailX + 0.6 * Math.sqrt(tail.Sh / p.hAR) * 0.5 + 60;
      const [, hh, zc] = shapeOf(tailX, Lguess, false); zTail = zc + hh * 0.3;
    } else {
      zTail = hasFuse ? p.fuseH * 0.25 : zWing;
    }
    if (p.tailType === "vtail") {
      const St = tail.Sh + tail.Sv, g = Math.atan(Math.sqrt(tail.Sv / tail.Sh)), sp = Math.sqrt(p.hAR * St);
      const c0 = 2 * St / (sp * (1 + tl)), mc = 2 / 3 * c0 * (1 + tl + tl * tl) / (1 + tl), len = sp / 2;
      const root = [tailX - 0.25 * mc - len * 0.25 * Math.tan(18 * D2R), 0, zTail];
      surfaces.push({name: "vtail", kind: "vtail", mirrored: true, trim: true, gamma: g, st: panel(root, [0, Math.cos(g), Math.sin(g)], len, c0, c0 * tl, Math.tan(18 * D2R), 6, fTail)});
      tail.gamma = g; tail.St = St;
      note("Tail", `V-tail dihedral ${fmtN(g / D2R, 1)}° = atan√(Sv/Sh) keeps the pitch and yaw tail volumes of the equivalent cross tail.`);
      tail.xEnd = root[0] + c0 + len * Math.tan(18 * D2R);
    } else {
      const Sh = tail.Sh, sp = Math.sqrt(p.hAR * Sh), c0 = 2 * Sh / (sp * (1 + tl)), mc = 2 / 3 * c0 * (1 + tl + tl * tl) / (1 + tl);
      const finH = Math.sqrt(p.vAR * tail.Sv), fc = 2 * tail.Sv / (finH * (1 + 0.6)), fmc = 2 / 3 * fc * (1 + 0.6 + 0.36) / 1.6;
      const finRoot = [tailX - 0.25 * fmc - finH * 0.3 * Math.tan(30 * D2R), 0, zTail];
      surfaces.push({name: "fin", kind: "fin", mirrored: false, st: panel(finRoot, [0, 0, 1], finH, fc, fc * 0.6, Math.tan(30 * D2R), 4, fTail)});
      let hRoot;
      if (p.tailType === "ttail") hRoot = [finRoot[0] + finH * Math.tan(30 * D2R) + fc * 0.6 - c0 * 0.9, 0, zTail + finH];
      else hRoot = [tailX - 0.25 * mc - sp / 2 * 0.3 * Math.tan(8 * D2R), 0, zTail];
      surfaces.push({name: "stab", kind: "htail", mirrored: true, trim: true, st: panel(hRoot, [0, 1, 0], sp / 2, c0, c0 * tl, Math.tan(8 * D2R), 6, fTail)});
      tail.xEnd = Math.max(finRoot[0] + fc, hRoot[0] + c0 + sp / 2 * Math.tan(8 * D2R));
      tail.finH = finH;
    }
  } else if (p.tailType === "twinboom") {
    const yb = p.boomSpacing * p.span / 2, zb = zWing - 0.04 * cr;
    const hc = tail.Sh / (2 * yb), finA = tail.Sv / 2, finH = Math.sqrt(p.vAR * finA), fc = 2 * finA / (finH * 1.6);
    const hRoot = [tailX - 0.25 * hc, 0, zb];
    surfaces.push({name: "stab", kind: "htail", mirrored: true, trim: true, st: panel(hRoot, [0, 1, 0], yb, hc, hc, 0, 5, fTail)});
    const finRoot = [tailX - 0.25 * fc, yb, zb];
    surfaces.push({name: "fin", kind: "fin", mirrored: true, st: panel(finRoot, [0, 0, 1], finH, fc, fc * 0.6, Math.tan(25 * D2R), 4, fTail)});
    const xb0 = wingAt(yb).x + 0.2 * wingAt(yb).c;
    const tube = tubeFor(Math.max(finRoot[0] + fc, hRoot[0] + hc) - xb0, 5);
    booms.push({a: [xb0, yb, zb], b: [Math.max(finRoot[0] + fc, hRoot[0] + hc), yb, zb], tube, mirrored: true, role: "tail"});
    tail.xEnd = hRoot[0] + hc; tail.yb = yb;
    note("Tail", `Twin booms at ±${fmtN(yb)} mm carry a ${fmtN(yb * 2)} × ${fmtN(hc)} mm stabilizer between them.`);
  } else if (p.tailType === "fin") {
    const finH = Math.sqrt(p.vAR * Math.max(tail.Sv, 1)), Sv = p.vVol * S * p.span / Math.max(mac, (xTEat(0) - xacW) + 0.3 * mac);
    const h = Math.sqrt(p.vAR * Sv), fc = 2 * Sv / (h * 1.6);
    const w0 = wingAt(0);
    const zTop = hasFuse ? p.fuseH / 2 : zWing + w0.c * (w0.fA.t) * 0.5;
    surfaces.push({name: "fin", kind: "fin", mirrored: false, st: panel([w0.x + w0.c - fc, 0, zTop], [0, 0, 1], h, fc, fc * 0.55, Math.tan(40 * D2R), 4, fTail)});
    tail = {Sh: 0, Sv, arm: w0.x + w0.c - fc * 0.5 - xacW};
    tail.xEnd = w0.x + w0.c;
    note("Tail", `Center fin ${fmtN(Sv / 1e4, 1)} dm² sized from vertical tail volume ${p.vVol} using the short arm to the wing trailing edge.`);
  }
  if (p.tipFins) {
    const w = wingAt(half), h = p.tipFinH, fc = w.c * 0.95, ca = p.wingletCant * D2R;
    tipFins.push({name: p.wingletCant > 5 ? "winglet" : "tipfin", st: panel([w.x + w.c - fc, half, w.z], [0, Math.sin(ca), Math.cos(ca)], h, fc, fc * 0.55, Math.tan(35 * D2R), 3, fTail)});
  }

  // fuselage length & profile
  if (p.fuseType === "podboom" || p.fuseType === "full") fuse.L = fuseLenFor(tail.xEnd || (xw + cr * 1.6));
  else if (p.fuseType === "pod") fuse.L = Math.max(p.podLen, 60);
  fuse.E = [lerp(2.2, 6, p.topFlat), lerp(2.2, 6, p.botFlat)];      // superellipse exponents: 2 = ellipse, high = boxy
  fuse.profile = x => shapeOf(Math.min(fuse.L, Math.max(0, x)), fuse.L, p.fuseType === "pod");
  /* helpers so every ring, surface point and hatch edge uses the same section */
  fuse.ring = (x, n, off = 0) => { const [hw, hh, zc] = fuse.profile(x); return superRing(Math.max(0.4, hw + off), Math.max(0.4, hh + off), zc, n, fuse.E); };
  fuse.pt = (x, ang, off = 0) => {
    const [hw, hh, zc] = fuse.profile(x), c = Math.cos(ang), s = Math.sin(ang), E = s >= 0 ? fuse.E[0] : fuse.E[1];
    return [(hw + off) * Math.sign(c) * Math.pow(Math.abs(c), 2 / E), zc + (hh + off) * Math.sign(s) * Math.pow(Math.abs(s), 2 / E)];
  };
  fuse.zAt = (x, y, off = 0, lower) => {                             // surface z above (or below) a lateral offset
    const [hw, hh, zc] = fuse.profile(x), E = lower ? fuse.E[1] : fuse.E[0], u = Math.min(1, Math.abs(y) / Math.max(0.4, hw + off));
    return zc + (lower ? -1 : 1) * (hh + off) * Math.pow(Math.max(0, 1 - Math.pow(u, E)), 1 / E);
  };
  fuse.halfAt = (x, z, off = 0) => {                                 // lateral half width where the surface reaches z
    const [hw, hh, zc] = fuse.profile(x), E = z >= zc ? fuse.E[0] : fuse.E[1], v = Math.abs(z - zc) / Math.max(0.4, hh + off);
    return v >= 1 ? 0 : (hw + off) * Math.pow(1 - Math.pow(v, E), 1 / E);
  };
  if (p.fuseType === "pod" && (p.tailType === "conv" || p.tailType === "ttail" || p.tailType === "vtail")) {
    const x0 = fuse.L * 0.72, [, hh] = shapeOf(x0, fuse.L, true);
    booms.push({a: [x0, 0, hh * 0.35], b: [tail.xEnd, 0, zTail], tube: tubeFor(tail.xEnd - x0, 4), mirrored: false, role: "tail"});
    note("Fuselage", "Short pod with a single carbon tail boom; the tail surfaces clamp to its end.");
  }

  /* ---- vertical tail/fin surfaces are not lifting for the pitch solver ---- */
  const wingSurf = {name: "wing", kind: "wing", mirrored: true, wingAt};

  /* ---- motors ---- */
  const motors = [], nacelles = [];
  const propR = p.propD * IN / 2;
  const main = motorOf(p);
  if (p.motorLayout === "tractor") {
    const z = hasFuse ? fuse.profile(0)[2] : zWing;
    motors.push({pos: [-28, 0, z], dir: [-1, 0, 0], propD: p.propD, role: "cruise", mount: "firewall"});
  } else if (p.motorLayout === "pusher") {
    if (p.fuseType === "podboom" || p.fuseType === "full" || (p.fuseType === "pod" && booms.some(b => b.role === "tail" && !b.mirrored))) {
      const x = xTEat(0) + 25, prof = fuse.L ? fuse.profile(Math.min(x, fuse.L)) : [0, p.fuseH / 2, 0];
      const boomTop = (booms.find(b => !b.mirrored)?.a[2] ?? prof[2]) + Math.max(prof[1] * 0.4, (booms[0]?.tube?.[0] || p.boomD) / 2);
      const z = Math.max(prof[2] + prof[1] + 25, boomTop + propR + 12);
      motors.push({pos: [x, 0, z], dir: [1, 0, 0], propD: p.propD, role: "cruise", mount: "pylon", pylonBase: prof[2] + prof[1] - 4});
      const mast = z - prof[2] - prof[1];
      note("Propulsion", `Pusher on a ${fmtN(mast)} mm pylon so the ${p.propD}" disc clears the tail by 12 mm.`);
      motors[motors.length - 1].mast = mast;
    } else {
      const x = Math.max(fuse.L || 0, xTEat(0)) + 20;
      motors.push({pos: [x, 0, hasFuse ? 0 : zWing], dir: [1, 0, 0], propD: p.propD, role: "cruise", mount: "firewall"});
    }
  } else {
    const y = p.motorSpan * half, w = wingAt(y), push = p.motorLayout === "twinpusher";
    const x = push ? w.x + w.c + 30 : w.x - 40;
    for (const sgn of [1, -1]) motors.push({pos: [x, sgn * y, w.z], dir: [push ? 1 : -1, 0, 0], propD: p.propD, role: "cruise", mount: "nacelle"});
    nacelles.push({y, x0: push ? w.x + w.c * 0.35 : w.x - 30, x1: push ? w.x + w.c + 22 : w.x + w.c * 0.6, r: main.can / 2 + 5, z: w.z, push});
    if (propR > y - (hasFuse ? p.fuseW / 2 : 0) - 8) note("Propulsion", `Warning: the ${p.propD}" propellers come within ${fmtN(y - propR - (hasFuse ? p.fuseW / 2 : 0))} mm of the fuselage.`);
  }

  /* ---- VTOL ---- */
  const vtol = {type: p.vtol, lift: [], extraMass: 0, tiltServos: 0};
  if (p.vtol === "quad") {
    const yb = p.vtolBoomY * half, w = wingAt(yb), R = p.liftPropD * IN / 2;
    const xf = w.x - R - 20, xr = w.x + w.c + R + 20, zb = w.z - 0.06 * w.c - 12;
    booms.push({a: [xf, yb, zb], b: [xr, yb, zb], tube: p.liftPropD > 12 ? [20, 18] : [16, 14], mirrored: true, role: "vtol"});
    for (const sy of [1, -1]) for (const x of [xf, xr]) vtol.lift.push({pos: [x, sy * yb, zb + 22], dir: [0, 0, 1], propD: p.liftPropD, role: "lift"});
    note("VTOL", `Lift booms at ±${fmtN(yb)} mm place the ${p.liftPropD}" props 20 mm ahead of the leading edge and behind the trailing edge.`);
  } else if (p.vtol === "tilttri") {
    const x = xTEat(0) + propR + 40, z = hasFuse && fuse.L > x ? fuse.profile(x)[2] + fuse.profile(x)[1] + 20 : zWing + 30;
    vtol.lift.push({pos: [x, 0, z], dir: [0, 0, 1], propD: p.propD, role: "lift"});
    vtol.tiltServos = 2;
  } else if (p.vtol === "vector") vtol.tiltServos = 2;
  else if (p.vtol === "tailsitter") vtol.legs = true;

  return {p, log, note, hasFuse, tailless, xw, zWing, wing, wingSurf, surfaces, tipFins, fuse, tail, booms, motors, nacelles, vtol, main, fTail};
}

function tubeFor(len, n) {                                          // pick a boom tube by length
  if (len < 350) return [8, 6]; if (len < 600) return [10, 8]; if (len < 900) return [12, 10]; return [16, 14];
}
function motorOf(p) {
  if (p.motorId === "custom") return {id: "custom", name: "Custom motor", kv: p.cKv, rm: p.cRm, io: p.cIo, mass: p.cMass, imax: p.cImax, maxCells: 12, can: Math.max(20, Math.sqrt(p.cMass) * 4.2), mountId: p.cMass > 90 ? "sq25" : p.cMass > 45 ? "x19_25" : "x16_19"};
  return MOTORS.find(m => m.id === p.motorId) || MOTORS[3];
}
function fmtN(v, d = 0) { return isFinite(v) ? Number(v).toLocaleString("en-US", {minimumFractionDigits: d, maximumFractionDigits: d}) : "—"; }
