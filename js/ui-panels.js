"use strict";
/* ==========================================================================
   Right-hand analysis panels and their charts.
   ========================================================================== */
Left.after.run = Left.custom.run; delete Left.custom.run;

const Panels = {
  render() {
    const A = S.A, B = S.B; if (!A || !B) return;
    const tabs = {air: this.air, pow: this.pow, aero: this.aero, bal: this.bal, opt: this.opt};
    $("right").innerHTML = this.summary(A, B) + tabs[S.tab].call(this, A, B);
    this.after && this.after(); this.after = null;
    this.drawFoil();
  },
  summary(A, B) {
    const f = A.perf, badParts = B.parts.filter(q => !q.fits).length;
    const chip = (ok, label, tip) => `<span class="state ${ok === true ? "ok" : ok === "warn" ? "warn" : "bad"}" title="${esc(tip)}"><i></i>${label}</span>`;
    const balOk = Math.abs(A.smActual - S.p.staticMargin) < 3 ? true : A.smActual > 2 ? "warn" : false;
    const structOk = A.tubes.every(t => t.ok);
    const powOk = !A.warn.some(([l, t]) => l === "bad" && /current|C |C\.|discharge|level flight|hover/i.test(t));
    return `<section class="sec summary">
      <div class="tiles">
        <div class="tile"><span>Takeoff mass</span><b>${fmt(A.mtow)}</b><i>g</i></div>
        <div class="tile"><span>Stall</span><b>${fmt(f.Vs, 1)}</b><i>m/s</i></div>
        <div class="tile"><span>Cruise</span><b>${f.cruise ? fmt(f.cruise.V, 1) : "—"}</b><i>m/s</i></div>
        <div class="tile"><span>Endurance</span><b>${fmt(f.endurance)}</b><i>min</i></div>
        <div class="tile"><span>Range</span><b>${fmt(f.range, 1)}</b><i>km</i></div>
        <div class="tile"><span>Max L/D</span><b>${f.bestLD ? fmt(f.bestLD.LD, 1) : "—"}</b></div>
      </div>
      <div class="states">${chip(balOk, "Balance", `Static margin ${fmt(A.smActual, 1)}%`)}${chip(structOk, "Spars", A.tubes.map(t => tubeLabel(t.tube)).join(", "))}${chip(powOk, "Power", `${fmt(f.TW, 2)} thrust-to-weight`)}${chip(badParts ? false : true, badParts ? `${badParts} parts too big` : "Fits printer", `${B.parts.length} parts`)}</div>
    </section>`;
  },
  checks(A, B) {
    const list = A.warn.filter(w => w[0] !== "ok").concat(B.warns.map(w => ["warn", w]));
    if (!list.length) list.push(["ok", "No issues found: structure, printing, stall, balance and power checks all pass."]);
    const label = {ok: "pass", warn: "check", bad: "fail"};
    return `<section class="sec"><h2>Checks</h2><div class="alerts">${list.map(([l, t]) => `<div class="alert ${l}"><span class="pill">${label[l]}</span><span>${esc(t)}</span></div>`).join("")}</div></section>`;
  },

  /* ---------------- Airframe ---------------- */
  air(A, B) {
    const W = A.L.wing, groups = {wing: "Wing", ctrl: "Control surfaces & servos", tail: "Tail", fuse: "Fuselage & hatches", mount: "Mounts", vtol: "VTOL kit", cool: "Cooling & battery", jig: "Jigs"};
    const rows = [...A.items].sort((a, b) => b.mass - a.mass), maxM = rows[0].mass;
    const bom = B.bom, pins = bom.pins.length;
    const byGroup = Object.entries(groups).map(([g, name]) => {
      const ps = B.parts.filter(q => q.group === g); if (!ps.length) return "";
      return `<tr class="grp-row"><th colspan="3">${name} <span>${ps.length}</span></th></tr>` + ps.map(q => `<tr data-part="${esc(q.name)}" class="${q.fits ? "" : "nofit"}" tabindex="0"><td>${esc(q.name)}${q.info ? `<small>${esc(q.info)}</small>` : ""}</td><td class="num">${q.size.map(v => fmt(v)).join(" × ")}</td><td>${q.fits ? "" : '<span class="pill-bad">too big</span>'}</td></tr>`).join("");
    }).join("");
    this.after = () => {
      document.querySelectorAll("tr[data-part]").forEach(tr => {
        const show = () => { Viewer.highlight(tr.dataset.part); const q = B.parts.find(x => x.name === tr.dataset.part); $("partNote").textContent = q ? `${q.name}: ${q.settings || ""}` : ""; };
        tr.onmouseenter = show; tr.onfocus = show; tr.onclick = show;
      });
    };
    return this.checks(A, B) + `
    <section class="sec"><h2>Geometry</h2><dl class="kv">
      <dt>Wing area · aspect ratio</dt><dd>${fmt(W.S / 1e4, 1)} dm² · ${fmt(W.AR, 2)}</dd>
      <dt>Mean aerodynamic chord</dt><dd>${fmt(W.mac)} mm</dd>
      <dt>Wing loading</dt><dd>${fmt(A.mtow / (W.S / 1e4), 1)} g/dm²</dd>
      ${A.L.hasFuse ? `<dt>Fuselage length</dt><dd>${fmt(A.L.fuse.L)} mm</dd>` : ""}
      ${A.L.tail.Sh ? `<dt>Stabilizer · fin area</dt><dd>${fmt(A.L.tail.Sh / 1e4, 2)} · ${fmt(A.L.tail.Sv / 1e4, 2)} dm²</dd>` : ""}
    </dl></section>
    <section class="sec"><h2>Weight breakdown</h2><div class="wbars">${rows.map(r => `<div class="wbar"><span>${esc(r.name)}</span><div class="track"><div class="fill" style="width:${(r.mass / maxM * 100).toFixed(1)}%"></div></div><b>${fmt(r.mass)} g</b></div>`).join("")}</div></section>
    <section class="sec"><h2>Structure</h2><dl class="kv">
      ${A.tubes.map((t, i) => `<dt>${i ? "Rear" : "Main"} spar</dt><dd>${tubeLabel(t.tube)}, ${fmt(t.len)} mm</dd>`).join("")}
      <dt>Root moment at ${S.p.loadFactor} g</dt><dd>${fmt(A.M_root / 1000, 1)} N·m</dd>
      ${A.tubes.map((t, i) => `<dt>${i ? "Rear" : "Main"} spar stress</dt><dd>${fmt(t.stress)} / ${fmt(CARBON_ALLOW)} MPa</dd>`).join("")}
    </dl></section>
    <section class="sec"><h2>Hardware to buy</h2><dl class="kv">
      ${A.tubes.map((t, i) => `<dt>${tubeLabel(t.tube)}</dt><dd>${fmt(t.len)} mm</dd>`).join("")}
      ${A.L.booms.map(b => `<dt>${tubeLabel(b.tube)} ${b.role === "vtol" ? "VTOL" : "tail"} boom${b.mirrored ? " × 2" : ""}</dt><dd>${fmt(Math.hypot(b.b[0] - b.a[0], b.b[2] - b.a[2]))} mm</dd>`).join("")}
      ${pins ? `<dt>Joiner pins (${S.p.pinSize.replace("r", "")} mm rod)</dt><dd>${pins} × ${fmt(bom.pins[0] * 2)} mm</dd>` : ""}
      ${bom.hingePin ? `<dt>Hinge pin (${HINGE_PINS[S.p.hingePin].name})</dt><dd>${fmt(bom.hingePin * 2)} mm total</dd>` : ""}
      ${bom.inserts ? `<dt>M3 heat-set inserts · M3 screws</dt><dd>${bom.inserts} · ${bom.m3screws}</dd>` : ""}
      ${bom.magnets ? `<dt>6 × 3 mm magnets</dt><dd>${bom.magnets}</dd>` : ""}
      ${bom.servos ? `<dt>Servos (${esc((SERVOS[S.p.servoType] || {name: "custom"}).name.split(" — ")[0])})</dt><dd>${A.L.tailless ? 2 : 4}</dd>` : ""}
      ${bom.straps ? `<dt>Battery straps (${S.p.strapW} mm)</dt><dd>${bom.straps}</dd>` : ""}
    </dl></section>
    <section class="sec"><h2>Printed parts <span class="count">${B.parts.length}</span></h2>
      <p class="hint" id="partNote">Hover a part to highlight it and see its print settings.</p>
      <div class="table-wrap"><table class="parts"><thead><tr><th>Part</th><th class="num">Print size, mm</th><th></th></tr></thead><tbody>${byGroup}</tbody></table></div>
      <dl class="kv"><dt>Printed mass</dt><dd>${fmt(A.printMass)} g</dd><dt>Filament (1.75 mm)</dt><dd>${fmt(A.printMass / (MATERIALS[S.p.material].filRho / 1000) / (Math.PI * 0.875 ** 2) / 1000)} m</dd></dl>
    </section>
    <section class="sec"><h2>Design log</h2><ol class="log">${A.log.map(([t, x]) => `<li><b>${esc(t)}</b> ${esc(x)}</li>`).join("")}</ol></section>`;
  },

  /* ---------------- Power ---------------- */
  pow(A) {
    const f = A.perf, pts = f.pts.filter(r => r.V <= Math.max(f.Vmax * 1.1, (f.cruise ? f.cruise.V : 15) * 1.8));
    const hov = f.hover;
    this.after = () => {
      lineChart($("chThrust"), {series: [{name: "Full-throttle thrust", short: "Thrust", color: "--s1", pts: pts.map(r => [r.V, r.Tfull])}, {name: "Drag", short: "Drag", color: "--s2", pts: pts.map(r => [r.V, r.D])}],
        yMin: 0, yLabel: "N", xLabel: "m/s", xUnit: "m/s", fmtY: v => fmt(v, 1) + " N", vlines: f.Vmax ? [{x: f.Vmax, label: `top ${fmt(f.Vmax)} m/s`}] : []});
      const pp = pts.filter(r => r.Pb);
      lineChart($("chPower"), {series: [{name: "Battery power", color: "--s1", area: true, pts: pp.map(r => [r.V, r.Pb])}], yMin: 0, yLabel: "W", xLabel: "m/s", xUnit: "m/s", fmtY: v => fmt(v) + " W",
        tipExtra: x => { const r = pp.find(q => q.V === x); return r ? ` · ${fmt(r.throttle * 100)}% throttle · ${fmt(r.Ib, 1)} A` : ""; },
        markers: [f.loiter && {x: f.loiter.V, y: f.loiter.Pb, label: "loiter", below: true}, f.cruise && Math.abs(f.cruise.V - f.loiter.V) > 0.7 && {x: f.cruise.V, y: f.cruise.Pb, label: "cruise"}].filter(Boolean)});
      document.querySelectorAll("[data-cmp-use]").forEach(b => b.onclick = () => { const c = S.compare[+b.dataset.cmpUse]; Object.assign(S.p, {motorId: c.motorId, propD: c.propD, propP: c.propP, cells: c.cells, capacity: c.capacity, chem: c.chem}); Left.sync(); App.full(); toast(`${c.label} applied.`); });
      document.querySelectorAll("[data-cmp-del]").forEach(b => b.onclick = () => { S.compare.splice(+b.dataset.cmpDel, 1); store.set("af2-compare", S.compare); Panels.render(); });
      if (A.payloadRange.length) lineChart($("chPR"), {series: [{name: "Range", color: "--s1", pts: A.payloadRange.map(r => [r.payload, r.range])}], yMin: 0, yLabel: "km", xLabel: "payload, g", xUnit: "g payload", fmtY: v => fmt(v, 1) + " km",
        markers: [{x: S.p.payload, y: interpSeries(A.payloadRange.map(r => [r.payload, r.range]), S.p.payload) ?? 0, label: "now"}], vlines: [{x: A.maxPayload, label: "MTOW"}]});
    };
    const st = f.static1, m = A.motor;
    return this.checks(A, S.B) + `
    <section class="sec"><h2>Thrust and drag</h2><div class="chart"><canvas id="chThrust" aria-label="Thrust and drag versus airspeed"></canvas></div></section>
    <section class="sec"><h2>Battery power</h2><div class="chart"><canvas id="chPower" aria-label="Battery power versus airspeed"></canvas></div>
      <dl class="kv">
        <dt>Static thrust (all motors)</dt><dd>${fmt(st.T * A.L.motors.length / G0 * 1000)} g · T/W ${fmt(f.TW, 2)}</dd>
        <dt>Full throttle: pack current</dt><dd>${fmt(st.Ib, 1)} A · ${fmt(A.cRate, 1)} C</dd>
        <dt>Full throttle: per motor</dt><dd>${fmt(st.I, 1)} / ${m.imax} A · ${fmt(st.rpm)} rpm</dd>
        <dt>Prop tip speed</dt><dd>Mach ${fmt(st.tipMach, 2)}</dd>
        ${f.cruise ? `<dt>Cruise throttle · current</dt><dd>${fmt(f.cruise.throttle * 100)}% · ${fmt(f.cruise.Ib, 1)} A</dd><dt>Cruise prop · motor efficiency</dt><dd>${fmt(f.cruise.etaProp * 100)}% · ${fmt(f.cruise.etaMotor * 100)}%</dd>` : ""}
        <dt>Climb rate</dt><dd>${fmt(f.roc, 1)} m/s</dd>
        <dt>Pack</dt><dd>${S.p.cells}S ${fmt(S.p.capacity)} mAh · ${fmt(A.pk.Wh, 1)} Wh · ${fmt(A.battMass)} g</dd>
      </dl></section>
    ${A.nLift ? `<section class="sec"><h2>Hover</h2><dl class="kv">
      <dt>Hover thrust-to-weight</dt><dd>${hov ? fmt(hov.TW, 2) : "—"}</dd>
      ${hov && hov.op ? `<dt>Hover throttle · pack current</dt><dd>${fmt(hov.op.throttle * 100)}% · ${fmt(hov.op.Ib, 1)} A</dd><dt>Hover power</dt><dd>${fmt(hov.op.Pb)} W</dd><dt>Energy for ${S.p.hoverTime} s of hover</dt><dd>${fmt(f.hoverJ / 3600, 1)} Wh</dd>` : "<dt>Hover</dt><dd>not possible</dd>"}
    </dl></section>` : ""}
    <section class="sec"><h2>Maximum takeoff weight</h2><dl class="kv">
      ${A.limits.map(([n, v], i) => `<dt>${i === 0 ? "<b>Limited by</b> " : ""}${esc(n)}</dt><dd>${fmt(v)} g</dd>`).join("")}
      <dt>Max payload at current setup</dt><dd>${fmt(A.maxPayload)} g</dd>
    </dl>
    ${A.payloadRange.length ? `<div class="chart"><canvas id="chPR" aria-label="Range versus payload"></canvas></div>` : ""}
    </section>
    <section class="sec"><h2>Saved setups <span class="count">${S.compare.length}</span></h2>${this.compareTable()}</section>`;
  },
  compareTable() {
    if (!S.compare.length) return `<p class="hint">Use “Save current setup” in the power lab to compare motors, props and batteries side by side.</p>`;
    return `<div class="table-wrap"><table class="parts cmp"><thead><tr><th>Setup</th><th class="num">g</th><th class="num">T/W</th><th class="num">min</th><th class="num">km</th><th></th></tr></thead><tbody>${S.compare.map((c, i) => `<tr><td>${esc(c.label)}</td><td class="num">${fmt(c.mtow)}</td><td class="num">${fmt(c.tw, 2)}</td><td class="num">${fmt(c.end)}</td><td class="num">${fmt(c.range, 1)}</td><td><button class="btn xs" data-cmp-use="${i}">Use</button> <button class="icon-btn" data-cmp-del="${i}" aria-label="Remove">×</button></td></tr>`).join("")}</tbody></table></div>`;
  },
  labTable() {
    const el = $("labTable"); if (!el) return;
    const rows = S.lab.rows;
    if (!rows) { el.innerHTML = ""; return; }
    if (!rows.length) { el.innerHTML = `<p class="hint">No combination passes every limit. Lower the power need (lighter build, larger wing) or allow more cells.</p>`; return; }
    const obj = LAB_OBJ[S.lab.obj];
    el.innerHTML = `<table class="parts"><thead><tr><th>Motor · prop · pack</th><th class="num">${obj.label}</th><th></th></tr></thead><tbody>${rows.slice(0, 15).map((r, i) => `<tr><td>${esc(r.motor)} · ${r.propD}×${r.propP}" · ${r.cells}S ${fmt(r.capacity)}<small>T/W ${fmt(r.tw, 2)} · ${fmt(r.amps)} A · ${fmt(r.endurance)} min · ${fmt(r.range, 1)} km</small></td><td class="num">${obj.fmt(r.score)}</td><td><button class="btn xs" data-lab-use="${i}">Use</button></td></tr>`).join("")}</tbody></table>`;
    el.querySelectorAll("[data-lab-use]").forEach(b => b.onclick = () => { const r = rows[+b.dataset.labUse]; Object.assign(S.p, {motorId: r.motorId, propD: r.propD, propP: r.propP, cells: r.cells, capacity: r.capacity}); Left.sync(); App.changed("motorId", true); toast(`${r.motor}, ${r.propD}×${r.propP}", ${r.cells}S ${fmt(r.capacity)} mAh applied.`); });
  },

  /* ---------------- Aerodynamics ---------------- */
  aero(A) {
    const ae = A.aero, f = A.perf, W = A.L.wing, p = S.p;
    const V = f.cruise ? f.cruise.V : 15, S_m2 = W.S;
    const stall = f.stallAlpha / D2R;
    const alphas = []; for (let a = -4; a <= Math.min(16, stall + 3); a += 0.5) alphas.push(a);
    const itR = A.trim.tailed ? A.trim.it * D2R : 0;
    const polar = alphas.map(a => {
      const al = a * D2R, CL = ae.CL0 + ae.CLa * al + ae.CLt * itR, cdi = ae.cdi[0] + ae.cdi[1] * al + ae.cdi[2] * al * al;
      const cdp = profileCD(ae, A.rho, V, al, itR) + (A.parasiteAt(V) * 1.08 + A.fixedF) / S_m2;
      const CD = p.kDrag * (cdp + cdi), Cm = ae.Cm0 + ae.Cma * al + ae.Cmt * itR + A.xcg / W.mac * CL;
      return {a, CL, CD, cdi: p.kDrag * cdi, cdp: p.kDrag * cdp, LD: CL / CD, Cm};
    });
    const aSel = S.alphaCustom ? S.alphaDeg * D2R : f.cruise ? f.cruise.alpha : 4 * D2R;
    const wingStrips = ae.strips.filter(s => s.kind === "wing").sort((a, b) => a.y - b.y);
    const loadPts = wingStrips.map(st => [st.y / W.half, stripCl(st, aSel)]);
    const clmPts = wingStrips.map(st => [st.y / W.half, stripFoilCl(st, A.rho * V * st.c / 1000 / MU_AIR)]);
    const stSel = wingStrips.reduce((b, s) => Math.abs(s.y / W.half - S.cpStation) < Math.abs(b.y / W.half - S.cpStation) ? s : b, wingStrips[0]);
    const foil = stSel.S0.s > 0.5 ? stSel.S0.fB : stSel.S0.fA, clSel = stripCl(stSel, aSel), a2d = panelAlphaForCl(foil, clSel), cp = panelCp(foil, a2d), P = panelSolve(foil);
    const half = P.N / 2 | 0, lower = [], upper = [];
    P.xc.forEach((x, i) => (i < half ? lower : upper).push([x, -cp[i]]));
    lower.sort((a, b) => a[0] - b[0]); upper.sort((a, b) => a[0] - b[0]);
    const cool = coolingEstimate(A);
    this.after = () => {
      lineChart($("chCL"), {series: [{name: "CL", color: "--s1", pts: polar.map(r => [r.a, r.CL])}], xLabel: "α, °", yLabel: "CL", xUnit: "°", fmtY: v => fmt(v, 2), vlines: [{x: stall, label: "stall onset"}]});
      lineChart($("chPolar"), {series: [{name: "Total CD", short: "Total", color: "--s1", pts: polar.map(r => [r.CL, r.CD]).sort((a, b) => a[0] - b[0])}, {name: "Profile + parasite", short: "Profile", color: "--s2", pts: polar.map(r => [r.CL, r.cdp]).sort((a, b) => a[0] - b[0])}, {name: "Induced", short: "Induced", color: "--s3", pts: polar.map(r => [r.CL, r.cdi]).sort((a, b) => a[0] - b[0])}],
        yMin: 0, xLabel: "CL", yLabel: "CD", xUnit: "CL", fmtY: v => fmt(v, 4)});
      lineChart($("chLD"), {series: [{name: "L/D", color: "--s1", pts: polar.filter(r => r.CL > 0.05).map(r => [r.CL, r.LD])}], xLabel: "CL", yLabel: "L/D", xUnit: "CL", fmtY: v => fmt(v, 1)});
      lineChart($("chCm"), {series: [{name: "Cm about the CG", color: "--s1", pts: polar.map(r => [r.a, r.Cm])}], xLabel: "α, °", yLabel: "Cm", xUnit: "°", fmtY: v => fmt(v, 3)});
      lineChart($("chLoad"), {series: [{name: "Local cl", short: "cl", color: "--s1", pts: loadPts}, {name: "Section cl max", short: "cl max", color: "--s2", dash: true, pts: clmPts}], xMin: 0, xMax: 1, yMin: 0, xLabel: "2y/b", yLabel: "cl", xUnit: "of half span", fmtY: v => fmt(v, 2)});
      lineChart($("chCp"), {series: [{name: "Upper surface", short: "Upper", color: "--s1", pts: upper}, {name: "Lower surface", short: "Lower", color: "--s2", pts: lower}], xMin: 0, xMax: 1, xLabel: "x/c", yLabel: "−Cp", xUnit: "x/c", fmtY: v => fmt(v, 2)});
    };
    const trim = A.trim;
    return `
    <section class="sec"><h2>Coefficients</h2><dl class="kv">
      <dt>Lift slope CLα</dt><dd>${fmt(ae.CLa, 3)} /rad</dd>
      <dt>Zero-lift CL0 · Cm0 (nose)</dt><dd>${fmt(ae.CL0, 3)} · ${fmt(ae.Cm0, 3)}</dd>
      <dt>Span efficiency e</dt><dd>${fmt(ae.e, 3)}</dd>
      <dt>Neutral point</dt><dd>${fmt(A.xnp - A.L.xw)} mm from LE · ${fmt(A.hnp * 100, 1)}% MAC</dd>
      <dt>CL max · stall onset</dt><dd>${fmt(f.CLmax, 2)} at ${fmt(stall, 1)}° · ${fmt(f.stallY / W.half * 100)}% span</dd>
      ${trim.tailed ? `<dt>Stabilizer incidence for cruise trim</dt><dd>${fmt(trim.it, 2)}°</dd>` : `<dt>Trims hands-off at</dt><dd>CL ${fmt(trim.CL, 2)} · ${isFinite(trim.V) ? fmt(trim.V, 1) + " m/s" : "no positive-lift trim"}</dd><dt>Elevon trim at cruise</dt><dd>${fmt(trim.elevon, 1)}° ${trim.elevon < 0 ? "up" : "down"}</dd>`}
      <dt>Cruise Reynolds number (MAC)</dt><dd>${fmt(A.rho * V * W.mac / 1000 / MU_AIR / 1000)}k</dd>
    </dl></section>
    <section class="sec"><h2>Lift curve</h2><div class="chart"><canvas id="chCL" aria-label="Lift coefficient versus angle of attack"></canvas></div></section>
    <section class="sec"><h2>Drag polar</h2><div class="chart"><canvas id="chPolar" aria-label="Drag coefficient versus lift coefficient"></canvas></div></section>
    <section class="sec"><h2>Lift-to-drag ratio</h2><div class="chart"><canvas id="chLD" aria-label="Lift-to-drag ratio versus lift coefficient"></canvas></div></section>
    <section class="sec"><h2>Pitching moment</h2><div class="chart"><canvas id="chCm" aria-label="Pitching moment about the CG versus angle of attack"></canvas></div>
      <p class="hint">${trim.tailed ? `With ${fmt(trim.it, 1)}° stabilizer incidence.` : "Neutral elevons."} A downward slope means the aircraft is statically stable.</p></section>
    <section class="sec"><h2>Span loading at ${fmt(aSel / D2R, 1)}°</h2><div class="chart"><canvas id="chLoad" aria-label="Local lift coefficient and section maximum along the span"></canvas></div>
      <p class="hint">Where the solid line meets the dashed line, that section stalls first.</p></section>
    <section class="sec"><h2>Section pressure at ${fmt(stSel.y / W.half * 100)}% span</h2><div class="chart"><canvas id="chCp" aria-label="Pressure coefficient over the upper and lower surface"></canvas></div>
      <p class="hint">${esc(foil.name)}, local cl ${fmt(clSel, 2)} (inviscid panel method).</p></section>
    ${cool ? `<section class="sec"><h2>Cooling ports (potential flow)</h2><dl class="kv">
      ${cool.ports.map(pt => `<dt>${pt.kind === "intake" ? "Intake" : "Exhaust"} surface Cp</dt><dd>${fmt(pt.cp, 2)}</dd>`).join("")}
      ${cool.dCp != null ? `<dt>Driving pressure (ΔCp incl. ram)</dt><dd>${fmt(cool.dCp, 2)}</dd><dt>Cooling air flow</dt><dd>${fmt(cool.flowLs, 2)} L/s</dd><dt>Heat removed at 15 K rise</dt><dd>${fmt(cool.heatRemoved)} W</dd><dt>ESC + battery heat at cruise</dt><dd>${fmt(cool.heatLoad, 1)} W</dd>` : ""}
    </dl>
    ${cool.dCp != null ? `<div class="alert ${cool.dCp <= 0 ? "bad" : cool.heatRemoved < cool.heatLoad ? "warn" : "ok"}"><span class="pill">${cool.dCp <= 0 ? "fail" : cool.heatRemoved < cool.heatLoad ? "check" : "pass"}</span><span>${cool.dCp <= 0 ? "The exhaust sits at higher pressure than the intake, so air will not flow. Drag the exhaust aft or into a suction region (blue in the pressure view)." : cool.heatRemoved < cool.heatLoad ? "Flow is too small for the heat load; enlarge the intake or the exhaust area." : "Intake and exhaust placement drives enough cooling flow."}</span></div>` : ""}
    <p class="hint">Switch the surface coloring to Pressure and drag the markers: blue is suction (good for exhausts), orange is stagnation pressure (good for intakes). Confirm with viscous CFD.</p></section>` : ""}`;
  },

  /* ---------------- Balance ---------------- */
  bal(A) {
    const W = A.L.wing, xw = A.L.xw, p = S.p;
    const fwd = A.xnp - 0.2 * W.mac - xw, aft = A.xnp - 0.04 * W.mac - xw;
    this.after = () => cgStrip($("chCG"), {fwd, aft, np: A.xnp - xw, target: A.xTarget - xw, actual: A.xcg - xw, mac0: W.xMacLE - xw, mac1: W.xMacLE - xw + W.mac, ok: Math.abs(A.smActual - p.staticMargin) < 3});
    const rows = [...A.items].sort((a, b) => a.x - b.x);
    return `
    <section class="sec"><h2>Center of gravity</h2><div class="chart"><canvas id="chCG" class="strip" aria-label="CG position against the neutral point and the stable range"></canvas></div>
      <p class="hint">Green band: 4–20% static margin. Grey bar: mean aerodynamic chord. Positions in mm from the wing root leading edge.</p>
      <dl class="kv">
        <dt>Actual CG</dt><dd><b>${fmt(A.xcg - xw)} mm</b> · ${fmt(A.smActual, 1)}% margin</dd>
        <dt>Target CG (${p.staticMargin}% margin)</dt><dd>${fmt(A.xTarget - xw)} mm</dd>
        <dt>Neutral point</dt><dd>${fmt(A.xnp - xw)} mm</dd>
        <dt>Battery for the target</dt><dd>${fmt(A.battXNeeded)} mm (now ${fmt(p.battX)} mm)</dd>
      </dl></section>
    ${this.checks(A, S.B)}
    <section class="sec"><h2>Mass items</h2><div class="table-wrap"><table class="parts"><thead><tr><th>Item</th><th class="num">g</th><th class="num">mm</th><th class="num">g·m</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${fmt(r.mass)}</td><td class="num">${fmt(r.x - xw)}</td><td class="num">${fmt(r.mass * (r.x - A.xcg) / 1000, 1)}</td></tr>`).join("")}
      <tr class="total"><td>Total</td><td class="num">${fmt(A.mtow)}</td><td class="num">${fmt(A.xcg - xw)}</td><td></td></tr>
    </tbody></table></div></section>`;
  },

  /* ---------------- Mission optimizer ---------------- */
  opt() {
    const st = S.opt.state;
    this.after = () => {
      const obj = OPT_OBJ[S.m.oObjective];
      if (st && st.hist.some(v => v != null)) {
        const h = st.hist.map((v, i) => [i + 1, v]).filter(q => q[1] != null).map(q => [q[0], obj.sign * q[1]]);
        lineChart($("chConv"), {series: [{name: obj.label, color: "--s2", pts: h}], xMin: 1, xMax: Math.max(2, S.m.rGens), xLabel: "generation", yLabel: obj.label, xUnit: "generation", fmtY: v => obj.show(obj.sign * v)});
      }
      if (st && st.cloud.length) scatterChart($("chCloud"), {pts: st.cloud, best: st.best && st.best.feasible ? [st.best.A.mtow, st.best.A.perf.endurance] : null, xLabel: "takeoff mass, g", yLabel: "endurance, min", fmt: q => `${fmt(q[0])} g · ${fmt(q[1])} min`});
    };
    const b = st && st.best && st.best.feasible ? st.best : null;
    return `<section class="sec"><h2>Search</h2>
      <div class="chart"><canvas id="chConv" aria-label="Best objective per generation"></canvas></div>
      <div class="chart"><canvas id="chCloud" aria-label="Feasible designs: takeoff mass versus endurance"></canvas></div>
      <p class="hint">${st ? `${fmt(st.cloud.length)} designs met every requirement. Orange marks the best.` : "Charts appear once the optimizer runs."}</p></section>
      ${b ? `<section class="sec"><h2>Best design</h2><dl class="kv">
        <dt>Span · aspect ratio · taper</dt><dd>${fmt(b.p.span)} mm · ${fmt(b.A.L.wing.AR, 1)} · ${fmt(b.p.taper, 2)}</dd>
        <dt>Airfoils</dt><dd>${esc(b.A.L.wing.fRoot.name)} → ${esc(b.A.L.wing.fTip.name)}</dd>
        <dt>Powertrain</dt><dd>${esc(b.A.motor.name)} · ${b.p.propD}×${b.p.propP}" · ${b.p.cells}S ${fmt(b.p.capacity)} mAh</dd>
        <dt>Takeoff mass · stall</dt><dd>${fmt(b.A.mtow)} g · ${fmt(b.A.perf.Vs, 1)} m/s</dd>
        <dt>Cruise · endurance · range</dt><dd>${fmt(b.A.perf.cruise.V, 1)} m/s · ${fmt(b.A.perf.endurance)} min · ${fmt(b.A.perf.range, 1)} km</dd>
      </dl></section>` : ""}`;
  },

  drawFoil() {
    const cv = $("foilCanvas"); if (!cv || !S.A) return;
    const {g, w, h} = sizeCanvas(cv), A = S.A, fr = A.L.wing.fRoot, ft = A.L.wing.fTip;
    g.clearRect(0, 0, w, h);
    const pad = 10, sc = w - pad * 2, cy = h / 2 + 6, X = x => pad + x * sc, Y = y => cy - y * sc;
    g.strokeStyle = css("--rule"); g.setLineDash([3, 3]); g.lineWidth = 1; g.beginPath(); g.moveTo(X(0), cy); g.lineTo(X(1), cy); g.stroke(); g.setLineDash([]);
    const outline = (f, stroke, fill, dash) => {
      g.beginPath();
      for (let i = 0; i <= K; i++) (i ? g.lineTo : g.moveTo).call(g, X(XG[i]), Y(f.yu[i]));
      for (let i = K; i >= 0; i--) g.lineTo(X(XG[i]), Y(f.yl[i]));
      g.closePath(); g.setLineDash(dash || []); if (fill) { g.fillStyle = fill; g.fill(); }
      g.strokeStyle = stroke; g.lineWidth = dash ? 1 : 1.5; g.stroke(); g.setLineDash([]);
    };
    if (ft.id !== fr.id) outline(ft, css("--muted"), null, [4, 3]);
    outline(fr, css("--ink"), css("--accent-soft"));
    for (const t of A.tubes) { g.beginPath(); g.arc(X(t.pos), Y(midAt(fr, t.pos)), Math.max(2, t.tube[0] / 2 / A.L.wing.cr * sc), 0, Math.PI * 2); g.fillStyle = css("--carbon"); g.fill(); }
    if (S.p.ctrlSurf) { g.strokeStyle = css("--s2"); g.lineWidth = 1.5; g.beginPath(); g.moveTo(X(S.p.hingePos), Y(interpY(XG, fr.yu, S.p.hingePos)) - 2); g.lineTo(X(S.p.hingePos), Y(interpY(XG, fr.yl, S.p.hingePos)) + 2); g.stroke(); }
    $("foilStats").innerHTML = [["t/c", fmt(fr.t * 100, 1) + "%"], ["camber", fmt(fr.camber * 100, 1) + "%"], ["α₀L", fmt(fr.aL0 / D2R, 1) + "°"], ["Cm¼", fmt(fr.cm0, 3)]].map(([k, v]) => `<div><span>${k}</span>${v}</div>`).join("");
  },
};
