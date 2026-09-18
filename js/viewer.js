"use strict";
/* ==========================================================================
   3D viewer: parts, overlays (spars, booms, motors, props, CG), surface
   coloring (parts / pressure / stall margin), part hover and draggable
   intake, exhaust and hatch markers. Aircraft frame z-up is rotated to
   three.js y-up by the root group.
   ========================================================================== */
const Viewer = (() => {
  let host, renderer, scene, camera, controls, root, model, overlay, markers, grid;
  let fitR = 1000, center = new THREE.Vector3(), framed = false, A = null, B = null, mode = "parts", alphaDeg = null;
  let dragCb = null, hoverCb = null, dragging = null, lastHover = 0;
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const col = name => new THREE.Color(css(name) || "#888");

  function init(el, opts) {
    host = el; dragCb = opts.onDrag; hoverCb = opts.onHover;
    try { renderer = new THREE.WebGLRenderer({antialias: true, alpha: true, preserveDrawingBuffer: true}); }
    catch (e) { host.innerHTML = `<div class="nogl">3D preview needs WebGL, which this browser has turned off. Analysis and STL export still work.</div>`; return false; }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    host.appendChild(renderer.domElement);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(35, 1, 5, 80000);
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.addEventListener("change", render);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 0.7); sun.position.set(-0.6, 1, 0.8); scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.25); fill.position.set(0.7, -0.4, -0.6); scene.add(fill);
    root = new THREE.Group(); root.rotation.x = -Math.PI / 2; scene.add(root);
    new ResizeObserver(resize).observe(host);
    const cv = renderer.domElement;
    cv.addEventListener("pointerdown", onDown);
    cv.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return true;
  }
  function resize() {
    if (!renderer) return;
    const r = host.getBoundingClientRect();
    renderer.setSize(Math.max(1, r.width), Math.max(1, r.height), false);
    camera.aspect = Math.max(1, r.width) / Math.max(1, r.height); camera.updateProjectionMatrix(); render();
  }
  function render() { if (renderer) renderer.render(scene, camera); }
  const dispose = obj => obj && obj.traverse(o => { o.geometry && o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); });

  /* ---------------- coloring ---------------- */
  const GROUP_COLOR = {wing: "--part-a", tail: "--part-a", fuse: "--part-a", ctrl: "--part-ctrl", mount: "--part-mount", vtol: "--part-vtol", cool: "--part-cool", jig: "--part-b", custom: "--part-user"};
  /* parts that come off the airframe again — hatches, covers, the swappable nose and pods —
     read as one family, apart from the moving control surfaces and from the glued structure */
  const OPEN_PART = /^(?:[a-z]+_)?(fpv_nose|fpv_canopy|underslung_pod|battery_hatch|avionics_hatch|servo_cover)(_[LR]|_\d+)*$/;
  const partColor = pt => OPEN_PART.test(pt.name) ? "--part-open" : GROUP_COLOR[pt.group] || "--part-a";
  function cpColor(cp, out) {
    const neg = col("--s1"), pos = col("--s2"), mid = col("--part-a");
    const t = Math.max(-1, Math.min(1, cp < 0 ? cp / 1.5 : cp));
    out.copy(mid).lerp(t < 0 ? neg : pos, Math.abs(t));
    return out;
  }
  function stallColor(r, out) {
    const lo = col("--part-a"), hiC = col("--s2"), bad = col("--bad");
    if (r >= 0.95) return out.copy(bad);
    return out.copy(lo).lerp(hiC, Math.max(0, Math.min(1, (r - 0.3) / 0.65)));
  }
  function wingStripData() {
    const aero = A.aero, cruise = A.perf.cruise;
    const alpha = alphaDeg != null ? alphaDeg * D2R : cruise ? cruise.alpha : 4 * D2R;
    const V = cruise ? cruise.V : 15;
    return aero.strips.filter(s => s.kind === "wing").map(st => {
      const cl = stripCl(st, alpha), Re = A.rho * V * st.c / 1000 / MU_AIR;
      const f0 = st.S0.fA, f1 = st.S1.fB, s = (st.S0.s + st.S1.s) / 2;
      let cp = null;
      const cpRing = () => {
        if (cp) return cp;
        const r0 = ringCp(f0, panelAlphaForCl(f0, cl)), r1 = f1 === f0 ? r0 : ringCp(f1, panelAlphaForCl(f1, cl));
        cp = r0.map((v, i) => lerp(v, r1[i], s)); return cp;
      };
      return {y0: Math.min(st.y0, st.y1), y1: Math.max(st.y0, st.y1), ratio: cl / stripFoilCl(st, Re), cpRing};
    });
  }
  /* fuselage Cp on a station × angle grid, bilinear lookup per vertex (per-vertex evaluation is far too slow) */
  function fuseCpTable() {
    const L = A.L, F = L.fuse, ae = cachedVLM(L, A.p, "coarse"), cr = A.perf.cruise;
    const a = alphaDeg != null ? alphaDeg * D2R : cr ? (cr.CL - ae.CL0) / ae.CLa : 0.05, ctx = flowContext({...A, aero: ae}, a);
    const NX = 36, NA = 24, tab = new Float32Array((NX + 1) * NA);
    for (let i = 0; i <= NX; i++) {
      const x = F.L * i / NX;
      for (let j = 0; j < NA; j++) { const q = F.pt(x, 2 * Math.PI * j / NA, 3); tab[i * NA + j] = cpAt([x, q[0], q[1]], ctx); }
    }
    return (x, y, z) => {
      const u = Math.min(NX - 1e-6, Math.max(0, x / F.L * NX)), i = Math.floor(u), fu = u - i;
      const zc = F.profile(Math.min(F.L, Math.max(0, x)))[2];
      let t = Math.atan2(z - zc, y) / (2 * Math.PI) * NA; if (t < 0) t += NA;
      const j = Math.floor(t) % NA, j2 = (j + 1) % NA, ft = t - Math.floor(t);
      const q = (ii, jj) => tab[ii * NA + jj];
      return lerp(lerp(q(i, j), q(i, j2), ft), lerp(q(i + 1, j), q(i + 1, j2), ft), fu);
    };
  }
  function applyColors() {
    if (!model || !A) return;
    const strips = mode === "parts" ? null : wingStripData();
    let flow = null;
    const c = new THREE.Color();
    for (const mesh of model.children) {
      const pt = mesh.userData.part; if (!pt) continue;
      const geo = mesh.geometry, n = geo.attributes.position.count;
      if (mode === "parts") { mesh.material.vertexColors = false; mesh.material.color.copy(mesh.userData.baseColor); mesh.material.needsUpdate = true; continue; }
      let colors = geo.attributes.color;
      if (!colors) { colors = new THREE.BufferAttribute(new Float32Array(n * 3), 3); geo.setAttribute("color", colors); }
      const pos = geo.attributes.position.array;
      if (pt.group === "wing" && pt.meta) {
        for (let v = 0; v < n; v++) {
          const ri = pt.meta[v * 2], s = pt.meta[v * 2 + 1];
          const st = strips.find(q => s >= q.y0 - 1e-6 && s <= q.y1 + 1e-6) || strips[strips.length - 1];
          if (mode === "stall") stallColor(st.ratio, c);
          else if (ri >= 0) cpColor(st.cpRing()[ri], c);
          else c.copy(col("--part-b"));
          colors.setXYZ(v, c.r, c.g, c.b);
        }
      } else if (mode === "pressure" && (pt.group === "fuse" || pt.group === "cool")) {
        if (!flow) flow = fuseCpTable();
        for (let v = 0; v < n; v++) {
          cpColor(flow(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]), c); colors.setXYZ(v, c.r, c.g, c.b);
        }
      } else {
        const b = mesh.userData.baseColor;
        for (let v = 0; v < n; v++) colors.setXYZ(v, b.r, b.g, b.b);
      }
      colors.needsUpdate = true;
      mesh.material.vertexColors = true; mesh.material.color.set(0xffffff); mesh.material.needsUpdate = true;
    }
    render();
  }

  /* ---------------- model ---------------- */
  function setModel(a, b, opts = {}) {
    A = a; B = b;
    if (!renderer) return;
    if (model) { root.remove(model); dispose(model); }
    if (overlay) { root.remove(overlay); dispose(overlay); }
    if (markers) { root.remove(markers); dispose(markers); }
    model = new THREE.Group(); overlay = new THREE.Group(); markers = new THREE.Group();
    const segShade = (base, seg) => seg % 2 ? base.clone().lerp(col("--part-b"), 0.55) : base;
    for (const pt of b.parts) {
      if (pt.group === "jig" && !opts.showJigs) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pt.tris, 3));
      geo.computeVertexNormals();
      const base = segShade(col(partColor(pt)), pt.seg || 0);
      const mat = new THREE.MeshStandardMaterial({color: base.clone(), roughness: 0.78, metalness: 0.02, flatShading: true});
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData = {part: pt, baseColor: base};
      model.add(mesh);
    }
    const L = a.L, p = a.p, W = L.wing;
    if (typeof USER !== "undefined" && USER.ref && p.refShow !== false) {              // reference model, traced against
      const s = p.refScale > 0 ? p.refScale : 1, src = USER.ref.tris, t = new Float32Array(src.length);
      for (let i = 0; i < src.length; i += 3) {
        t[i] = src[i] * s + (p.refX || 0); t[i + 1] = src[i + 1] * s + (p.refY || 0); t[i + 2] = src[i + 2] * s + (p.refZ || 0);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(t, 3));
      g.computeVertexNormals();
      const gm = new THREE.Mesh(g, new THREE.MeshStandardMaterial({color: col("--muted"), roughness: 0.9, metalness: 0,
        transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide}));
      gm.userData = {ghost: true};
      model.add(gm);
    }
    const lineMat = (token, opacity = 0.9) => new THREE.MeshBasicMaterial({color: col(token), depthTest: false, transparent: true, opacity});
    const rod = (P0, P1, r, mat) => {
      const v0 = new THREE.Vector3(...P0), v1 = new THREE.Vector3(...P1), len = v0.distanceTo(v1);
      if (len < 1) return;
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 12), mat);
      m.position.copy(v0).lerp(v1, 0.5); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v1.clone().sub(v0).normalize());
      m.renderOrder = 2; overlay.add(m);
    };
    const carbon = lineMat("--carbon", 0.85);
    for (const sp of b.spars) {
      const pt = (y, side) => { const [x, z] = sp.line(y); return [x, side * y, W.dihZ(y) + z]; };
      if (sp.wire) continue;                                                             // a channel is a void, not a tube
      if (sp.continuous) {
        rod(pt(sp.yEnd, -1), pt(sp.yEnd, 1), sp.tube[0] / 2, carbon);                            // one rod across both wings
        if (sp.telescope) rod(pt(sp.sockLen / 2, -1), pt(sp.sockLen / 2, 1), sp.socket[0] / 2, carbon);   // the fuselage socket
      }
      else for (const side of [1, -1]) rod(pt(sp.yStart, side), pt(sp.yEnd, side), sp.tube[0] / 2, carbon);
    }
    for (const bm of L.booms.filter(q => q.role === "tail")) for (const side of bm.mirrored ? [1, -1] : [1]) rod([bm.a[0], side * bm.a[1], bm.a[2]], [bm.b[0], side * bm.b[1], bm.b[2]], bm.tube[0] / 2, carbon);
    if (b.vtolBoom) {
      const vb = b.vtolBoom;
      for (const side of [1, -1]) {
        const z = W.dihZ(vb.yb) + vb.zc;
        rod([vb.xf, side * vb.yb, z], [vb.xr, side * vb.yb, z], vb.d / 2, carbon);
        for (const x of [vb.xf, vb.xr]) propDisc([x, side * vb.yb, z + vb.d / 2 + 22], [0, 0, 1], p.liftPropD * IN / 2);
      }
    }
    if (b.wcs && b.wcs.pinR) for (const side of [1, -1]) {
      const pt = y => { const [x, z] = b.wcs.line(y); return [x, side * y, W.dihZ(y) + z]; };
      rod(pt(b.wcs.a - b.wcs.depth), pt(b.wcs.b + b.wcs.depth), 0.9, lineMat("--steel", 0.8));
    }
    function propDisc(pos, dir, R) {
      const disc = new THREE.Mesh(new THREE.CircleGeometry(R, 40), new THREE.MeshBasicMaterial({color: col("--steel"), transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false}));
      disc.position.set(...pos); disc.lookAt(pos[0] + dir[0], pos[1] + dir[1], pos[2] + dir[2]);
      overlay.add(disc);
      const ring = new THREE.Mesh(new THREE.RingGeometry(R - 1.2, R, 48), new THREE.MeshBasicMaterial({color: col("--steel"), transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false}));
      ring.position.copy(disc.position); ring.quaternion.copy(disc.quaternion); overlay.add(ring);
    }
    const motorMat = new THREE.MeshStandardMaterial({color: col("--motor"), roughness: 0.5, metalness: 0.4});
    for (const mo of L.motors.concat(L.vtol.type === "tilttri" ? L.vtol.lift : [])) {
      const can = L.main.can, m = new THREE.Mesh(new THREE.CylinderGeometry(can / 2, can / 2, can * 0.8, 20), motorMat);
      m.position.set(...mo.pos); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...mo.dir)); overlay.add(m);
      propDisc([mo.pos[0] + mo.dir[0] * can * 0.6, mo.pos[1] + mo.dir[1] * can * 0.6, mo.pos[2] + mo.dir[2] * can * 0.6], mo.dir, mo.propD * IN / 2);
    }
    // CG, target CG and neutral point
    const zRef = L.zWing, h = Math.max(40, (p.fuseH || 60) * 0.9);
    const marker = (x, token, shape, size) => {
      const g = shape === "cone" ? new THREE.ConeGeometry(size, size * 2, 16) : shape === "ring" ? new THREE.TorusGeometry(size, size * 0.22, 8, 28) : new THREE.SphereGeometry(size, 20, 12);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({color: col(token), depthTest: false}));
      m.position.set(x, 0, zRef + h); m.renderOrder = 3;
      if (shape === "cone") m.rotation.x = Math.PI / 2;
      overlay.add(m);
      const ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, 0, zRef - h), new THREE.Vector3(x, 0, zRef + h)]), new THREE.LineBasicMaterial({color: col(token), depthTest: false}));
      ln.renderOrder = 3; overlay.add(ln);
    };
    const sz = Math.max(5, p.span / 140);
    marker(a.xnp, "--s3", "cone", sz * 0.8);
    marker(a.xTarget, "--s1", "ring", sz);
    marker(a.xcg, Math.abs(a.smActual - p.staticMargin) < 3 ? "--good" : "--bad", "sphere", sz * 0.8);
    // draggable markers
    const addHandle = (kind, pos, token) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(Math.max(7, sz * 1.1), 20, 12), new THREE.MeshBasicMaterial({color: col(token), depthTest: false, transparent: true, opacity: 0.95}));
      m.position.set(...pos); m.renderOrder = 4; m.userData = {kind}; markers.add(m);
      const halo = new THREE.Mesh(new THREE.TorusGeometry(Math.max(9, sz * 1.5), 1.2, 8, 32), new THREE.MeshBasicMaterial({color: col(token), depthTest: false}));
      halo.position.copy(m.position); halo.renderOrder = 4; halo.userData = {kind}; markers.add(halo);
    };
    if (L.hasFuse) {
      const surf = (x, deg) => { const q = L.fuse.pt(x, deg * D2R); return [x, q[0], q[1]]; };
      if (p.intake) addHandle("intake", surf(p.intakeX + p.intakeL / 2, p.intakeAng), "--s1");
      if (p.exhaust) addHandle("exhaust", surf(p.exhaustX + 12, p.exhaustAng), "--s2");
      if (p.hatchBatt) addHandle("hatchBatt", surf((p.hatchBattAuto ? L.xw + p.battX - p.hatchBattLen / 2 : p.hatchBattX) + p.hatchBattLen / 2, 90), "--s3");
      if (p.hatchAv) addHandle("hatchAv", surf(p.hatchAvX + p.hatchAvLen / 2, 90), "--s3");
      if (p.deck) addHandle("deck", surf(L.xw + p.deckX + p.deckLen / 2, 90), "--part-mount");
      if (p.pod) addHandle("pod", surf(L.xw + p.podX + p.podL / 2, -90), "--part-mount");
    }
    if (b.servoMark || b.hornMark) {
      const onWing = m => [m.x, m.s, W.dihZ(m.s) + m.z];
      if (b.servoMark) addHandle("servo", onWing(b.servoMark), "--s1");
      if (b.hornMark) addHandle("horn", onWing(b.hornMark), "--s2");
    }
    root.add(model); root.add(overlay); root.add(markers);

    // bounds and ground grid in the aircraft frame
    const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (const m of model.children) { const arr = m.geometry.attributes.position.array; for (let i = 0; i < arr.length; i++) { const k = i % 3; if (arr[i] < mn[k]) mn[k] = arr[i]; if (arr[i] > mx[k]) mx[k] = arr[i]; } }
    const cx = (mn[0] + mx[0]) / 2, cy = (mn[1] + mx[1]) / 2, cz = (mn[2] + mx[2]) / 2;
    const newR = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) * 0.62;
    if (grid) { root.remove(grid); dispose(grid); }
    const cells = Math.ceil(newR * 3 / 100);
    grid = new THREE.GridHelper(cells * 100, cells, col("--grid"), col("--grid"));
    grid.material.transparent = true; grid.material.opacity = 0.55;
    grid.rotation.x = Math.PI / 2; grid.position.set(cx, cy, mn[2] - 40);
    root.add(grid);
    const reframe = !framed || Math.abs(newR - fitR) / fitR > 0.4;
    fitR = newR; center.set(cx, cz, -cy);
    if (reframe) { setView("iso"); framed = true; }
    applyColors();
  }
  function setColorMode(m, aDeg) { mode = m; alphaDeg = aDeg; applyColors(); }
  function setView(v) {
    if (!renderer) return;
    const D = fitR / Math.tan(camera.fov * Math.PI / 360) * 1.15;
    const dirs = {iso: [-0.75, 0.55, 0.95], top: [0.002, 1, 0], front: [-1, 0.08, 0], side: [0.02, 0.08, 1], below: [0.002, -1, 0]};
    camera.position.copy(center).add(new THREE.Vector3(...dirs[v]).normalize().multiplyScalar(D));
    controls.target.copy(center); controls.update(); render();
  }

  /* ---------------- picking & dragging ---------------- */
  function pick(e, objects) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObjects(objects, false);
  }
  const toAircraft = v => { const q = v.clone(); root.worldToLocal(q); return q; };
  function onDown(e) {
    if (!markers) return;
    const hit = pick(e, markers.children)[0];
    if (!hit) return;
    dragging = hit.object.userData.kind; controls.enabled = false;
    renderer.domElement.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function onMove(e) {
    if (dragging) {
      const onWing = dragging === "servo" || dragging === "horn";
      const targets = model.children.filter(m => m.userData.part && (onWing ? ["wing", "ctrl"].includes(m.userData.part.group) : m.userData.part.group === "fuse"));
      const hit = pick(e, targets)[0];
      if (!hit) return;
      const P = toAircraft(hit.point), L = A.L;
      const ang = L.hasFuse ? Math.atan2(P.z - L.fuse.profile(Math.min(L.fuse.L, Math.max(0, P.x)))[2], P.y) / D2R : 0;
      markers.children.filter(m => m.userData.kind === dragging).forEach(m => m.position.set(P.x, P.y, P.z));
      render();
      dragCb && dragCb(dragging, {x: P.x, y: P.y, ang, final: false});
      return;
    }
    const now = performance.now();
    if (now - lastHover < 70 || !model) return;
    lastHover = now;
    const mk = markers && pick(e, markers.children)[0];
    renderer.domElement.style.cursor = mk ? "grab" : "";
    const hit = pick(e, model.children)[0];
    hoverCb && hoverCb(hit ? hit.object.userData.part : null, e, mk ? mk.object.userData.kind : null);
  }
  function onUp(e) {
    if (!dragging) return;
    const kind = dragging; dragging = null; controls.enabled = true;
    const m = markers.children.find(q => q.userData.kind === kind);
    if (m) { const L = A.L, zc = L.hasFuse ? L.fuse.profile(Math.min(L.fuse.L, Math.max(0, m.position.x)))[2] : 0; dragCb && dragCb(kind, {x: m.position.x, y: m.position.y, ang: Math.atan2(m.position.z - zc, m.position.y) / D2R, final: true}); }
  }
  function highlight(name) {
    if (!model) return;
    for (const m of model.children) {
      const on = m.userData.part && m.userData.part.name === name;
      m.material.emissive = on ? col("--accent") : new THREE.Color(0);
      m.material.emissiveIntensity = on ? 0.35 : 0;
    }
    render();
  }
  function snapshot() { render(); return renderer ? renderer.domElement.toDataURL("image/png") : null; }
  return {init, setModel, setColorMode, setView, highlight, render, resize, snapshot};
})();
