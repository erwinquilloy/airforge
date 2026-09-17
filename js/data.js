"use strict";
/* ==========================================================================
   Airframe Forge — data tables, parameter schema and configuration templates
   Units: mm, g, degrees, m/s unless noted.
   ========================================================================== */

const MATERIALS = {
  lwpla: {name: "LW-PLA (foamed)", rho: 0.62, filRho: 1.24, flow: 7, note: "Foamed at ~230 °C, 45–55% flow. Single wall for skins."},
  lwasa: {name: "LW-ASA (foamed)", rho: 0.65, filRho: 1.07, flow: 7, note: "Heat resistant foamed skin; enclosure recommended."},
  pla:   {name: "PLA",             rho: 1.24, filRho: 1.24, flow: 10, note: "Stiff but heavy and softens in hot cars."},
  petg:  {name: "PETG",            rho: 1.27, filRho: 1.27, flow: 9, note: "Tough; good for mounts, noses and landing parts."},
  asa:   {name: "ASA",             rho: 1.07, filRho: 1.07, flow: 9, note: "UV and heat resistant mounts and pods."},
};

const CHEM = {
  lipo:  {name: "LiPo",         v: 3.7, whkg: 150, usable: 0.80, maxC: 30, rRef: 0.012},
  liion: {name: "Li-ion 21700", v: 3.6, whkg: 220, usable: 0.85, maxC: 4,  rRef: 0.060},
};

