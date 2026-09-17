"use strict";
/* ==========================================================================
   UI state, persistence and the left-hand control panels.
   ========================================================================== */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const fmt = fmtN;
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
};
let toastTimer;
function toast(msg) {
  let t = document.querySelector(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3600);
}

const S = {
  p: defaultParams(), m: defaultMission(), tab: "air", color: "parts", alphaCustom: false, alphaDeg: 4, cpStation: 0.3,
  A: null, B: null, lab: {obj: "range", rows: null, running: false, progress: 0}, opt: {running: false, state: null, cands: null},
  compare: [], importedDat: [], open: {},
};
function loadState() {
  const saved = store.get("af2-p"), savedM = store.get("af2-m");
  if (!saved) { Object.assign(S.p, TEMPLATES[0].p, {template: TEMPLATES[0].id}); S.firstRun = true; }
  for (const d of store.get("af2-foils") || []) { try { const f = parseDat(d.text, d.name); f.id = d.id; addFoil(f); S.importedDat.push(d); } catch (e) { /* skip broken import */ } }
  if (saved) for (const k in S.p) if (k in saved && (typeof saved[k] === typeof S.p[k] || (k === "components" && Array.isArray(saved[k])))) S.p[k] = saved[k];
  if (savedM) for (const k in S.m) if (k in savedM && typeof savedM[k] === typeof S.m[k]) S.m[k] = savedM[k];
  for (const k of ["foilRoot", "foilTip", "foilTail"]) if (!FOILS[S.p[k]]) S.p[k] = defaultParams()[k];
  S.compare = store.get("af2-compare") || [];
  S.open = store.get("af2-open") || {};
}
function saveState() { store.set("af2-p", S.p); store.set("af2-m", S.m); }

/* ---------------- field widgets ---------------- */
function fieldRow(f, obj, onInput, onChange) {
  const row = document.createElement("div");
  row.className = "fld"; row.dataset.field = f.id;
  const hint = f.hint ? `<p class="hint">${esc(f.hint)}</p>` : "";
  if (f.kind === "num") {
    row.innerHTML = `<label for="f_${f.id}">${esc(f.label)}</label><div class="num"><input type="number" id="f_${f.id}" min="${f.min}" max="${f.max}" step="${f.step}"><span class="u">${esc(f.unit || "")}</span></div><input type="range" id="f_${f.id}_r" min="${f.min}" max="${f.max}" step="${f.step}" aria-label="${esc(f.label)}">${hint}`;
    const num = row.querySelector("input[type=number]"), rng = row.querySelector("input[type=range]");
    const set = (v, src, final) => {
      v = Math.min(f.max, Math.max(f.min, +v)); if (!isFinite(v)) return;
      obj[f.id] = v; if (src !== num) num.value = v; if (src !== rng) rng.value = v;
      (final ? onChange : onInput)(f.id);
    };
    num.addEventListener("change", () => set(num.value, num, true));
    rng.addEventListener("input", () => set(rng.value, rng, false));
    rng.addEventListener("change", () => set(rng.value, rng, true));
    row._sync = () => { num.value = rng.value = obj[f.id]; };
  } else if (f.kind === "sel") {
    row.innerHTML = `<label for="f_${f.id}">${esc(f.label)}</label><select id="f_${f.id}"></select>${hint}`;
    const sel = row.querySelector("select");
    row._sync = () => {
      const opts = typeof f.options === "function" ? f.options() : f.options;
      sel.innerHTML = opts.map(([v, n]) => `<option value="${esc(v)}">${esc(n)}</option>`).join("");
      sel.value = obj[f.id];
    };
    sel.addEventListener("change", () => { obj[f.id] = sel.value; onChange(f.id); });
  } else if (f.kind === "bool") {
    row.classList.add("fld-bool");
    row.innerHTML = `<label class="switch" for="f_${f.id}"><input type="checkbox" id="f_${f.id}"><span>${esc(f.label)}</span></label>${hint}`;
    const cb = row.querySelector("input");
    row._sync = () => { cb.checked = !!obj[f.id]; };
    cb.addEventListener("change", () => { obj[f.id] = cb.checked; onChange(f.id); });
  } else if (f.kind === "text") {
    row.innerHTML = `<label for="f_${f.id}">${esc(f.label)}</label><input type="text" id="f_${f.id}" class="txt" spellcheck="false" placeholder="e.g. 240, 500">${hint}`;
    const tx = row.querySelector("input");
    row._sync = () => { tx.value = obj[f.id] || ""; };
    tx.addEventListener("change", () => { obj[f.id] = tx.value; onChange(f.id); });
  }
  row._show = f.show;
  row._sync();
  return row;
}
const foilOptions = sym => Object.values(FOILS).filter(f => sym == null || f.symmetric === sym || !sym)
  .sort((a, b) => a.symmetric - b.symmetric || a.name.localeCompare(b.name)).map(f => [f.id, f.name + (f.symmetric ? " (sym.)" : f.reflex ? " (reflex)" : "")]);

