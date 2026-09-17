"use strict";
/* ==========================================================================
   Full conceptual analysis: masses and CG, VLM aerodynamics, trim and
   stability, powertrain performance, VTOL hover, maximum takeoff weight,
   payload–range and design checks.
   ========================================================================== */
const G0 = 9.81, MU_AIR = 1.81e-5;
const isaRho = h => 1.225 * Math.pow((288.15 - 0.0065 * h) / 288.15, 4.2559);
const RES = {fine: {ns: 18, nc: 5, nsTail: 6}, coarse: {ns: 7, nc: 3, nsTail: 3}};

/* VLM results depend only on the airframe shape: cache them across power, balance and mission changes */
const AERO_CACHE = new Map();
const AERO_KEYS = SCHEMA.filter(f => f.tab === "air" && ["cfg", "wing", "tail", "fuse"].includes(f.group)).map(f => f.id).concat(["foilRoot", "foilTip", "foilTail"]);
function cachedVLM(L, p, resName) {
  const key = resName + "|" + AERO_KEYS.map(k => p[k]).join("|");
  let a = AERO_CACHE.get(key);
  if (!a) { a = solveVLM(L, RES[resName]); AERO_CACHE.set(key, a); if (AERO_CACHE.size > 60) AERO_CACHE.delete(AERO_CACHE.keys().next().value); }
  return a;
}

