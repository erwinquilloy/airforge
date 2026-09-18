"use strict";
/* ==========================================================================
   App wiring: tabs, update scheduling, templates, power lab, optimizer,
   calibration, 3D drag handling and export.
   ========================================================================== */
const App = {
  fullTimer: 0, rafPending: false,

  init() {
    loadState();
    this.loadUser();
    document.querySelectorAll("[data-tab]").forEach(b => b.addEventListener("click", () => this.setTab(b.dataset.tab)));
    document.querySelectorAll("[data-view]").forEach(b => b.addEventListener("click", () => Viewer.setView(b.dataset.view)));
    $("exportBtn").addEventListener("click", () => this.exportZip());
    $("saveBtn").addEventListener("click", () => this.saveDesign());
    $("loadFile").addEventListener("change", e => { const f = e.target.files[0]; if (f) this.loadDesign(f); e.target.value = ""; });
    Viewer.init($("view"), {onDrag: (k, v) => this.drag(k, v), onHover: (pt, e, mk) => this.hover(pt, e, mk)});
    const redraw = () => { if (S.A) { Viewer.setModel(S.A, S.B); Panels.render(); } };
    try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw); } catch (e) { /* old browser */ }
    new MutationObserver(redraw).observe(document.documentElement, {attributes: true, attributeFilter: ["data-theme"]});
    let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => Panels.render(), 150); });
    this.setTab(store.get("af2-tab") || "air", true);
    if (S.firstRun) { try { S.p.battX = Math.round(analyze(S.p).battXNeeded); S.p.battX = Math.round(analyze(S.p).battXNeeded); } catch (err) { /* keep template value */ } }
    this.full();
  },
  setTab(tab, silent) {
    S.tab = tab; store.set("af2-tab", tab);
    document.querySelectorAll("[data-tab]").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === tab));
    Left.render();
    if (!silent) { Panels.render(); this.recolor(); }
  },

  /* ---------------- updates ---------------- */
  changed(id, final) {
    Left.refresh();
    if (S.tab === "opt") { store.set("af2-m", S.m); if (["rGens", "rPop"].includes(id)) return; Panels.render(); return; }
    if (final) { cancelAnimationFrame(this.raf); this.full(); }
    else this.quick();
  },
  quick() {
    if (this.rafPending) return;
    this.rafPending = true;
    this.raf = requestAnimationFrame(() => {
      this.rafPending = false;
      try {
        S.A = analyze(S.p, {res: "coarse"});
        S.B = buildAircraft(S.A, {preview: true});
        Viewer.setModel(S.A, S.B); this.recolor(true); Panels.render(); this.hud();
      } catch (e) { console.error(e); }
      clearTimeout(this.fullTimer); this.fullTimer = setTimeout(() => this.full(), 450);
    });
  },
  full() {
    clearTimeout(this.fullTimer);
    try {
      S.A = analyze(S.p);
      S.B = buildAircraft(S.A, {preview: true});
      Viewer.setModel(S.A, S.B); this.recolor(true); Panels.render(); this.hud();
      saveState();
    } catch (e) { console.error(e); toast("That combination could not be analyzed: " + e.message); }
  },
  recolor(skipRender) {
    const mode = S.tab === "aero" ? S.color : "parts";
    Viewer.setColorMode(mode, S.tab === "aero" && S.alphaCustom ? S.alphaDeg : null);
    $("cmap").hidden = mode === "parts";
    if (mode !== "parts") $("cmap").innerHTML = mode === "pressure"
      ? `<span>suction</span><i class="grad cp"></i><span>pressure</span>`
      : `<span>low cl</span><i class="grad stall"></i><span>stalling</span>`;
    if (!skipRender) Viewer.render();
  },
  hud() {
    const A = S.A, B = S.B;
    $("hud").innerHTML = [["span", fmt(S.p.span) + " mm"], ["area", fmt(A.L.wing.S / 1e4, 1) + " dm²"], ["mass", fmt(A.mtow) + " g"], ["parts", B.parts.length]]
      .map(([k, v]) => `<span class="tag">${k} <b>${v}</b></span>`).join("");
  },

  /* ---------------- 3D interaction ---------------- */
  drag(kind, v) {
    const p = S.p, L = S.A.L, x = Math.round(v.x), ang = Math.round(v.ang);
    if (kind === "intake") { p.intakeX = Math.max(10, x - Math.round(p.intakeL / 2)); p.intakeAng = ang; }
    if (kind === "exhaust") { p.exhaustX = Math.max(10, x - 12); p.exhaustAng = ang; }
    if (kind === "hatchBatt") { p.hatchBattAuto = false; p.hatchBattX = Math.max(10, x - Math.round(p.hatchBattLen / 2)); }
    if (kind === "hatchAv") p.hatchAvX = Math.max(10, x - Math.round(p.hatchAvLen / 2));
    if (kind === "deck") p.deckX = x - L.xw - Math.round(p.deckLen / 2);
    const wcs = S.B.wcs, clamp01 = v => Math.min(1, Math.max(0, +v.toFixed(2)));
    if (kind === "servo" && wcs) {
      const bay = S.B.bays.find(q => q.kind === "servo"), len = bay ? bay.b - bay.a : 46, lo = wcs.a + len / 2 + 2, hi = Math.max(lo + 1, wcs.b - len / 2 - 2);
      p.servoPos = clamp01((Math.abs(v.y) - lo) / (hi - lo));
    }
    if (kind === "horn" && wcs) { p.hornAuto = false; p.hornPos = clamp01((Math.abs(v.y) - wcs.a - 6) / (wcs.b - wcs.a - 12)); }
    if (kind === "pod") p.podX = x - L.xw - Math.round(p.podL / 2);
    $("dragTip").hidden = v.final;
    $("dragTip").textContent = ["servo", "horn"].includes(kind)
      ? `${kind === "servo" ? "wing servo" : "control horn"} · ${fmt(Math.abs(v.y))} mm from the wing root`
      : `${kind === "hatchBatt" ? "battery hatch" : kind === "hatchAv" ? "avionics hatch" : kind === "deck" ? "canopy" : kind} · ${fmt(x)} mm from nose${["intake", "exhaust"].includes(kind) ? ` · ${ang}°` : ""}`;
    if (v.final) { Left.sync(); this.full(); if (S.tab === "aero" && S.color === "pressure") toast("Moved. Check the Cooling ports section for the new pressures."); }
  },
  hover(pt, e, markerKind) {
    const tip = $("partTip"), stage = $("view").getBoundingClientRect();
    if (markerKind) { tip.hidden = false; tip.textContent = `Drag to move the ${{hatchBatt: "battery hatch", hatchAv: "avionics hatch", deck: "canopy", servo: "wing servo (both sides)", horn: "control horn (both sides)"}[markerKind] || markerKind}`; }
    else if (!pt) { tip.hidden = true; return; }
    else { tip.hidden = false; tip.textContent = `${pt.name} · ${pt.size.map(v => fmt(v)).join(" × ")} mm${pt.fits ? "" : " · too big for the bed"}`; }
    tip.style.left = Math.min(stage.width - 20, e.clientX - stage.left + 14) + "px";
    tip.style.top = (e.clientY - stage.top + 14) + "px";
  },

  /* ---------------- templates & balance ---------------- */
  applyTemplate(id) {
    const t = TEMPLATES.find(q => q.id === id); if (!t) return;
    const keep = {};
    for (const f of SCHEMA) if (["print", "fasten", "cuts", "spars"].includes(f.group) || f.tab === "aero") keep[f.id] = S.p[f.id];
    const comps = S.p.components;
    S.p = Object.assign(defaultParams(), keep, t.p, {template: id, components: comps});
    try { S.p.battX = Math.round(analyze(S.p).battXNeeded); S.p.battX = Math.round(analyze(S.p).battXNeeded); } catch (e) { /* keep template value */ }
    Left.render(); this.full();
    toast(`${t.name} loaded and balanced. Adjust anything from here.`);
  },
  autoBalance() {
    const need = Math.round(S.A.battXNeeded), L = S.A.L;
    const lo = L.hasFuse ? -L.xw + 20 : -60, hi = L.wing.cr * 0.8;
    S.p.battX = Math.min(hi, Math.max(lo, need));
    Left.sync(); this.full();
    toast(need < lo || need > hi ? `The battery would need to sit at ${fmt(need)} mm, outside the bay. Moved it to the limit; add nose weight or move the payload.` : `Battery moved to ${fmt(S.p.battX)} mm from the wing leading edge.`);
  },
  calibrate(c) {
    const A = S.A, p = S.p, notes = [];
    if (c.mass > 0) {
      const struct = A.items.filter(i => i.group === "structure").reduce((s, i) => s + i.mass, 0);
      const k = p.kMass * Math.max(0.3, (c.mass - (A.mtow - struct)) / struct);
      p.kMass = Math.min(2, Math.max(0.5, +k.toFixed(3))); notes.push(`structure ×${fmt(p.kMass, 2)}`);
    }
    if (c.V > 0 && c.I > 0) {
      const A2 = analyze(p), r = A2.perf.pts.filter(q => q.Pb).reduce((b, q) => Math.abs(q.V - c.V) < Math.abs(b.V - c.V) ? q : b);
      const measured = c.I * A2.pk.V0 * 0.97;
      p.kPower = Math.min(2, Math.max(0.5, +(p.kPower * measured / r.Pb).toFixed(3))); notes.push(`power ×${fmt(p.kPower, 2)}`);
    }
    if (c.glide > 0 && A.perf.bestLD) { p.kDrag = Math.min(2, Math.max(0.5, +(p.kDrag * A.perf.bestLD.LD / c.glide).toFixed(3))); notes.push(`drag ×${fmt(p.kDrag, 2)}`); }
    if (!notes.length) { toast("Enter at least the flying weight, or cruise speed with current."); return; }
    Left.sync(); this.full(); toast("Calibrated: " + notes.join(", ") + ".");
  },

  /* ---------------- power lab ---------------- */
  runLab() {
    if (S.lab.running) return;
    S.lab.running = true; S.lab.rows = null; Panels.labTable();
    const gen = rankPowertrains(Object.assign({}, S.p), S.lab.obj), btn = $("labRun");
    if (btn) { btn.disabled = true; btn.textContent = "Ranking…"; }
    const step = () => {
      const t0 = performance.now(); let r;
      do { r = gen.next(); } while (!r.done && performance.now() - t0 < 40);
      if ($("labProg")) $("labProg").style.width = (r.done ? 100 : r.value * 100) + "%";
      if (!r.done) return setTimeout(step, 0);
      S.lab.rows = r.value; S.lab.running = false;
      if ($("labRun")) { $("labRun").disabled = false; $("labRun").textContent = "Rank combinations"; }
      Panels.labTable();
      toast(r.value.length ? `${r.value.length} combinations pass every limit.` : "No combination passes every limit.");
    };
    setTimeout(step, 0);
  },
  saveCompare() {
    const A = S.A, p = S.p;
    S.compare.push({label: `${A.motor.name} · ${p.propD}×${p.propP}" · ${p.cells}S ${fmt(p.capacity)}`, motorId: p.motorId, propD: p.propD, propP: p.propP, cells: p.cells, capacity: p.capacity, chem: p.chem, mtow: A.mtow, tw: A.perf.TW, end: A.perf.endurance, range: A.perf.range});
    store.set("af2-compare", S.compare);
    if (S.tab !== "pow") this.setTab("pow"); else Panels.render();
    toast("Setup saved for comparison.");
  },

  /* ---------------- optimizer ---------------- */
  runOpt() {
    const cands = S.opt.cands || [];
    if (!cands.length) { toast("Pick at least one candidate airfoil."); return; }
    S.opt.running = true; S.opt.state = null;
    const gen = runMission(Object.assign({}, S.p), Object.assign({}, S.m), cands), obj = OPT_OBJ[S.m.oObjective];
    $("optRun").disabled = true; $("optStop").disabled = false; $("optUse").disabled = true;
    const step = () => {
      if (!S.opt.running) return finish("Stopped");
      const t0 = performance.now(); let r;
      do { r = gen.next(); } while (!r.done && performance.now() - t0 < 60);
      const st = r.value; S.opt.state = st;
      if ($("optProg")) $("optProg").style.width = (st.gen / S.m.rGens * 100) + "%";
      const b = st.best;
      if ($("optStatus")) $("optStatus").textContent = b && b.feasible ? `Generation ${st.gen}/${S.m.rGens} · best ${obj.label} ${obj.show(b.obj)} · ${fmt(b.p.span)} mm span` : `Generation ${st.gen}/${S.m.rGens} · no design meets every requirement yet`;
      if (st.gen % 4 === 0 || r.done) Panels.render();
      if (b && b.feasible && st.gen % 8 === 0) { S.A = b.A; S.B = buildAircraft(b.A, {preview: true}); Viewer.setModel(S.A, S.B); }
      if (r.done) return finish("Done");
      setTimeout(step, 0);
    };
    const finish = label => {
      S.opt.running = false;
      $("optRun").disabled = false; $("optStop").disabled = true;
      const b = S.opt.state && S.opt.state.best;
      if (b && b.feasible) { $("optUse").disabled = false; $("optStatus").textContent = `${label}. Best ${obj.label}: ${obj.show(b.obj)}. Press “Use best design” to load it.`; }
      else $("optStatus").textContent = `${label}. Nothing met every requirement: relax the stall speed, span or mass limit, or lower the required ${S.m.mReqType}.`;
      Panels.render();
    };
    setTimeout(step, 0);
  },
  useBest() {
    const b = S.opt.state && S.opt.state.best; if (!b) return;
    S.p = Object.assign({}, b.p); S.p.battX = Math.round(analyze(S.p).battXNeeded);
    this.setTab("air"); this.full();
    toast("Optimized design loaded. Everything stays editable.");
  },

  /* ---------------- the design file ---------------- */
  saveUser() {
    try {
      const out = {};
      let bytes = 0;
      for (const cp of S.p.customParts || []) {
        const t = USER.mesh[cp.id];
        if (!t) continue;
        bytes += t.byteLength;
        if (bytes > 3e6) { toast("Uploaded parts are too large to keep between reloads; save the design file to keep them."); break; }
        out[cp.id] = b64FromTris(t);
      }
      const ref = USER.ref && USER.ref.tris.byteLength < 3e6 ? {name: USER.ref.name, tris: b64FromTris(USER.ref.tris)} : null;
      store.set("af2-user", {meshes: out, ref});
    } catch (e) { /* storage full: the design file is the durable copy */ }
  },
  loadUser() {
    const u = store.get("af2-user");
    if (!u) return;
    for (const [id, b] of Object.entries(u.meshes || {})) { try { USER.mesh[id] = trisFromB64(b); } catch (e) { /* skip */ } }
    if (u.ref) { try { USER.ref = {name: u.ref.name, tris: trisFromB64(u.ref.tris)}; } catch (e) { /* skip */ } }
  },
  saveDesign() {
    const d = designFile(S.p, S.importedDat || []);
    const name = (S.p.designName || S.p.template || "design").replace(/[^\w.-]+/g, "_");
    const blob = new Blob([JSON.stringify(d)], {type: "application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name + ".afd.json";
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
    toast(`Saved ${name}.afd.json — every setting, your imported airfoils and any uploaded geometry.`);
  },
  loadDesign(file) {
    file.text().then(txt => {
      let r;
      try { r = readDesignFile(txt, SCHEMA, defaultParams()); } catch (e) { toast(e.message); return; }
      S.p = r.params;
      for (const d of r.foils) { try { const f = parseDat(d.text, d.name); f.id = d.id; addFoil(f); if (!S.importedDat.some(q => q.id === d.id)) S.importedDat.push(d); } catch (e) { /* skip */ } }
      store.set("af2-foils", S.importedDat);
      this.saveUser();
      Left.render(); this.full();
      toast((r.notes.length ? r.notes.join(" ") + " " : "") + "Design loaded.");
    });
  },

  /* ---------------- export ---------------- */
  async exportZip() {
    const btn = $("exportBtn"); btn.disabled = true; btn.textContent = "Building parts…";
    await new Promise(r => setTimeout(r, 40));
    try {
      const A = analyze(S.p), B = buildAircraft(A), enc = new TextEncoder(), files = [];
      for (const pt of B.parts) files.push({name: `stl/${pt.group}/${pt.name}.stl`, data: stlBinary(pt.printTris, pt.name)});
      const asm = B.parts.filter(q => q.group !== "jig"), total = asm.reduce((s, q) => s + q.tris.length, 0), all = new Float32Array(total);
      let o = 0; for (const q of asm) { all.set(q.tris, o); o += q.tris.length; }
      files.push({name: "cfd/aircraft_flight_position_mm.stl", data: stlBinary(all, "assembly")});
      const avl = avlText(A);
      files.push({name: "avl/aircraft.avl", data: enc.encode(avl.text)});
      const foils = new Set([A.L.wing.fRoot, A.L.wing.fTip, A.L.fTail, ...avl.foils]);
      for (const f of foils) { files.push({name: `avl/airfoils/${f.id}.dat`, data: enc.encode(datText(f))}); }
      files.push({name: "build_sheet.txt", data: enc.encode(buildSheet(A, B))});
      files.push({name: "design.json", data: enc.encode(JSON.stringify({generator: "Airframe Forge", params: S.p, mission: S.m, results: {mtow_g: A.mtow, stall_ms: A.perf.Vs, cruise_ms: A.perf.cruise && A.perf.cruise.V, endurance_min: A.perf.endurance, range_km: A.perf.range, cg_mm_from_le: A.xcg - A.L.xw, np_mm_from_le: A.xnp - A.L.xw}}, null, 2))});
      const zip = makeZip(files), filename = `airframe-forge-${S.p.template || "custom"}-${Math.round(S.p.span)}mm.zip`;
      btn.textContent = "Saving…";
      const dl = window.claude && window.claude.use ? await window.claude.use("downloads") : undefined;
      if (dl) {
        try { await dl.save({filename, data: zip}); toast(`Saved ${filename}: ${B.parts.length} STL parts, CFD assembly, AVL model and build sheet.`); }
        catch (e) { if (!e || e.code !== "declined") toast("The file could not be saved here" + (e && e.message ? ": " + e.message : ".")); }
      } else if (dl === null) {
        toast("Saving files isn't available in this view. Open the page in a browser to export.");
      } else {
        const a = document.createElement("a"); a.href = URL.createObjectURL(zip); a.download = filename; document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
        toast(`Downloaded ${filename} with ${B.parts.length} STL parts.`);
      }
    } catch (e) { console.error(e); toast("Export failed: " + e.message); }
    btn.disabled = false; btn.textContent = "Export parts";
  },
};

function buildSheet(A, B) {
  const p = A.p, L = A.L, W = L.wing, f = A.perf, out = [], line = (...s) => out.push(...s);
  const hr = t => line("", t.toUpperCase(), "-".repeat(t.length));
  line("AIRFRAME FORGE — BUILD SHEET", "=".repeat(28), `Template: ${p.template || "custom"}   Span ${fmt(p.span)} mm   Takeoff mass ${fmt(A.mtow)} g`);
  hr("Configuration");
  line(`Wing ${p.wingType}, tail ${p.tailType}, fuselage ${p.fuseType}, motors ${p.motorLayout}${p.vtol !== "none" ? `, VTOL ${p.vtol}` : ""}`,
    `Root ${fmt(W.cr)} mm / tip ${fmt(W.ct)} mm, area ${fmt(W.S / 1e4, 1)} dm², AR ${fmt(W.AR, 2)}, MAC ${fmt(W.mac)} mm`,
    `Airfoils: root ${W.fRoot.name}, tip ${W.fTip.name}, tail ${L.fTail.name}`);
  hr("Balance");
  line(`CG ${fmt(A.xTarget - L.xw)} mm behind the wing root leading edge (static margin ${p.staticMargin}%). Neutral point ${fmt(A.xnp - L.xw)} mm.`,
    `Battery center at ${fmt(p.battX)} mm (balance needs ${fmt(A.battXNeeded)} mm).`);
  hr("Performance (estimates)");
  line(`Stall ${fmt(f.Vs, 1)} m/s · cruise ${f.cruise ? fmt(f.cruise.V, 1) : "—"} m/s · top ${fmt(f.Vmax)} m/s`, `Endurance ${fmt(f.endurance)} min · range ${fmt(f.range, 1)} km · max L/D ${f.bestLD ? fmt(f.bestLD.LD, 1) : "—"}`,
    `Maximum takeoff weight ${fmt(A.MTOW)} g, limited by ${A.limits[0][0]}`);
  hr("Power");
  line(`${L.motors.length} × ${A.motor.name}, ${p.propD}×${p.propP}" props, ${MOUNT_PATTERNS[p.mountPattern === "auto" ? A.motor.mountId : p.mountPattern].name} mount`,
    `${p.cells}S ${fmt(p.capacity)} mAh ${CHEM[p.chem].name} (${fmt(A.pk.Wh, 1)} Wh, ~${fmt(A.battMass)} g); full throttle ${fmt(f.static1.Ib, 1)} A`);
  hr("Hardware");
  for (const r of B.bom.sparRuns) line(`${r.count} × ${tubeLabel(r.tube)} — ${r.role.toLowerCase()}${r.continuous ? ", passes through the fuselage" : ", one per wing"}: ${fmt(r.len)} mm (do not glue — slide through the bores)`);
  for (const b of L.booms) line(`${tubeLabel(b.tube)} ${b.role} boom${b.mirrored ? " × 2" : ""}: ${fmt(Math.hypot(b.b[0] - b.a[0], b.b[2] - b.a[2]))} mm`);
  if (B.bom.pins.length) line(`${B.bom.pins.length} joiner pins, ${p.pinSize.replace("r", "")} mm rod × ${fmt(B.bom.pins[0] * 2)} mm (glue into one side only)`);
  if (B.bom.hingePin) line(`Hinge pin (${HINGE_PINS[p.hingePin].name}): ${fmt(B.bom.hingePin * 2)} mm total`);
  line(`M3 heat-set inserts: ${B.bom.inserts} · M3 screws: ${B.bom.m3screws}${B.bom.magnets ? ` · 6×3 mm magnets: ${B.bom.magnets}` : ""}${B.bom.straps ? ` · battery straps: ${B.bom.straps}` : ""}`);
  hr("Printed parts");
  line("Size is the print footprint X × Y × height (mm). Default skins: " + MATERIALS[p.material].name + ", " + MATERIALS[p.material].note);
  for (const q of B.parts) line(`${q.fits ? " " : "!"} ${q.name.padEnd(30)} ${q.size.map(v => fmt(v)).join(" × ").padEnd(18)} ${q.info ? "[" + q.info + "] " : ""}${q.settings || ""}`);
  hr("Checks");
  for (const [l, t] of A.warn) line(`[${l.toUpperCase()}] ${t}`);
  for (const t of B.warns) line(`[CHECK] ${t}`);
  hr("Design log");
  for (const [t, x] of A.log) line(`${t}: ${x}`);
  line("", "cfd/aircraft_flight_position_mm.stl is the whole aircraft in flight position (millimetres) for CFD meshing.", "avl/aircraft.avl opens in Mark Drela's AVL together with the airfoils folder.");
  return out.join("\r\n");
}

window.addEventListener("DOMContentLoaded", () => App.init());