/* Carbon tubes (OD, ID mm) */
const TUBES = [[4, 2], [5, 3], [6, 4], [8, 6], [10, 8], [12, 10], [14, 12], [16, 14], [20, 18], [25, 23]];
const RODS = [[2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [8, 0]];
const tubeLabel = t => t[1] ? `${t[0]} × ${t[1]} mm tube` : `${t[0]} mm rod`;
const tubeKey = t => t[1] ? `t${t[0]}x${t[1]}` : `r${t[0]}`;
const SPAR_OPTIONS = [["auto", "Auto (sized for load)"]].concat(TUBES.map(t => [tubeKey(t), tubeLabel(t)]), RODS.slice(2).map(t => [tubeKey(t), tubeLabel(t)]));
const tubeFromKey = k => { const m = /^t(d+)x(d+)$/.exec(k) || /^r(d+)$/.exec(k); return m ? [+m[1], m[2] ? +m[2] : 0] : null; };
/* parse "240, 480" into sorted positive numbers */
const parseCuts = str => String(str || "").split(/[,;s]+/).map(Number).filter(v => isFinite(v) && v > 0).sort((a, b) => a - b);
const CARBON_RHO = 1.55e-3, CARBON_ALLOW = 600 / 1.5;               // g/mm³, N/mm² incl. 1.5 safety factor
const tubeMassPerM = t => Math.PI / 4 * (t[0] ** 2 - t[1] ** 2) * 1000 * CARBON_RHO;
const tubeZ = t => Math.PI * (t[0] ** 4 - t[1] ** 4) / (32 * t[0]);

/* Motor mount hole patterns used by hobby brushless motors.
   square: holes on the corners of an s×s square; cross: two diametric pairs at d1 and d2;
   combo: two squares rotated 45° apart; slots: radial slots covering r0..r1. */
const MOUNT_PATTERNS = {
  sq9:   {name: "9 × 9 mm (M2) — 11xx micro", type: "square", s: [9], screw: 2.2, center: 5},
  sq12:  {name: "12 × 12 mm (M2) — 13xx–18xx", type: "square", s: [12], screw: 2.2, center: 6},
  sq16:  {name: "16 × 16 mm (M3) — 22xx–23xx", type: "square", s: [16], screw: 3.2, center: 8},
  sq19:  {name: "19 × 19 mm (M3) — 27xx–28xx", type: "square", s: [19], screw: 3.2, center: 9},
  sq25:  {name: "25 × 25 mm (M3) — 35xx–41xx", type: "square", s: [25], screw: 3.2, center: 12},
  sq30:  {name: "30 × 30 mm (M3) — 50xx", type: "square", s: [30], screw: 3.2, center: 14},
  x16_19: {name: "16 / 19 mm cross (M3) — 22xx fixed wing", type: "cross", d: [16, 19], screw: 3.2, center: 8},
  x19_25: {name: "19 / 25 mm cross (M3) — 28xx fixed wing", type: "cross", d: [19, 25], screw: 3.2, center: 10},
  combo16_19: {name: "16 × 16 + 19 × 19 mm combined (M3)", type: "combo", s: [16, 19], screw: 3.2, center: 8},
  universal: {name: "Universal slots 16–25 mm (M3)", type: "slots", r: [7.6, 18.2], screw: 3.2, center: 9},
};
/* Generic brushless motor classes. Values are typical for the class, not a specific
   product — enter your motor's datasheet numbers with "Custom motor". */
const MOTORS = [
  // id, name, Kv, Rm Ω, Io A, mass g, max A, max cells, can Ø mm, typical mount
  ["m1804", "1804 · 2400 Kv", 2400, 0.150, 0.40, 20, 10, 3, 23, "sq12"],
  ["m2204", "2204 · 2300 Kv", 2300, 0.090, 0.60, 26, 18, 4, 28, "sq16"],
  ["m2208", "2208 · 1500 Kv", 1500, 0.100, 0.50, 40, 18, 4, 28, "x16_19"],
  ["m2212", "2212 · 1000 Kv", 1000, 0.120, 0.50, 56, 20, 4, 28, "x16_19"],
  ["m2216", "2216 · 880 Kv",   880, 0.105, 0.50, 70, 25, 4, 28, "x16_19"],
  ["m2814", "2814 · 700 Kv",   700, 0.070, 0.90, 110, 35, 5, 35, "x19_25"],
  ["m2820", "2820 · 920 Kv",   920, 0.035, 1.20, 125, 45, 4, 35, "x19_25"],
  ["m3508", "3508 · 580 Kv",   580, 0.080, 0.60, 88, 30, 6, 41, "sq25"],
  ["m3515", "3515 · 400 Kv",   400, 0.090, 0.40, 150, 30, 6, 42, "sq25"],
  ["m4114", "4114 · 320 Kv",   320, 0.120, 0.30, 190, 25, 6, 46, "sq25"],
  ["m5010", "5010 · 360 Kv",   360, 0.080, 0.60, 180, 35, 6, 56, "sq30"],
].map(([id, name, kv, rm, io, mass, imax, maxCells, can, mountId]) => ({id, name, kv, rm, io, mass, imax, maxCells, can, mountId}));
/* Servo classes: body length (spanwise) × thickness × height, mass */
const SERVOS = {
  ds041: {name: "GDW DS041MG class — 24 × 11.9 × 21.9 mm, 12 g", L: 24, W: 11.9, H: 21.9, mass: 12},
  micro9: {name: "9 g micro (SG90 / ES08 size) — 23 × 12.2 × 22.5 mm", L: 23, W: 12.2, H: 22.5, mass: 9},
  slim: {name: "Slim wing servo — 23 × 8 × 17 mm, 7 g", L: 23, W: 8, H: 17, mass: 7},
  custom: {name: "Custom size…"},
};
const HINGE_PINS = {f175: {name: "1.75 mm filament", d: 1.75}, w12: {name: "1.2 mm steel wire", d: 1.2}, r2: {name: "2 mm carbon rod", d: 2}, tape: {name: "Tape hinge (no pin holes)", d: 0}};
const MOUNT_OPTIONS = [["auto", "Typical for the motor class"]].concat(Object.entries(MOUNT_PATTERNS).map(([k, v]) => [k, v.name]));
const PROPS = [[5, 3], [5, 4.5], [6, 4], [7, 4], [8, 4.5], [8, 6], [9, 4.5], [9, 6], [10, 5], [10, 7], [11, 5.5], [11, 7], [12, 6], [13, 6.5], [14, 7], [15, 5], [16, 5.5], [18, 6.1]];

/* ---------------------------------------------------------------------------
   Parameter schema. Each field: id, label, unit, min, max, step, default,
   tab, group, optional show(p) predicate and hint.
   --------------------------------------------------------------------------- */
const isTailless = p => p.tailType === "none" || p.tailType === "fin";
const hasFuse = p => p.fuseType !== "none";
const F = (tab, group, id, label, unit, min, max, step, def, show, hint) => ({kind: "num", tab, group, id, label, unit, min, max, step, def, show, hint});
const SEL = (tab, group, id, label, options, def, show, hint) => ({kind: "sel", tab, group, id, label, options, def, show, hint});
const T = (tab, group, id, label, def, show, hint) => ({kind: "bool", tab, group, id, label, def, show, hint});

const SCHEMA = [
  // ---- configuration
  SEL("air", "cfg", "wingType", "Wing type", [["tapered", "Tapered / swept"], ["delta", "Delta"]], "tapered"),
  SEL("air", "cfg", "tailType", "Tail", [["conv", "Conventional"], ["ttail", "T-tail"], ["vtail", "V-tail"], ["twinboom", "Twin boom, H-tail"], ["fin", "Center fin only (tailless)"], ["none", "None (flying wing)"]], "conv"),
  SEL("air", "cfg", "fuseType", "Fuselage", [["podboom", "Pod and printed boom"], ["full", "Full fuselage"], ["pod", "Short pod"], ["none", "None"]], "podboom"),
  SEL("air", "cfg", "motorLayout", "Motor layout", [["tractor", "Nose tractor"], ["pusher", "Pusher"], ["twin", "Twin wing tractors"], ["twinpusher", "Twin wing pushers"]], "pusher"),
  // ---- wing
  F("air", "wing", "span", "Wingspan", "mm", 400, 3500, 10, 1600),
  F("air", "wing", "rootChord", "Root chord", "mm", 80, 800, 1, 240, null, "For a blended wing body this is the outer wing root."),
  F("air", "wing", "taper", "Taper ratio (tip ÷ root)", "", 0.05, 1.2, 0.01, 0.6),
  F("air", "wing", "sweep", "Leading-edge sweep", "°", -30, 55, 0.5, 2, p => p.wingType !== "delta", "Negative values sweep the wing forward."),
  F("air", "wing", "teSweep", "Trailing-edge sweep", "°", -20, 30, 0.5, 0, p => p.wingType === "delta", "0° gives a straight trailing edge; leading-edge sweep follows from span and chords."),
  F("air", "wing", "dihedral", "Dihedral (per side)", "°", -6, 12, 0.5, 3),
  F("air", "wing", "washout", "Tip twist (+ = washout)", "°", -4, 8, 0.1, 1.5),
  T("air", "wing", "wingBlend", "Blend wing into fuselage", false, hasFuse, "Chord and thickness grow smoothly toward the fuselage side, removing the sharp wing–body corner."),
  F("air", "wing", "blendSpan", "Blend length (from fuselage side)", "mm", 10, 300, 1, 70, p => hasFuse(p) && p.wingBlend),
  F("air", "wing", "blendChord", "Chord growth at the fuselage", "×", 1, 2.2, 0.01, 1.35, p => hasFuse(p) && p.wingBlend),
  F("air", "wing", "blendThick", "Thickness growth at the fuselage", "×", 1, 3, 0.05, 1.8, p => hasFuse(p) && p.wingBlend),
  T("air", "wing", "tipFins", "Tip fins / winglets", true, p => p.tailType === "none"),
  F("air", "wing", "tipFinH", "Tip fin height", "mm", 30, 300, 5, 110, p => p.tailType === "none" && p.tipFins),
  // ---- tail
  F("air", "tail", "hVol", "Horizontal tail volume", "", 0.25, 1, 0.01, 0.5, p => !isTailless(p)),
  F("air", "tail", "vVol", "Vertical tail volume", "", 0.012, 0.09, 0.001, 0.035, p => p.tailType !== "none"),
  F("air", "tail", "tailArm", "Tail arm (÷ wingspan)", "", 0.25, 0.9, 0.01, 0.52, p => !isTailless(p)),
  F("air", "tail", "hAR", "Stabilizer aspect ratio", "", 2, 8, 0.1, 4.5, p => !isTailless(p)),
  F("air", "tail", "vAR", "Fin aspect ratio", "", 0.6, 3, 0.1, 1.5, p => p.tailType !== "vtail" && p.tailType !== "none"),
  F("air", "tail", "boomSpacing", "Boom spacing (÷ wingspan)", "", 0.12, 0.6, 0.01, 0.3, p => p.tailType === "twinboom"),
  // ---- fuselage & FPV nose
  F("air", "fuse", "noseLen", "Nose ahead of wing", "mm", 40, 900, 5, 300, hasFuse),
  F("air", "fuse", "podLen", "Pod length", "mm", 120, 1200, 5, 420, p => p.fuseType === "pod"),
  F("air", "fuse", "fuseW", "Max width", "mm", 30, 260, 1, 78, hasFuse),
  F("air", "fuse", "fuseH", "Max height", "mm", 30, 260, 1, 88, hasFuse),
  F("air", "fuse", "boomD", "Tail cone end diameter", "mm", 12, 90, 1, 24, p => p.fuseType === "podboom" || p.fuseType === "full"),
  F("air", "fuse", "fuseWall", "Shell wall", "mm", 0.6, 3, 0.05, 1.2, hasFuse),
  SEL("air", "fuse", "noseMode", "Nose", [["fixed", "Integrated"], ["replaceable", "Replaceable FPV nose"]], "replaceable", hasFuse),
  F("air", "fuse", "noseSplit", "Nose part length", "mm", 30, 300, 1, 110, p => hasFuse(p) && p.noseMode === "replaceable"),
  SEL("air", "fuse", "camSize", "FPV camera", [["14", "Nano 14 mm"], ["19", "Micro 19 mm"], ["22", "Full size 22 mm"]], "19", p => hasFuse(p) && p.noseMode === "replaceable"),
  F("air", "fuse", "camTilt", "Camera uptilt", "°", 0, 45, 1, 10, p => hasFuse(p) && p.noseMode === "replaceable"),
  SEL("air", "fuse", "noseAttach", "Nose attachment", [["screws", "4 × M3 into a glued insert ring"], ["spigot", "Slip-fit spigot"]], "screws", p => hasFuse(p) && p.noseMode === "replaceable"),
  // ---- hatches
  T("air", "hatch", "hatchBatt", "Battery hatch", true, hasFuse, "Cut from the fuselage shell: hooks under the rim at the front, latches at the rear."),
  T("air", "hatch", "hatchBattAuto", "Center over the battery", true, p => hasFuse(p) && p.hatchBatt),
  F("air", "hatch", "hatchBattX", "Battery hatch start (from nose)", "mm", 10, 1500, 1, 180, p => hasFuse(p) && p.hatchBatt && !p.hatchBattAuto, "Or drag the hatch in the 3D view."),
  F("air", "hatch", "hatchBattLen", "Battery hatch length", "mm", 40, 400, 1, 150, p => hasFuse(p) && p.hatchBatt),
  F("air", "hatch", "hatchBattW", "Battery hatch width", "mm", 20, 200, 1, 52, p => hasFuse(p) && p.hatchBatt),
  T("air", "hatch", "hatchAv", "Avionics hatch", false, hasFuse),
  F("air", "hatch", "hatchAvX", "Avionics hatch start (from nose)", "mm", 10, 1500, 1, 360, p => hasFuse(p) && p.hatchAv, "Or drag the hatch in the 3D view."),
  F("air", "hatch", "hatchAvLen", "Avionics hatch length", "mm", 30, 300, 1, 90, p => hasFuse(p) && p.hatchAv),
  F("air", "hatch", "hatchAvW", "Avionics hatch width", "mm", 20, 200, 1, 44, p => hasFuse(p) && p.hatchAv),
  SEL("air", "hatch", "hatchLatch", "Rear latch", [["magnets", "Magnets (6 × 3 mm)"], ["screws", "M3 screws into inserts"]], "magnets", p => hasFuse(p) && (p.hatchBatt || p.hatchAv || p.deck)),
  F("air", "hatch", "magnetD", "Magnet hole Ø", "mm", 3, 12, 0.05, 6.2, p => hasFuse(p) && (p.hatchBatt || p.hatchAv || p.deck) && p.hatchLatch === "magnets"),
  // ---- mounts & bays
  T("air", "mounts", "deck", "FPV canopy & avionics bay", false, null, "A swappable streamlined canopy over a top opening, with an FC shelf glued inside the bay."),
  SEL("air", "mounts", "canopyStyle", "Canopy", [["blank", "Blank fairing (FC, VTX, receiver)"], ["camera", "Camera canopy (open front, cradle)"], ["gps", "GPS canopy (pad on top)"]], "blank", p => p.deck),
  F("air", "mounts", "deckX", "Canopy position (from wing LE)", "mm", -800, 400, 1, -60, p => p.deck, "Or drag the canopy marker in the 3D view."),
  F("air", "mounts", "deckLen", "Bay opening length", "mm", 60, 350, 1, 150, p => p.deck),
  F("air", "mounts", "deckW", "Bay opening width", "mm", 24, 150, 1, 46, p => p.deck),
  F("air", "mounts", "canopyH", "Canopy height", "mm", 8, 80, 1, 26, p => p.deck),
  T("air", "mounts", "fcShelf", "FC shelf inside the bay", true, p => p.deck),
  SEL("air", "mounts", "deckPattern", "FC shelf stack pattern", [["20", "20 × 20 mm stack"], ["30.5", "30.5 × 30.5 mm stack"]], "30.5", p => p.deck && p.fcShelf),
  F("air", "mounts", "fcShelfDepth", "FC shelf depth below the rim", "mm", 6, 80, 1, 20, p => p.deck && p.fcShelf),
  T("air", "mounts", "pod", "Underslung pod", false, null, "Gimbal, mapping camera or payload release below the aircraft."),
  F("air", "mounts", "podL", "Pod length", "mm", 60, 400, 5, 160, p => p.pod),
  F("air", "mounts", "podD", "Pod diameter", "mm", 30, 160, 1, 62, p => p.pod),
  F("air", "mounts", "podX", "Pod position (from wing LE)", "mm", -500, 400, 5, -40, p => p.pod),
  T("air", "mounts", "gpsMast", "GPS mast", false),
  F("air", "mounts", "mastH", "Mast height", "mm", 30, 200, 5, 70, p => p.gpsMast),
  F("air", "mounts", "motorSpan", "Twin motor position (÷ half span)", "", 0.15, 0.7, 0.01, 0.3, p => p.motorLayout === "twin" || p.motorLayout === "twinpusher"),
  // ---- VTOL
  SEL("air", "vtol", "vtol", "VTOL conversion", [["none", "None"], ["quad", "Quadplane kit — booms bolt under the wing"], ["tilttri", "Tilt-tricopter"], ["tailsitter", "Tailsitter"], ["vector", "Twin thrust vectoring"]], "none", null, "The quadplane kit screws to insert blocks in the wing, so the aircraft also flies without it."),
  F("air", "vtol", "vtolBoomY", "Lift boom position (÷ half span)", "", 0.15, 0.7, 0.01, 0.36, p => p.vtol === "quad"),
  F("air", "vtol", "hoverTime", "Hover time per flight", "s", 0, 600, 5, 90, p => p.vtol !== "none"),
  // ---- printing & structure
  SEL("air", "print", "material", "Material", Object.entries(MATERIALS).map(([k, v]) => [k, v.name]), "lwpla"),
  F("air", "print", "wall", "Skin wall thickness", "mm", 0.3, 2, 0.05, 0.5),
  F("air", "print", "infill", "Rib / infill allowance", "%", 0, 40, 1, 8),
  F("air", "print", "bedX", "Printer bed X", "mm", 100, 600, 1, 256),
  F("air", "print", "bedY", "Printer bed Y", "mm", 100, 600, 1, 256),
  F("air", "print", "bedZ", "Printer height Z", "mm", 100, 700, 1, 256),
  // ---- spars
  F("air", "spars", "sparPos", "Main spar position (÷ chord)", "", 0.12, 0.45, 0.01, 0.26),
  SEL("air", "spars", "spar1Size", "Main spar", SPAR_OPTIONS, "auto"),
  F("air", "spars", "spar2Pos", "Rear spar position (0 = none)", "", 0, 0.75, 0.01, 0),
  SEL("air", "spars", "spar2Size", "Rear spar", SPAR_OPTIONS, "auto", p => p.spar2Pos > 0),
  SEL("air", "spars", "stabSpar", "Stabilizer / fin rod", [["none", "None"], ["r2", "2 mm rod"], ["r3", "3 mm rod"], ["r4", "4 mm rod"], ["r5", "5 mm rod"]], "r3", p => !isTailless(p)),
  F("air", "spars", "fitClear", "Bore clearance (radial)", "mm", 0, 0.6, 0.05, 0.15, null, "Printed holes shrink; 0.1–0.2 mm gives a slip fit on most printers."),
  F("air", "spars", "loadFactor", "Design load factor", "g", 2, 14, 0.5, 6),
  // ---- control surfaces & servos
  T("air", "ctrl", "ctrlSurf", "Separate control surfaces", true, null, "Ailerons or elevons are exported as their own parts with a rounded, pinned hinge."),
  F("air", "ctrl", "hingePos", "Hinge line (÷ chord)", "", 0.55, 0.88, 0.01, 0.74, p => p.ctrlSurf),
  F("air", "ctrl", "csStart", "Surface start (÷ half span)", "", 0.05, 0.8, 0.01, 0.4, p => p.ctrlSurf),
  F("air", "ctrl", "csEnd", "Surface end (÷ half span)", "", 0.3, 0.98, 0.01, 0.92, p => p.ctrlSurf),
  F("air", "ctrl", "hingeGap", "Hinge gap", "mm", 0.3, 3, 0.1, 0.8, p => p.ctrlSurf),
  SEL("air", "ctrl", "hingePin", "Hinge", Object.entries(HINGE_PINS).map(([k, v]) => [k, v.name]), "f175", p => p.ctrlSurf),
  T("air", "ctrl", "tailCtrl", "Separate elevator / rudder", true, p => p.ctrlSurf && p.tailType !== "none"),
  SEL("air", "ctrl", "servoType", "Servo", Object.entries(SERVOS).map(([k, v]) => [k, v.name]), "ds041", p => p.ctrlSurf),
  F("air", "ctrl", "servoL", "Servo length", "mm", 10, 45, 0.1, 24, p => p.ctrlSurf && p.servoType === "custom"),
  F("air", "ctrl", "servoW", "Servo thickness", "mm", 5, 25, 0.1, 11.9, p => p.ctrlSurf && p.servoType === "custom"),
  F("air", "ctrl", "servoH", "Servo height", "mm", 8, 40, 0.1, 21.9, p => p.ctrlSurf && p.servoType === "custom"),
  F("air", "ctrl", "servoMass", "Servo mass", "g", 2, 60, 0.5, 12, p => p.ctrlSurf && p.servoType === "custom"),
  F("air", "ctrl", "servoPos", "Wing servo position along the surface", "", 0, 1, 0.01, 0.12, p => p.ctrlSurf, "0 = inboard end, 1 = outboard end. Or drag the servo marker on the right wing."),
  F("air", "ctrl", "servoGap", "Servo pocket ahead of the hinge", "mm", 1, 60, 0.5, 3, p => p.ctrlSurf),
  T("air", "ctrl", "hornAuto", "Horn in line with the servo", true, p => p.ctrlSurf),
  F("air", "ctrl", "hornPos", "Horn position along the surface", "", 0, 1, 0.01, 0.2, p => p.ctrlSurf && !p.hornAuto, "Or drag the horn marker."),
  SEL("air", "ctrl", "hornSide", "Wing horn side", [["bottom", "Bottom"], ["top", "Top"]], "bottom", p => p.ctrlSurf),
  F("air", "ctrl", "hornLen", "Horn arm length", "mm", 8, 35, 0.5, 13, p => p.ctrlSurf),
  F("air", "ctrl", "tailHornPos", "Tail horn position along the surface", "", 0, 1, 0.01, 0.1, p => p.ctrlSurf && p.tailCtrl && p.tailType !== "none"),
  SEL("air", "ctrl", "tailHornSide", "Tail horn side", [["bottom", "Bottom / left"], ["top", "Top / right"]], "bottom", p => p.ctrlSurf && p.tailCtrl && p.tailType !== "none"),
  SEL("air", "ctrl", "servoOrient", "Wing servo orientation", [["auto", "Auto (stand if the wing is thick enough)"], ["stand", "Standing"], ["flat", "Lying flat"]], "auto", p => p.ctrlSurf),
  // ---- cooling & battery
  T("air", "cool", "intake", "NACA intake duct", false, hasFuse, "Submerged intake: an opening in the shell plus a glue-in duct insert with a 7° ramp."),
  F("air", "cool", "intakeX", "Intake position (from nose)", "mm", 10, 1500, 1, 140, p => hasFuse(p) && p.intake, "Or drag the intake marker on the 3D fuselage."),
  F("air", "cool", "intakeAng", "Intake angle around fuselage", "°", -180, 180, 1, -90, p => hasFuse(p) && p.intake, "0° = right side, 90° = top, −90° = bottom."),
  T("air", "cool", "intakeMirror", "Mirror intake to the other side", false, p => hasFuse(p) && p.intake),
  F("air", "cool", "intakeW", "Intake throat width", "mm", 10, 60, 1, 22, p => hasFuse(p) && p.intake),
  F("air", "cool", "intakeL", "Duct length", "mm", 30, 160, 1, 70, p => hasFuse(p) && p.intake),
  T("air", "cool", "exhaust", "Exhaust ports", false, hasFuse),
  F("air", "cool", "exhaustX", "Exhaust position (from nose)", "mm", 10, 1500, 1, 380, p => hasFuse(p) && p.exhaust, "Or drag the exhaust marker on the 3D fuselage."),
  F("air", "cool", "exhaustAng", "Exhaust angle around fuselage", "°", -180, 180, 1, 90, p => hasFuse(p) && p.exhaust),
  T("air", "cool", "exhaustMirror", "Mirror exhaust to the other side", false, p => hasFuse(p) && p.exhaust),
  F("air", "cool", "exhaustArea", "Exhaust open area (× intake)", "×", 0.8, 3, 0.1, 1.4, p => hasFuse(p) && p.exhaust),
  T("air", "cool", "battTray", "Glue-in battery tray", true, hasFuse),
  F("air", "cool", "strapW", "Battery strap width", "mm", 8, 30, 1, 20, p => hasFuse(p) && p.battTray),
  SEL("air", "cool", "battDims", "Battery size", [["auto", "Estimate from cells and capacity"], ["manual", "Enter dimensions"]], "auto", p => hasFuse(p) && p.battTray),
  F("air", "cool", "battL", "Battery length", "mm", 20, 250, 1, 110, p => hasFuse(p) && p.battTray && p.battDims === "manual"),
  F("air", "cool", "battW", "Battery width", "mm", 15, 120, 1, 35, p => hasFuse(p) && p.battTray && p.battDims === "manual"),
  F("air", "cool", "battH", "Battery height", "mm", 8, 100, 1, 28, p => hasFuse(p) && p.battTray && p.battDims === "manual"),
  // ---- fasteners
  F("air", "fasten", "insertHole", "Heat-set insert hole Ø", "mm", 3, 5.5, 0.05, 4.0, null, "M3 inserts are screwed parts: firewall, deck, pod, servo covers and the VTOL kit."),
  F("air", "fasten", "insertDepth", "Insert hole depth", "mm", 3, 12, 0.1, 6.5),
  F("air", "fasten", "screwClear", "M3 clearance hole Ø", "mm", 3, 3.8, 0.05, 3.3),
  T("air", "fasten", "jigs", "Export gluing jigs", true, null, "Airfoil-cut plates on a common base keep wing panels at the right incidence and dihedral while the glue cures."),
  // ---- cuts & joiners
  SEL("air", "cuts", "cutMode", "Cut positions", [["auto", "Automatic (fit the printer)"], ["manual", "Manual"]], "auto"),
  {kind: "text", tab: "air", group: "cuts", id: "wingCuts", label: "Wing cuts (mm from root, each side)", def: "", show: p => p.cutMode === "manual", hint: "Comma separated, e.g. 240, 500. The wing always splits at the center."},
  {kind: "text", tab: "air", group: "cuts", id: "fuseCuts", label: "Fuselage cuts (mm from nose)", def: "", show: p => p.cutMode === "manual" && p.fuseType !== "none", hint: "The FPV nose split is set separately."},
  {kind: "text", tab: "air", group: "cuts", id: "tailCuts", label: "Tail cuts (mm from root)", def: "", show: p => p.cutMode === "manual" && p.tailType !== "none"},
  SEL("air", "cuts", "pinSize", "Joiner pins at wing & tail cuts", [["none", "None"], ["r2", "2 mm carbon rod"], ["r3", "3 mm carbon rod"], ["r4", "4 mm carbon rod"]], "r3"),
  F("air", "cuts", "pinDepth", "Pin depth each side", "mm", 8, 60, 1, 20, p => p.pinSize !== "none"),
  T("air", "cuts", "fuseSleeves", "Printed sleeves at fuselage cuts", true, p => p.fuseType !== "none"),
  F("air", "print", "minTE", "Min trailing-edge thickness", "mm", 0.3, 2, 0.05, 0.7),

  // ---- power
  SEL("pow", "motor", "motorId", "Cruise motor", () => MOTORS.map(m => [m.id, m.name]).concat([["custom", "Custom motor…"]]), "m2216"),
  F("pow", "motor", "cKv", "Kv", "rpm/V", 100, 4000, 10, 900, p => p.motorId === "custom"),
  F("pow", "motor", "cRm", "Winding resistance", "Ω", 0.005, 0.5, 0.001, 0.1, p => p.motorId === "custom"),
  F("pow", "motor", "cIo", "No-load current", "A", 0.1, 3, 0.05, 0.5, p => p.motorId === "custom"),
  F("pow", "motor", "cMass", "Motor mass", "g", 5, 500, 1, 70, p => p.motorId === "custom"),
  F("pow", "motor", "cImax", "Max continuous current", "A", 3, 100, 1, 25, p => p.motorId === "custom"),
  SEL("pow", "motor", "mountPattern", "Motor mount holes", MOUNT_OPTIONS, "auto", null, "Applied to the firewall, pylon and nacelle mounts."),
  F("pow", "motor", "propD", "Propeller diameter", "in", 4, 22, 0.5, 10),
  F("pow", "motor", "propP", "Propeller pitch", "in", 2, 14, 0.1, 6),
  F("pow", "batt", "cells", "Cells in series", "S", 1, 12, 1, 4),
  F("pow", "batt", "capacity", "Capacity", "mAh", 300, 40000, 50, 4000),
  SEL("pow", "batt", "chem", "Chemistry", Object.entries(CHEM).map(([k, v]) => [k, v.name]), "lipo"),
  F("pow", "batt", "reserve", "Landing reserve", "%", 0, 40, 1, 15),
  SEL("pow", "lift", "liftMotorId", "Lift motor", () => MOTORS.map(m => [m.id, m.name]), "m3508", p => p.vtol === "quad"),
  SEL("pow", "lift", "liftMountPattern", "Lift motor mount holes", MOUNT_OPTIONS, "auto", p => p.vtol === "quad"),
  F("pow", "lift", "liftPropD", "Lift propeller diameter", "in", 5, 22, 0.5, 12, p => p.vtol === "quad"),
  F("pow", "lift", "liftPropP", "Lift propeller pitch", "in", 2, 10, 0.1, 4.5, p => p.vtol === "quad"),

  // ---- flight conditions & calibration (aero tab)
  F("aero", "cond", "altitude", "Cruise altitude", "m", 0, 5000, 50, 200),
  F("aero", "cond", "maxStall", "Launch stall limit", "m/s", 5, 25, 0.5, 12, null, "Used for the maximum takeoff weight: hand launch ≈ 12 m/s."),
  F("aero", "cond", "minTW", "Min launch thrust-to-weight", "", 0.2, 1.5, 0.05, 0.45),
  F("aero", "cal", "kDrag", "Drag correction", "×", 0.5, 2, 0.01, 1, null, "Set by flight-test calibration."),
  F("aero", "cal", "kPower", "Power correction", "×", 0.5, 2, 0.01, 1),
  F("aero", "cal", "kMass", "Structure mass correction", "×", 0.5, 2, 0.01, 1),

  // ---- balance
  F("bal", "bal", "staticMargin", "Target static margin", "%", 2, 30, 0.5, 10),
  F("bal", "bal", "battX", "Battery position (from wing LE)", "mm", -900, 400, 1, -110, null, "Negative = ahead of the wing root leading edge."),
  F("bal", "bal", "payload", "Payload mass", "g", 0, 5000, 5, 150),
  F("bal", "bal", "payloadX", "Payload position (from wing LE)", "mm", -900, 400, 1, -40),
];
const SCHEMA_BY_ID = Object.fromEntries(SCHEMA.map(f => [f.id, f]));

const DEFAULT_COMPONENTS = () => [
  {name: "Flight controller", mass: 12, x: -30},
  {name: "GPS + compass", mass: 12, x: 20},
  {name: "Receiver", mass: 5, x: -20},
  {name: "Video transmitter", mass: 12, x: -70},
  {name: "FPV camera", mass: 7, x: null},               // null = auto (nose)
  {name: "Wiring & connectors", mass: 25, x: -40},
];

function defaultParams() {
  const p = {};
  SCHEMA.forEach(f => p[f.id] = f.def);
  Object.assign(p, {foilRoot: "naca3410", foilTip: "naca2412", foilTail: "naca0009", components: DEFAULT_COMPONENTS(), template: "cruiser"});
  return p;
}

/* Configuration templates — generic archetypes of popular printed airframes */
const TEMPLATES = [
  {id: "cruiser", name: "FPV cruiser", desc: "Conventional pusher with replaceable FPV nose; long endurance.",
    p: {wingType: "tapered", tailType: "conv", fuseType: "podboom", motorLayout: "pusher", span: 1600, rootChord: 240, taper: 0.6, sweep: 2, dihedral: 3, washout: 1.5, foilRoot: "naca3410", foilTip: "naca2412", noseMode: "replaceable", noseLen: 300, tailArm: 0.52, vtol: "none", wingBlend: true, blendSpan: 60, blendChord: 1.3, blendThick: 1.6, cells: 4, capacity: 4000, motorId: "m2216", propD: 9, propP: 6, battX: -110}},
  {id: "twinboom", name: "Twin-boom pusher", desc: "Pod on the wing, carbon booms and H-tail; clear pusher prop arc.",
    p: {wingType: "tapered", tailType: "twinboom", fuseType: "pod", motorLayout: "pusher", span: 1700, rootChord: 250, taper: 0.7, sweep: 0, dihedral: 2, washout: 1, podLen: 460, noseLen: 220, boomSpacing: 0.3, tailArm: 0.46, foilRoot: "naca4412", foilTip: "naca2412", noseMode: "replaceable", vtol: "none", cells: 6, capacity: 3300, motorId: "m3508", propD: 9, propP: 6, battX: -90}},
  {id: "twinmotor", name: "Twin-motor conventional", desc: "Wing-mounted tractors leave the nose free for sensors.",
    p: {wingType: "tapered", tailType: "conv", fuseType: "podboom", motorLayout: "twin", span: 1400, rootChord: 230, taper: 0.62, sweep: 1, dihedral: 2.5, washout: 1.5, noseLen: 280, motorSpan: 0.32, foilRoot: "naca3410", foilTip: "naca2412", noseMode: "replaceable", vtol: "none", cells: 4, capacity: 4000, motorId: "m2208", propD: 6, propP: 4, battX: -120}},
  {id: "wing", name: "Swept flying wing", desc: "Pusher wing with reflexed sections, washout and tip fins.",
    p: {wingType: "tapered", tailType: "none", fuseType: "pod", motorLayout: "pusher", span: 1100, rootChord: 300, taper: 0.45, sweep: 28, dihedral: 0, washout: 3, podLen: 300, noseLen: 120, tipFins: true, tipFinH: 100, foilRoot: "naca23112", foilTip: "naca23110", noseMode: "replaceable", vtol: "none", cells: 4, capacity: 2200, motorId: "m2208", propD: 6, propP: 4, staticMargin: 7, battX: -60}},
  {id: "fsw", name: "Forward-swept twin wing", desc: "Fast forward-swept flying wing with twin tractors.",
    p: {wingType: "tapered", tailType: "none", fuseType: "pod", motorLayout: "twin", motorSpan: 0.26, span: 1100, rootChord: 260, taper: 0.55, sweep: -8, dihedral: 0, washout: 0.5, podLen: 280, noseLen: 110, tipFins: true, tipFinH: 90, foilRoot: "naca23112", foilTip: "naca23110", noseMode: "replaceable", vtol: "none", cells: 3, capacity: 3000, motorId: "m2204", propD: 5, propP: 4.5, staticMargin: 6, battX: -40}},
  {id: "plank", name: "Plank wing", desc: "Low-sweep plank with reflex airfoil, twin tractors and a center pod.",
    p: {wingType: "tapered", tailType: "none", fuseType: "pod", motorLayout: "twin", motorSpan: 0.35, span: 1300, rootChord: 260, taper: 0.8, sweep: 3, dihedral: 1, washout: 1, podLen: 320, noseLen: 120, tipFins: true, tipFinH: 90, foilRoot: "naca25112", foilTip: "naca25112", noseMode: "replaceable", vtol: "none", cells: 4, capacity: 3000, motorId: "m2204", propD: 5, propP: 3, staticMargin: 5, battX: -60}},
  {id: "delta", name: "Delta", desc: "High-sweep delta with center fin — fast, stiff, compact.",
    p: {wingType: "delta", tailType: "fin", vVol: 0.03, vAR: 1.2, fuseType: "pod", motorLayout: "pusher", span: 960, rootChord: 330, taper: 0.12, teSweep: 0, dihedral: 0, washout: 1, podLen: 380, noseLen: 60, foilRoot: "naca23110", foilTip: "naca23110", noseMode: "replaceable", vtol: "none", cells: 4, capacity: 2600, motorId: "m2204", propD: 5, propP: 3, staticMargin: 6, battX: 60, sparPos: 0.3, spar2Pos: 0.6}},
  {id: "blended", name: "Blended long-range", desc: "Long-range cruiser with the wing faired into a roomy fuselage, V-tail and pusher.",
    p: {wingType: "tapered", tailType: "vtail", fuseType: "podboom", motorLayout: "pusher", span: 2000, rootChord: 260, taper: 0.55, sweep: 2, dihedral: 2.5, washout: 1.5, noseLen: 360, fuseW: 96, fuseH: 104, wingBlend: true, blendSpan: 90, blendChord: 1.28, blendThick: 2, foilRoot: "naca4412", foilTip: "naca2412", noseMode: "replaceable", deck: true, vtol: "none", cells: 6, capacity: 8000, motorId: "m3515", propD: 11, propP: 7, battX: -120, hatchBatt: false}},
  {id: "quadplane", name: "Quadplane VTOL", desc: "FPV cruiser plus four lift motors on underwing booms.",
    p: {wingType: "tapered", tailType: "vtail", fuseType: "podboom", motorLayout: "pusher", span: 1900, rootChord: 260, taper: 0.62, sweep: 1, dihedral: 2, washout: 1.5, noseLen: 340, foilRoot: "naca4412", foilTip: "naca2412", noseMode: "replaceable", pod: true, vtol: "quad", vtolBoomY: 0.36, cells: 5, capacity: 9600, chem: "lipo", motorId: "m2814", propD: 11, propP: 5.5, liftMotorId: "m3508", liftPropD: 13, liftPropP: 4.5, battX: -140}},
  {id: "tailsitter", name: "Tailsitter wing", desc: "Twin-motor wing that takes off vertically on its tip fins.",
    p: {wingType: "tapered", tailType: "none", fuseType: "pod", motorLayout: "twin", motorSpan: 0.38, span: 1000, rootChord: 280, taper: 0.7, sweep: 12, dihedral: 0, washout: 1.5, tipFins: true, tipFinH: 150, podLen: 300, noseLen: 110, foilRoot: "naca23112", foilTip: "naca23112", noseMode: "replaceable", vtol: "tailsitter", hoverTime: 60, cells: 4, capacity: 3000, motorId: "m2212", propD: 8, propP: 6, staticMargin: 6, battX: -50}},
];

const MISSION_SCHEMA = [
  F("opt", "mission", "mPayload", "Payload", "g", 0, 5000, 5, 250),
  SEL("opt", "mission", "mReqType", "Requirement", [["range", "Range (km)"], ["endurance", "Endurance (min)"]], "range"),
  F("opt", "mission", "mReqValue", "Required distance / time", "", 1, 600, 1, 40),
  F("opt", "mission", "mAltitude", "Cruise altitude", "m", 0, 5000, 50, 300),
  F("opt", "mission", "mMinCruise", "Min cruise speed", "m/s", 6, 45, 0.5, 15),
  F("opt", "mission", "mMaxStall", "Max stall speed", "m/s", 5, 25, 0.5, 11),
  F("opt", "mission", "mMaxSpan", "Max wingspan", "mm", 400, 3500, 10, 1800),
  F("opt", "mission", "mMaxMass", "Max takeoff mass", "g", 200, 15000, 50, 3000),
  SEL("opt", "mission", "mChem", "Battery chemistry", Object.entries(CHEM).map(([k, v]) => [k, v.name]), "liion"),
  SEL("opt", "objective", "oObjective", "Optimize for", [["mass", "Lightest aircraft"], ["endurance", "Longest endurance"], ["range", "Longest range"], ["material", "Least filament"], ["ld", "Best L/D at cruise"]], "mass"),
  T("opt", "objective", "oPower", "Also choose motor and propeller", true),
  F("opt", "space", "sSpanMin", "Span search from", "mm", 400, 3500, 10, 900),
  F("opt", "space", "sARMin", "Aspect ratio from", "", 2, 20, 0.5, 5),
  F("opt", "space", "sARMax", "Aspect ratio to", "", 2, 20, 0.5, 12),
  F("opt", "run", "rPop", "Population", "", 12, 120, 2, 36),
  F("opt", "run", "rGens", "Generations", "", 10, 400, 5, 70),
];
function defaultMission() { const m = {}; MISSION_SCHEMA.forEach(f => m[f.id] = f.def); return m; }

const GROUPS = {
  air: [["cfg", "Configuration"], ["foils", "Airfoils"], ["wing", "Wing"], ["tail", "Tail"], ["fuse", "Fuselage & FPV nose"], ["mounts", "Mounts & bays"], ["hatch", "Hatches"], ["ctrl", "Control surfaces & servos"], ["cool", "Cooling & battery"], ["vtol", "VTOL kit (bolt-on)"], ["spars", "Spars"], ["cuts", "Cuts & joiners"], ["fasten", "Screws, inserts & jigs"], ["print", "Printer & material"]],
  pow: [["motor", "Cruise motor & propeller"], ["batt", "Battery"], ["lift", "VTOL lift system"], ["lab", "Power lab"]],
  aero: [["solver", "Aero solver"], ["cond", "Flight conditions"], ["cal", "Flight-test calibration"]],
  bal: [["bal", "Balance"], ["comps", "Components"]],
  opt: [["mission", "Mission"], ["objective", "Objective"], ["space", "Design space"], ["run", "Run"]],
};