/* ---------------- left panel ---------------- */
const Left = {
  rows: [],
  render() {
    const el = $("left"), tab = S.tab;
    el.innerHTML = ""; this.rows = [];
    for (const [gid, title] of GROUPS[tab]) {
      const det = document.createElement("details");
      det.className = "grp"; det.open = S.open[tab + gid] ?? ["cfg", "foils", "wing", "motor", "batt", "solver", "bal", "comps", "mission", "objective", "run"].includes(gid);
      det.innerHTML = `<summary>${esc(title)}</summary><div class="grp-body"></div>`;
      det.addEventListener("toggle", () => { S.open[tab + gid] = det.open; store.set("af2-open", S.open); });
      const body = det.querySelector(".grp-body");
      const custom = this.custom[gid];
      if (custom) custom.call(this, body);
      const src = tab === "opt" ? MISSION_SCHEMA : SCHEMA, obj = tab === "opt" ? S.m : S.p;
      for (const f of src.filter(q => q.tab === tab && q.group === gid)) {
        const row = fieldRow(f, obj, id => App.changed(id, false), id => App.changed(id, true));
        body.appendChild(row); this.rows.push(row);
      }
      if (this.after[gid]) this.after[gid].call(this, body);
      el.appendChild(det);
    }
    this.refresh();
  },
  refresh() {
    const obj = S.tab === "opt" ? S.m : S.p;
    for (const r of this.rows) { r.hidden = r._show ? !r._show(obj) : false; }
    const reqU = document.querySelector('[data-field="mReqValue"] .u');
    if (reqU) reqU.textContent = S.m.mReqType === "range" ? "km" : "min";
  },
  sync() { this.rows.forEach(r => r._sync && r._sync()); this.refresh(); },
  custom: {
    cfg(body) {
      const wrap = document.createElement("div");
      wrap.className = "tpl";
      wrap.innerHTML = `<p class="hint">Start from an archetype, then adjust everything below.</p><div class="tpl-grid">${TEMPLATES.map(t => `<button class="tpl-card${S.p.template === t.id ? " on" : ""}" data-tpl="${t.id}" title="${esc(t.desc)}"><b>${esc(t.name)}</b><span>${esc(t.desc)}</span></button>`).join("")}</div>`;
      wrap.addEventListener("click", e => { const b = e.target.closest("[data-tpl]"); if (b) App.applyTemplate(b.dataset.tpl); });
      body.appendChild(wrap);
    },
    foils(body) {
      const rows = [["foilRoot", "Wing root", null], ["foilTip", "Wing tip", null], ["foilTail", "Tail surfaces", true]];
      for (const [id, label, sym] of rows) {
        const f = {kind: "sel", id, label, options: () => foilOptions(sym), show: id === "foilTail" ? p => p.tailType !== "none" || p.tipFins : null};
        const row = fieldRow(f, S.p, () => {}, id2 => App.changed(id2, true)); body.appendChild(row); this.rows.push(row);
      }
      const card = document.createElement("div");
      card.className = "foil-card";
      card.innerHTML = `<canvas id="foilCanvas" aria-label="Root and tip airfoil sections with spar bores"></canvas><div class="foil-stats" id="foilStats"></div>`;
      body.appendChild(card);
      const add = document.createElement("div");
      add.className = "foil-add";
      add.innerHTML = `<div class="fld"><label for="nacaIn">Add NACA 4- or 5-digit</label><div class="num"><input id="nacaIn" type="text" class="txt short" value="23112"><button class="btn sm" id="nacaAdd">Add</button></div></div>
        <p class="hint">5-digit codes with a 1 in the middle (e.g. 23112) are reflexed for flying wings. Or paste Selig/Lednicer coordinates from the UIUC database:</p>
        <textarea id="datIn" placeholder="MH 60&#10;1.00000 0.00000&#10;0.99000 0.00150&#10;..."></textarea>
        <div class="row-btns"><button class="btn sm" id="datAdd">Import coordinates</button><label class="btn sm" for="datFile">Load .dat file</label><input id="datFile" type="file" accept=".dat,.txt" hidden></div>`;
      body.appendChild(add);
      add.querySelector("#nacaAdd").onclick = () => {
        const f = nacaFoil(add.querySelector("#nacaIn").value);
        if (!f) { toast("Enter a NACA 4-digit code (2412) or 5-digit code (23012, reflexed 23112)."); return; }
        addFoil(f); S.p.foilRoot = f.id; Left.sync(); App.changed("foilRoot", true); toast(`${f.name} added as the root airfoil.`);
      };
      const importDat = (text, name) => {
        try {
          const f = addFoil(parseDat(text, name)); S.importedDat.push({id: f.id, name: f.name, text}); store.set("af2-foils", S.importedDat);
          S.p.foilRoot = f.id; Left.sync(); App.changed("foilRoot", true);
          toast(`${f.name}: ${fmt(f.t * 100, 1)}% thick, ${fmt(f.camber * 100, 1)}% camber, Cm ${fmt(f.cm0, 3)}.`);
        } catch (e) { toast(e.message); }
      };
      add.querySelector("#datAdd").onclick = () => importDat(add.querySelector("#datIn").value);
      add.querySelector("#datFile").onchange = e => { const file = e.target.files[0]; if (file) file.text().then(t => importDat(t, file.name.replace(/\.\w+$/, ""))); };
    },
    lab(body) {
      body.innerHTML = `<p class="hint">Ranks every motor class, propeller and cell count for this airframe with the stored battery energy held constant. Rows that break a current, C-rate, tip-speed or thrust limit are dropped.</p>
        <div class="fld"><label for="labObj">Rank by</label><select id="labObj">${Object.entries(LAB_OBJ).map(([k, v]) => `<option value="${k}"${S.lab.obj === k ? " selected" : ""}>${v.label}</option>`).join("")}</select></div>
        <div class="row-btns"><button class="btn primary sm" id="labRun">Rank combinations</button><button class="btn sm" id="labSave">Save current setup</button></div>
        <div class="progress"><div id="labProg"></div></div><div id="labTable" class="lab-table"></div>`;
      body.querySelector("#labObj").onchange = e => { S.lab.obj = e.target.value; };
      body.querySelector("#labRun").onclick = () => App.runLab();
      body.querySelector("#labSave").onclick = () => App.saveCompare();
      Panels.labTable();
    },
    solver(body) {
      body.innerHTML = `<div class="fld"><label>Surface coloring</label><div class="seg" role="group" aria-label="Surface coloring">
          ${[["parts", "Parts"], ["pressure", "Pressure"], ["stall", "Stall margin"]].map(([k, n]) => `<button data-color="${k}" aria-pressed="${S.color === k}">${n}</button>`).join("")}</div></div>
        <label class="switch"><input type="checkbox" id="alphaCustom"${S.alphaCustom ? " checked" : ""}><span>Set angle of attack (otherwise cruise)</span></label>
        <div class="fld" id="alphaRow"${S.alphaCustom ? "" : " hidden"}><label for="alphaDeg">Angle of attack</label><div class="num"><input type="number" id="alphaDeg" min="-6" max="16" step="0.5" value="${S.alphaDeg}"><span class="u">°</span></div><input type="range" id="alphaDegR" min="-6" max="16" step="0.5" value="${S.alphaDeg}" aria-label="Angle of attack"></div>
        <div class="fld"><label for="cpStation">Section for the Cp chart</label><div class="num"><input type="number" id="cpStation" min="0" max="0.95" step="0.05" value="${S.cpStation}"><span class="u">÷ b/2</span></div></div>
        <p class="hint">Vortex lattice for the lifting surfaces, a linear-vortex panel method for sections and a slender-body source model for the fuselage. All potential flow: use it to compare options, then confirm with viscous CFD using the exported assembly STL or AVL file.</p>`;
      body.querySelectorAll("[data-color]").forEach(b => b.onclick = () => { S.color = b.dataset.color; body.querySelectorAll("[data-color]").forEach(q => q.setAttribute("aria-pressed", q === b)); App.recolor(); });
      const aNum = body.querySelector("#alphaDeg"), aR = body.querySelector("#alphaDegR");
      body.querySelector("#alphaCustom").onchange = e => { S.alphaCustom = e.target.checked; body.querySelector("#alphaRow").hidden = !S.alphaCustom; App.recolor(); Panels.render(); };
      const setA = v => { S.alphaDeg = +v; aNum.value = aR.value = v; App.recolor(); Panels.render(); };
      aNum.onchange = () => setA(aNum.value); aR.oninput = () => setA(aR.value);
      body.querySelector("#cpStation").onchange = e => { S.cpStation = Math.min(0.95, Math.max(0, +e.target.value)); Panels.render(); };
    },
    cal(body) {
      body.innerHTML = `<p class="hint">Enter what you measured on the finished aircraft. The model scales its structure mass, drag and power so every prediction matches, and keeps the correction for future edits.</p>
        <div class="fld"><label for="calMass">Flying weight</label><div class="num"><input type="number" id="calMass" placeholder="g"><span class="u">g</span></div></div>
        <div class="fld"><label for="calV">Cruise speed flown</label><div class="num"><input type="number" id="calV" placeholder="m/s"><span class="u">m/s</span></div></div>
        <div class="fld"><label for="calI">Battery current at that speed</label><div class="num"><input type="number" id="calI" placeholder="A"><span class="u">A</span></div></div>
        <div class="fld"><label for="calGlide">Measured glide ratio (optional)</label><div class="num"><input type="number" id="calGlide" placeholder="L/D"><span class="u"></span></div></div>
        <div class="row-btns"><button class="btn sm primary" id="calApply">Apply calibration</button><button class="btn sm" id="calReset">Reset</button></div>`;
      body.querySelector("#calApply").onclick = () => App.calibrate({mass: +body.querySelector("#calMass").value, V: +body.querySelector("#calV").value, I: +body.querySelector("#calI").value, glide: +body.querySelector("#calGlide").value});
      body.querySelector("#calReset").onclick = () => { Object.assign(S.p, {kDrag: 1, kPower: 1, kMass: 1}); Left.sync(); App.changed("kMass", true); toast("Calibration reset to the uncorrected model."); };
    },
    comps(body) {
      const draw = () => {
        body.innerHTML = `<p class="hint">Positions are mm from the wing root leading edge; negative is forward. Leave position empty to place the item in the nose.</p>
          <table class="comps"><thead><tr><th>Item</th><th>g</th><th>mm</th><th></th></tr></thead><tbody>${S.p.components.map((c, i) => `<tr>
            <td><input type="text" class="txt" data-i="${i}" data-k="name" value="${esc(c.name)}" aria-label="Item name"></td>
            <td><input type="number" data-i="${i}" data-k="mass" value="${c.mass}" aria-label="${esc(c.name)} mass"></td>
            <td><input type="number" data-i="${i}" data-k="x" value="${c.x == null ? "" : c.x}" placeholder="nose" aria-label="${esc(c.name)} position"></td>
            <td><button class="icon-btn" data-del="${i}" aria-label="Remove ${esc(c.name)}">×</button></td></tr>`).join("")}</tbody></table>
          <div class="row-btns"><button class="btn sm" id="compAdd">Add item</button><button class="btn sm primary" id="battAuto">Balance with the battery</button></div>`;
        body.querySelectorAll("input[data-i]").forEach(inp => inp.onchange = () => {
          const c = S.p.components[+inp.dataset.i], k = inp.dataset.k;
          c[k] = k === "name" ? inp.value : inp.value === "" && k === "x" ? null : +inp.value;
          App.changed("components", true);
        });
        body.querySelectorAll("[data-del]").forEach(b => b.onclick = () => { S.p.components.splice(+b.dataset.del, 1); draw(); App.changed("components", true); });
        body.querySelector("#compAdd").onclick = () => { S.p.components.push({name: "New item", mass: 10, x: 0}); draw(); App.changed("components", true); };
        body.querySelector("#battAuto").onclick = () => App.autoBalance();
      };
      draw();
    },
    run(body) {
      const cands = S.opt.cands || Object.values(FOILS).filter(f => !f.symmetric).map(f => f.id);
      S.opt.cands = cands;
      body.innerHTML = `<p class="hint">Keeps the current configuration (wing type, tail, fuselage, VTOL) and searches span, aspect ratio, taper, airfoils, battery${S.m.oPower ? ", motor and propeller" : ""} to meet the mission. Battery position is balanced for every candidate.</p>
        <div><p class="hint" style="margin-bottom:6px">Candidate wing airfoils</p><div class="chips">${Object.values(FOILS).filter(f => !f.symmetric).map(f => `<label class="chip"><input type="checkbox" value="${esc(f.id)}"${cands.includes(f.id) ? " checked" : ""}>${esc(f.name)}</label>`).join("")}</div></div>
        <div class="row-btns"><button class="btn primary sm" id="optRun">Run optimizer</button><button class="btn sm" id="optStop" disabled>Stop</button><button class="btn sm" id="optUse" disabled>Use best design</button></div>
        <div class="progress"><div id="optProg"></div></div><div class="opt-status" id="optStatus">Set the mission, then run.</div>`;
      body.querySelector(".chips").onchange = () => { S.opt.cands = [...body.querySelectorAll(".chips input:checked")].map(i => i.value); };
      body.querySelector("#optRun").onclick = () => App.runOpt();
      body.querySelector("#optStop").onclick = () => { S.opt.running = false; };
      body.querySelector("#optUse").onclick = () => App.useBest();
    },
  },
  after: {},
};