function analyze(p, opts = {}) {
  const L = makeLayout(p), res = RES[opts.res || "fine"];
  const aero = cachedVLM(L, p, opts.res || "fine");
  const rho = isaRho(p.altitude);
  const mat = MATERIALS[p.material], gmm3 = mat.rho / 1000, petg = 1.27e-3;
  const W = L.wing, items = [], add = (name, mass, x, group) => { if (mass > 0.01) items.push({name, mass, x, group}); };
  const note = L.note;

  /* ---------- printed structure ---------- */
  const shellStations = (st, mirror) => {                              // lifting-surface shell mass & centroid
    let m = 0, mx = 0;
    for (let k = 0; k < st.length - 1; k++) {
      const a = st[k], b = st[k + 1], ds = Math.hypot(b.y - a.y, b.z - a.z), c = (a.c + b.c) / 2;
      const per = (lerp(a.fA.perC, a.fB.perC, a.s) + lerp(b.fA.perC, b.fB.perC, b.s)) / 2;
      const ar = (lerp(a.fA.areaC, a.fB.areaC, a.s) * (a.thick || 1) + lerp(b.fA.areaC, b.fB.areaC, b.s) * (b.thick || 1)) / 2;
      const mass = (per * c * ds * p.wall + ar * c * c * ds * p.infill / 100) * gmm3 * 1.06;
      m += mass; mx += mass * ((a.x + b.x) / 2 + 0.42 * c);
    }
    const k = mirror ? 2 : 1;
    return {m: m * k * p.kMass, x: m ? mx / m : 0};
  };
  const wingSt = []; { const n = 60; for (let i = 0; i <= n; i++) wingSt.push(W.wingAt(W.half * i / n)); }
  const ws = shellStations(wingSt, true); add("Wing skin", ws.m, ws.x, "structure");
  let tailM = 0, tailMx = 0;
  for (const s of L.surfaces) { const r = shellStations(s.st, s.mirrored); tailM += r.m; tailMx += r.m * r.x; }
  for (const s of L.tipFins) { const r = shellStations(s.st, true); tailM += r.m; tailMx += r.m * r.x; }
  if (tailM) add(L.tailless ? "Fins" : "Tail surfaces", tailM, tailMx / tailM, "structure");

  let fuseWet = 0, fuseM = 0, fuseMx = 0;
  if (L.hasFuse) {
    const n = 40, dx = L.fuse.L / n;
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) * dx, [a, b] = L.fuse.profile(x);
      const per = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
      fuseWet += per * dx; const m = per * dx * p.fuseWall * gmm3; fuseM += m; fuseMx += m * x;
    }
    fuseM *= 1.08 * p.kMass;                                           // bulkheads, joiner sleeves, nose spigot
    add(p.fuseType === "pod" ? "Pod shell" : "Fuselage shell", fuseM, fuseMx / (fuseM / 1.08 / p.kMass), "structure");
  }
  let nacWet = 0;
  for (const nc of L.nacelles) {
    const len = nc.x1 - nc.x0, wet = 2 * Math.PI * nc.r * len * 0.85; nacWet += 2 * wet;
    add("Motor nacelles", 2 * wet * 1.0 * gmm3 * p.kMass + 2 * 8, (nc.x0 + nc.x1) / 2, "structure");
  }
  /* mounts and bays */
  const camX = 18;
  if (L.hasFuse && p.noseMode === "replaceable") add("Camera cradle + nose joint", 9, camX + 20, "structure");
  for (const mo of L.motors) {
    if (mo.mount === "firewall") add("Motor firewall", 7, mo.pos[0] + (mo.dir[0] < 0 ? 26 : -26), "structure");
    if (mo.mount === "pylon") add("Motor pylon", (mo.pos[2] - mo.pylonBase) * 40 * 4 * petg * 0.6 + 6, mo.pos[0] - 15, "structure");
  }
  let deckF = 0, podWet = 0;
  if (p.deck) { add("FPV canopy & FC shelf", p.deckLen * (p.deckW + 2.2 * p.canopyH) * 1.2 * gmm3 + (p.fcShelf ? p.deckLen * p.deckW * 2 * petg * 0.5 : 0), L.xw + p.deckX + p.deckLen / 2, "structure"); deckF = 0.12 * p.deckW * p.canopyH; }
  if (p.pod) { podWet = Math.PI * p.podD * p.podL * 0.8; add("Underslung pod", podWet * 1.0 * petg * 0.8 + 8, L.xw + p.podX + p.podL / 2, "structure"); }
  if (p.gpsMast) add("GPS mast", 8 + p.mastH * 0.12, L.xw + 40, "structure");

  /* ---------- propulsion ---------- */
  const pk = pack(p), mm = L.main, nCruise = L.motors.length;
  for (const mo of L.motors) {
    add("Cruise motors", mm.mass, mo.pos[0], "propulsion");
    add("ESCs", escMass(mm.imax), mo.pos[0] + (mo.dir[0] < 0 ? 40 : -40), "propulsion");
    add("Propellers", propMass(p.propD), mo.pos[0] + mo.dir[0] * 12, "propulsion");
  }
  const lm = MOTORS.find(m => m.id === p.liftMotorId) || MOTORS[7];
  let nLift = 0, liftMotor = mm, liftD = p.propD, liftP = p.propP;
  if (p.vtol === "quad") {
    nLift = 4; liftMotor = lm; liftD = p.liftPropD; liftP = p.liftPropP;
    for (const mo of L.vtol.lift) { add("Lift motors", lm.mass, mo.pos[0], "vtol"); add("Lift ESCs", escMass(lm.imax), mo.pos[0], "vtol"); add("Lift propellers", propMass(p.liftPropD), mo.pos[0], "vtol"); add("Boom motor mounts", 12, mo.pos[0], "vtol"); }
    add("Boom saddles", 4 * 8, W.xacW, "vtol");
  } else if (p.vtol === "tilttri") {
    nLift = 3;
    for (const mo of L.vtol.lift) { add("Rear lift motor", mm.mass, mo.pos[0], "vtol"); add("Rear ESC", escMass(mm.imax), mo.pos[0], "vtol"); add("Rear propeller", propMass(p.propD), mo.pos[0], "vtol"); add("Rear motor mount", 14, mo.pos[0], "vtol"); }
    add("Tilt servos + hinges", 2 * 22, L.motors[0].pos[0] + 30, "vtol");
  } else if (p.vtol === "vector") { nLift = 2; add("Vectoring servos + hinges", 2 * 18, L.motors[0].pos[0] + 30, "vtol"); }
  else if (p.vtol === "tailsitter") { nLift = nCruise; add("Landing skids", 24, W.xacW + W.mac * 0.6, "vtol"); }
  for (const b of L.booms) {
    const len = Math.hypot(b.b[0] - b.a[0], b.b[1] - b.a[1], b.b[2] - b.a[2]);
    add(b.role === "vtol" ? "VTOL booms" : "Tail booms", tubeMassPerM(b.tube) * len / 1000 * (b.mirrored ? 2 : 1), (b.a[0] + b.b[0]) / 2, b.role === "vtol" ? "vtol" : "structure");
  }

  /* ---------- servos, avionics, battery, payload ---------- */
  const servo = p.servoType === "custom" ? {mass: p.servoMass} : SERVOS[p.servoType] || SERVOS.ds041;
  const wHinge = W.wingAt(W.half * lerp(p.csStart, p.csEnd, p.servoPos));
  add("Wing servos", servo.mass * 2, wHinge.x + (p.hingePos - 0.1) * wHinge.c, "systems");
  if (p.ctrlSurf) add("Servo frames, covers, horns", 2 * 6 + (L.tailless ? 0 : 2 * 1.5), wHinge.x + p.hingePos * wHinge.c, "structure");
  if (!L.tailless) add("Tail servos", servo.mass * 2, L.hasFuse ? W.xacW + 0.3 * L.tail.arm : W.xacW + L.tail.arm * 0.8, "systems");
  if (L.hasFuse && p.battTray) add("Battery tray", 12, L.xw + p.battX, "structure");
  if (L.hasFuse && p.intake) add("NACA duct insert", 6 * (p.intakeMirror ? 2 : 1), p.intakeX + p.intakeL / 2, "structure");
  const nInserts = (p.deck && p.hatchLatch === "screws" ? 2 : 0) + (p.pod ? 4 : 0) + (p.ctrlSurf ? 4 : 0) + (p.vtol === "quad" ? 4 : 0) + (p.motorLayout === "tractor" ? 4 : 0);
  add("Heat-set inserts & screws", nInserts * 1.1, W.xacW, "structure");
  const noseX = L.hasFuse ? camX : L.xw + 30;
  for (const c of p.components) add(c.name, +c.mass || 0, c.x == null || c.x === "" ? noseX : L.xw + (+c.x), "systems");
  const battMass = pk.Wh / pk.ch.whkg * 1000 * 1.03;
  add("Battery", battMass, L.xw + p.battX, "battery");
  add("Payload", p.payload, L.xw + p.payloadX, "payload");
  const structSum = items.filter(i => i.group === "structure").reduce((s, i) => s + i.mass, 0);
  add("Hardware & glue", 0.03 * structSum + 10, W.xacW, "structure");

  /* ---------- spar sizing (needs total weight: iterate) ---------- */
  const fitAt = (y, pos) => {                                          // local depth available at the spar line
    const w = W.wingAt(y), t = lerp(thicknessAt(w.fA, pos), thicknessAt(w.fB, pos), w.s) * (w.thick || 1);
    return t * w.c;
  };
  let mtow = items.reduce((s, i) => s + i.mass, 0), tubes = [], sparM = 0, M_root = 0;
  for (let it = 0; it < 3; it++) {
    M_root = p.loadFactor * mtow / 1000 * G0 * aero.rootMomentPerLift;
    const share = p.spar2Pos > 0 ? [0.72, 0.28] : [1];
    const pos = p.spar2Pos > 0 ? [p.sparPos, p.spar2Pos] : [p.sparPos];
    tubes = pos.map((ps, i) => {
      const depth = Math.min(...[W.blendEnd, W.half * 0.15].map(y => fitAt(Math.min(y, W.half), ps)));
      const wallNeed = d => d + 2 * p.fitClear + 2.4;
      const manual = tubeFromKey(i ? p.spar2Size : p.spar1Size);
      const auto = TUBES.find(tb => M_root * share[i] / tubeZ(tb) <= CARBON_ALLOW && wallNeed(tb[0]) <= depth);
      const fallback = TUBES.filter(tb => wallNeed(tb[0]) <= depth).pop() || TUBES[0];
      const tb = manual || auto || fallback;
      const strong = M_root * share[i] / tubeZ(tb) <= CARBON_ALLOW, fits = wallNeed(tb[0]) <= depth;
      let yEnd = 0; for (let k = 1; k <= 60; k++) { const y = W.half * k / 60; if (fitAt(y, ps) >= wallNeed(tb[0])) yEnd = y; else break; }
      return {pos: ps, tube: tb, manual: !!manual, ok: strong && fits, strong, fits, depth, len: 2 * Math.min(yEnd, W.half * 0.94), stress: M_root * share[i] / tubeZ(tb)};
    });
    sparM = tubes.reduce((s, t) => s + tubeMassPerM(t.tube) * t.len / 1000, 0);
    mtow = items.reduce((s, i) => s + i.mass, 0) + sparM;
  }
  add("Carbon spars", sparM, W.wingAt(W.half * 0.3).x + p.sparPos * W.wingAt(W.half * 0.3).c, "structure");
  mtow = items.reduce((s, i) => s + i.mass, 0);
  const Wn = mtow / 1000 * G0;
  const xcg = items.reduce((s, i) => s + i.mass * i.x, 0) / mtow;

  /* ---------- stability & trim ---------- */
  const xnp = aero.xnp, hnp = (xnp - W.xMacLE) / W.mac;
  const xTarget = xnp - p.staticMargin / 100 * W.mac;
  const smActual = (xnp - xcg) / W.mac * 100;
  const battAbsNeeded = (xTarget * mtow - (xcg * mtow - battMass * (L.xw + p.battX))) / battMass;
  const battXNeeded = battAbsNeeded - L.xw;
  note("Balance", `Neutral point ${fmtN(xnp - L.xw)} mm behind the wing root LE (VLM). A ${p.staticMargin}% margin puts the CG at ${fmtN(xTarget - L.xw)} mm.`);

  /* ---------- parasite drag areas (mm²) ---------- */
  const parasite = [];
  const fpush = (name, f) => { if (f > 0) parasite.push({name, f}); };
  const ReL = (V, len) => rho * V * len / 1000 / MU_AIR;
  const parasiteAt = V => {
    let f = 0;
    if (L.hasFuse) { const fr = L.fuse.L / Math.max(p.fuseW, p.fuseH); f += cfFlat(ReL(V, L.fuse.L)) * (1 + 60 / fr ** 3 + fr / 400) * fuseWet; }
    for (const nc of L.nacelles) f += 2 * cfFlat(ReL(V, nc.x1 - nc.x0)) * 1.3 * 2 * Math.PI * nc.r * (nc.x1 - nc.x0) * 0.85;
    for (const b of L.booms) { const len = Math.hypot(b.b[0] - b.a[0], b.b[2] - b.a[2]); f += (b.mirrored ? 2 : 1) * (cfFlat(ReL(V, len)) * 1.1 * Math.PI * b.tube[0] * len + 0.1 * b.tube[0] ** 2); }
    for (const s of L.surfaces.filter(s => s.kind === "fin").concat(L.tipFins)) {
      const k = s.mirrored || L.tipFins.includes(s) ? 2 : 1;
      for (let i = 0; i < s.st.length - 1; i++) { const a = s.st[i], b = s.st[i + 1], c = (a.c + b.c) / 2; f += k * 2 * cfFlat(ReL(V, c)) * (1 + 2 * a.fA.t) * c * Math.hypot(b.y - a.y, b.z - a.z) * 1.1; }
    }
    return f;
  };
  let fixedF = deckF;
  if (p.pod) fixedF += 0.004 * podWet + 0.03 * Math.PI * (p.podD / 2) ** 2;
  if (p.gpsMast) fixedF += 1.0 * 8 * p.mastH;
  if (L.hasFuse && p.noseMode === "replaceable") fixedF += 0.15 * (+p.camSize) ** 2;
  for (const mo of L.motors) if (mo.mount === "pylon") fixedF += 0.3 * 10 * (mo.pos[2] - mo.pylonBase);
  if (p.vtol === "quad") fixedF += 4 * (0.3 * 0.08 * (p.liftPropD * IN) ** 2 + 0.8 * lm.can * 18);
  if (p.vtol === "tilttri") fixedF += 0.3 * 0.08 * (p.propD * IN) ** 2 + 0.8 * mm.can * 18;
  fixedF += 0.0012 * W.S;
  if (fixedF) fpush("Mounts, pods, antennas, gaps", fixedF);

  /* ---------- performance core (depends on mass) ---------- */
  const usableJ = pk.Wh * 3600 * pk.ch.usable * (1 - p.reserve / 100);
  function perf(massG, grid) {
    const Wt = massG / 1000 * G0;
    // stall with Reynolds iteration
    let Vs = 10, st;
    for (let i = 0; i < 4; i++) { st = stallFor(aero, rho, Vs); Vs = Math.sqrt(2 * Wt / (rho * W.S * 1e-6 * Math.max(0.2, st.CL))); }
    const CLmax = Math.max(0.2, st.CL);
    const static1 = fullThrottle(mm, p.propD, p.propP, rho, 0, pk, nCruise);
    const pts = [];
    const vmin = Vs * 1.15, vtop = 70;
    const speeds = grid || (() => { const a = []; for (let v = vmin; v <= vtop; v += 0.5) a.push(v); return a; })();
    let Vmax = 0;
    for (const V of speeds) {
      const q = 0.5 * rho * V * V, CL = Wt / (q * W.S * 1e-6);
      const {alpha, cdi} = aeroAtCL(aero, CL);
      const cdp = profileCD(aero, rho, V, alpha);
      const CD = p.kDrag * (cdp + cdi + parasiteAt(V) * 1.08 / W.S + fixedF / W.S);
      const D = q * W.S * 1e-6 * CD;
      const ft = fullThrottle(mm, p.propD, p.propP, rho, V, pk, nCruise);
      const op = forThrust(mm, p.propD, p.propP, rho, V, D / nCruise, pk, nCruise);
      const row = {V, CL, CD, cdp, cdi, LD: CL / CD, D, Tfull: ft.T * nCruise, alpha};
      if (op) Object.assign(row, {Pb: op.Pb * p.kPower, Ib: op.Ib * p.kPower, throttle: op.throttle, rpm: op.rpm, etaProp: op.etaProp, etaMotor: op.etaMotor});
      if (ft.T * nCruise >= D) Vmax = V;
      pts.push(row);
      if (!grid && V > Vs * 2 && ft.T * nCruise < D * 0.7) break;
    }
    const flyable = pts.filter(r => r.Pb && r.V >= Vs * 1.2);
    const loiter = flyable.reduce((b, r) => (!b || r.Pb < b.Pb ? r : b), null);
    const minC = opts.minCruise || 0;
    const cruise = flyable.filter(r => r.V >= Math.max(minC, Vs * 1.3)).reduce((b, r) => (!b || r.Pb / r.V < b.Pb / b.V ? r : b), null);
    const bestLD = pts.filter(r => r.V >= Vs * 1.2).reduce((b, r) => (!b || r.LD > b.LD ? r : b), null);
    // hover
    let hover = null, hoverJ = 0;
    if (nLift) {
      const pkH = pk, mH = liftMotor, dH = liftD, pH = liftP;
      const hs = forThrust(mH, dH, pH, rho, 0, Wt / nLift, pkH, nLift);
      const hf = fullThrottle(mH, dH, pH, rho, 0, pkH, nLift);
      hover = {op: hs, TW: hf.T * nLift / Wt, Ifull: hf.I, Ibfull: hf.Ib};
      if (hs) hoverJ = hs.Pb * p.hoverTime;
    }
    const E = Math.max(0, usableJ - hoverJ);
    const endurance = loiter ? E / loiter.Pb / 60 : 0;
    const range = cruise ? E / cruise.Pb * cruise.V / 1000 : 0;
    const roc = loiter ? (fullThrottle(mm, p.propD, p.propP, rho, loiter.V, pk, nCruise).T * nCruise - loiter.D) * loiter.V / Wt : 0;
    return {Vs, CLmax, stallY: st.y, stallAlpha: st.alpha, static1, TW: static1.T * nCruise / Wt, pts, loiter, cruise, bestLD, Vmax, endurance, range, roc, hover, hoverJ, Wt};
  }
  const grid = opts.res === "coarse" ? (() => { const a = []; const vs = Math.sqrt(2 * Wn / (rho * W.S * 1e-6 * 1.0)); for (let v = vs * 1.2; v < vs * 4.5; v *= 1.12) a.push(v); return a; })() : null;
  const perfNow = perf(mtow, grid);
  const {Vs, cruise, loiter} = perfNow;

  /* trim */
  const xcgTrim = opts.assumeBalanced ? xTarget : xcg, hcg = xcgTrim / W.mac;
  let trim = {};
  const CLc = cruise ? cruise.CL : 0.4;
  if (!L.tailless && Math.abs(aero.Cmt) > 1e-6) {
    // [CLa CLt][a ]   [CLc - CL0]
    // [Cma+h CLa  Cmt+h CLt][it] = [-(Cm0 + h CL0)]
    const a11 = aero.CLa, a12 = aero.CLt, a21 = aero.Cma + hcg * aero.CLa, a22 = aero.Cmt + hcg * aero.CLt;
    const b1 = CLc - aero.CL0, b2 = -(aero.Cm0 + hcg * aero.CL0), det = a11 * a22 - a12 * a21;
    trim = {it: (a11 * b2 - a21 * b1) / det / D2R, alpha: (b1 * a22 - a12 * b2) / det / D2R, tailed: true};
  } else {
    const a = -(aero.Cm0 + hcg * aero.CL0) / (aero.Cma + hcg * aero.CLa);
    const CLt = aero.CL0 + aero.CLa * a;
    const Vt = CLt > 0.02 ? Math.sqrt(2 * Wn / (rho * W.S * 1e-6 * CLt)) : Infinity;
    const ac = (CLc - aero.CL0) / aero.CLa, CmC = aero.Cm0 + aero.Cma * ac + hcg * (aero.CL0 + aero.CLa * ac);
    const yE = 0.6 * W.half, wE = W.wingAt(yE), armE = (wE.x + 0.88 * wE.c - xcgTrim) / W.mac;
    const dCmdDelta = -0.45 * aero.CLa * 0.55 * Math.max(0.05, armE) * D2R;
    trim = {tailed: false, CL: CLt, V: Vt, elevon: -CmC / dCmdDelta};
  }

  /* ---------- maximum takeoff weight & payload–range ---------- */
  const stallLim = 0.5 * rho * p.maxStall ** 2 * W.S * 1e-6 * perfNow.CLmax / G0 * 1000;
  const thrustLim = nLift ? (perfNow.hover ? perfNow.hover.TW * mtow / 1.4 : 0) : perfNow.TW * mtow / p.minTW;
  const sparLim = Math.min(...tubes.map((t, i) => tubeZ(t.tube) * CARBON_ALLOW / ((p.spar2Pos > 0 ? [0.72, 0.28][i] : 1) * p.loadFactor * G0 * aero.rootMomentPerLift) * 1000));
  const limits = [
    ["Launch stall speed " + p.maxStall + " m/s", stallLim],
    [nLift ? "Hover thrust margin 1.4" : "Launch thrust-to-weight " + p.minTW, thrustLim],
    ["Spar strength at " + p.loadFactor + " g", sparLim],
  ].sort((a, b) => a[1] - b[1]);
  const MTOW = limits[0][1];
  const emptyNoPayload = mtow - p.payload;
  const maxPayload = Math.max(0, MTOW - emptyNoPayload);
  const payloadRange = [];
  if (opts.res !== "coarse") {
    const n = 7, top = Math.max(maxPayload, p.payload);
    for (let i = 0; i <= n; i++) {
      const pl = top * i / n, pr = perf(emptyNoPayload + pl, (() => { const a = []; for (let v = perfNow.Vs * 1.2; v < Math.max(perfNow.Vmax, perfNow.Vs * 2); v += 1) a.push(v); return a; })());
      payloadRange.push({payload: pl, range: pr.range, endurance: pr.endurance, over: pl > maxPayload + 1});
    }
  }

  /* ---------- electrical summary ---------- */
  const st1 = perfNow.static1;
  const cRate = st1.Ib / (p.capacity / 1000);

  /* ---------- checks ---------- */
  const warn = [];
  const chk = (lvl, msg) => warn.push([lvl, msg]);
  tubes.forEach((t, i) => {
    const nm = i ? "Rear spar" : "Main spar";
    if (t.manual && !t.fits) chk("bad", `${nm}: the ${tubeLabel(t.tube)} plus clearance and 1.2 mm walls needs ${fmtN(t.tube[0] + 2 * p.fitClear + 2.4, 1)} mm but the wing is only ${fmtN(t.depth, 1)} mm deep there.`);
    else if (t.manual && !t.strong) chk("bad", `${nm}: the ${tubeLabel(t.tube)} reaches ${fmtN(t.stress)} MPa at ${p.loadFactor} g, above the ${fmtN(CARBON_ALLOW)} MPa allowable.`);
    else if (!t.ok) chk("bad", `${nm}: no carbon tube both carries the ${p.loadFactor} g root moment and fits the ${fmtN(t.depth, 1)} mm depth. Use a thicker root section, a second spar or a lower load factor.`);
  });
  const bedDiag = Math.hypot(p.bedX, p.bedY) - 12;
  const maxChord = Math.max(...wingSt.map(w => w.c));
  if (maxChord > bedDiag) chk("bad", `The largest wing chord (${fmtN(maxChord)} mm) is longer than the bed diagonal (${fmtN(bedDiag)} mm).`);
  if (L.hasFuse && Math.max(p.fuseW, p.fuseH) > Math.min(p.bedX, p.bedY) - 10) chk("bad", "The fuselage cross-section is wider than the printer bed.");
  if (perfNow.Vs > p.maxStall) chk("warn", `Stall speed ${fmtN(Vs, 1)} m/s is above the ${p.maxStall} m/s launch limit.`);
  if (st1.I > mm.imax * 1.05) chk("bad", `Full-throttle motor current ${fmtN(st1.I, 1)} A exceeds the ${mm.imax} A rating. Use a smaller prop, fewer cells or a bigger motor.`);
  if (p.cells > mm.maxCells) chk("warn", `${p.cells}S is above the ${mm.maxCells}S the ${mm.name} motor class usually tolerates.`);
  if (cRate > pk.ch.maxC) chk("bad", `Peak discharge ${fmtN(cRate, 1)}C is above the ~${pk.ch.maxC}C a ${pk.ch.name} pack delivers.`);
  if (st1.tipMach > 0.6) chk("warn", `Propeller tip speed reaches Mach ${fmtN(st1.tipMach, 2)}; expect noise and lost efficiency.`);
  if (!nLift && perfNow.TW < p.minTW) chk("warn", `Static thrust-to-weight ${fmtN(perfNow.TW, 2)} is below the ${p.minTW} launch target.`);
  if (nLift && perfNow.hover && perfNow.hover.TW < 1.4) chk("bad", `Hover thrust-to-weight ${fmtN(perfNow.hover.TW, 2)} is below the 1.4 needed for VTOL control authority.`);
  if (nLift && perfNow.hover && !perfNow.hover.op) chk("bad", "The lift system cannot hover this aircraft.");
  if (nLift && perfNow.hover && perfNow.hover.Ifull > liftMotor.imax * 1.05) chk("warn", `Lift motors draw ${fmtN(perfNow.hover.Ifull, 1)} A at full throttle, above their ${liftMotor.imax} A rating.`);
  if (!cruise) chk("bad", "The powertrain cannot sustain level flight above 1.3 × stall speed.");
  if (opts.assumeBalanced) { /* optimizer places the battery afterwards */ }
  else if (smActual < 2) chk("bad", `With the current battery position the static margin is ${fmtN(smActual, 1)}% — the aircraft is unstable. Move the battery to ${fmtN(battXNeeded)} mm.`);
  else if (Math.abs(smActual - p.staticMargin) > 4) chk("warn", `Static margin is ${fmtN(smActual, 1)}% (target ${p.staticMargin}%). Move the battery to ${fmtN(battXNeeded)} mm from the wing LE.`);
  if (L.tailless) {
    if (!(trim.CL > 0.05)) chk("bad", "The wing does not trim at positive lift with neutral elevons. Add reflex, washout or sweep, or reduce the static margin.");
    else if (cruise && Math.abs(trim.elevon) > 4) chk("warn", `Cruise needs about ${fmtN(Math.abs(trim.elevon), 1)}° of elevon ${trim.elevon < 0 ? "up" : "down"} trim; tune washout or airfoil reflex to reduce trim drag.`);
  } else if (Math.abs(trim.it) > 5) chk("warn", `Cruise trim needs ${fmtN(trim.it, 1)}° of stabilizer incidence; check tail volume and CG.`);
  if (p.wingType !== "delta" && perfNow.stallY > 0.65 * W.half) chk("warn", `Stall starts at ${fmtN(perfNow.stallY / W.half * 100)}% of the half span (tip stall). Add washout or reduce taper.`);
  if (cruise && rho * cruise.V * W.mac / 1000 / MU_AIR < 8e4) chk("warn", `Cruise Reynolds number is ${fmtN(rho * cruise.V * W.mac / 1000 / MU_AIR / 1000)}k; laminar bubbles hurt below ~80k.`);
  for (const mo of L.motors) if (mo.mount === "pylon" && mo.pos[2] - mo.pylonBase > 135) chk("warn", `The pusher pylon is ${fmtN(mo.pos[2] - mo.pylonBase)} mm tall to clear the boom; consider twin booms or a smaller prop.`);
  if (L.hasFuse && p.noseMode === "replaceable" && p.motorLayout === "tractor") chk("warn", "A nose tractor blocks the FPV camera window; the camera cradle moves behind the firewall. Mount the camera on the deck instead.");
  if (!warn.length) chk("ok", "No issues found: structure, printing, stall, balance and power checks all pass.");

  /* ---------- design log (engineering rules applied) ---------- */
  tubes.forEach((t, i) => note("Structure", `${i ? "Rear" : "Main"} spar ${t.tube[0]}×${t.tube[1]} mm: root moment ${fmtN(M_root / 1000 * (tubes.length > 1 ? [0.72, 0.28][i] : 1), 1)} N·m at ${p.loadFactor} g gives ${fmtN(t.stress)} MPa vs ${fmtN(CARBON_ALLOW)} MPa allowable; tube + 2.4 mm walls fits the ${fmtN(t.depth, 1)} mm depth.`));
  note("Propulsion", `${nCruise} × ${mm.name} on ${p.cells}S with ${p.propD}×${p.propP}" props: ${fmtN(st1.T * nCruise / G0 * 1000)} g static thrust, ${fmtN(st1.Ib, 1)} A from the pack.`);
  if (cruise) note("Performance", `Best-range speed ${fmtN(cruise.V, 1)} m/s minimizes battery power per metre (${fmtN(cruise.Pb, 1)} W); loiter ${fmtN(loiter.V, 1)} m/s minimizes power.`);
  note("Aerodynamics", `VLM (${aero.N} panels per half): CLα ${fmtN(aero.CLa, 2)}/rad, span efficiency ${fmtN(aero.e, 2)}, stall begins at ${fmtN(perfNow.stallY / W.half * 100)}% half-span.`);

  return {p, L, aero, rho, items, mtow, Wn, xcg, xnp, hnp, xTarget, smActual, battXNeeded, battMass, pk, perf: perfNow, trim,
    tubes, M_root, MTOW, limits, maxPayload, payloadRange, cRate, nLift, liftMotor, parasiteAt, fixedF,
    printMass: items.filter(i => i.group === "structure" && !/spar|boom/i.test(i.name)).reduce((s, i) => s + i.mass, 0),
    warn, log: L.log, motor: mm};
}
