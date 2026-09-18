"use strict";
/* ==========================================================================
   Geometry kernel. Everything is built from closed shells that are watertight
   by construction:
     loftZoned — lofts a 2D profile along an axis, where the profile may change
                 topology between zones (pockets, truncated control surfaces,
                 hatch openings). Transition faces close each change exactly.
     loftTube  — hollow or solid lofts of convex rings (pods, sleeves, bosses).
     plate     — flat extrusions with holes (mounts, trays, covers, jigs).
   Shells inside one part may overlap; slicers union them.
   ========================================================================== */
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vnorm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const vscale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const inPoly = (x, y, poly) => {
  let inside = false;
  for (let i = 0, n = poly.length, j = n - 1; i < n; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > y) !== (b[1] > y) && x < a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1])) inside = !inside;
  }
  return inside;
};
const signedArea2 = pts => { let a = 0; for (let i = 0, n = pts.length; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
const ID3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const placeRows = (u, v, w) => [[u[0], v[0], w[0]], [u[1], v[1], w[1]], [u[2], v[2], w[2]]];   // columns u,v,w

class Mesh {
  constructor(meta) { this.t = []; this.meta = meta ? [] : null; }
  tri(a, b, c, m) { this.t.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); if (this.meta) this.meta.push(...(m || NOMETA)); }
  /* x' = R·x + t with R given as rows; winding flips when det(R) < 0 */
  transformed(R, t = [0, 0, 0]) {
    const det = vdot(R[0], vcross(R[1], R[2])), out = new Mesh(!!this.meta), s = this.t;
    for (let i = 0; i < s.length; i += 9) {
      const v = [0, 3, 6].map(o => { const p = [s[i + o], s[i + o + 1], s[i + o + 2]]; return [vdot(R[0], p) + t[0], vdot(R[1], p) + t[1], vdot(R[2], p) + t[2]]; });
      const m = this.meta ? this.meta.slice(i / 9 * 6, i / 9 * 6 + 6) : null;
      if (det >= 0) out.tri(v[0], v[1], v[2], m); else out.tri(v[0], v[2], v[1], m && [m[0], m[1], m[4], m[5], m[2], m[3]]);
    }
    return out;
  }
  /* apply an arbitrary point map; flip = true reverses winding */
  mapped(fn, flip) {
    const out = new Mesh(!!this.meta), s = this.t;
    for (let i = 0; i < s.length; i += 9) {
      const v = [0, 3, 6].map(o => fn(s[i + o], s[i + o + 1], s[i + o + 2]));
      const m = this.meta ? this.meta.slice(i / 9 * 6, i / 9 * 6 + 6) : null;
      if (!flip) out.tri(v[0], v[1], v[2], m); else out.tri(v[0], v[2], v[1], m && [m[0], m[1], m[4], m[5], m[2], m[3]]);
    }
    return out;
  }
  add(o) {
    for (let i = 0; i < o.t.length; i++) this.t.push(o.t[i]);
    if (this.meta) { if (o.meta) for (const v of o.meta) this.meta.push(v); else for (let i = 0; i < o.t.length / 9; i++) this.meta.push(...NOMETA); }
    return this;
  }
}
const NOMETA = [-1, 0, -1, 0, -1, 0];

/* ---------- triangulated planar face at loft coordinate s ----------
   pts/holes are 2D (u,v); the face lies in plane s; sign = desired normal along ±s */
/* Two outline points on top of each other make the triangulator emit the same sliver twice,
   which leaves unpaired edges. Sections that have been reshaped (a blend, a heavy taper) can
   produce them, so every face drops repeated points before it is triangulated. */
const dedup = pts => {
  const out = [];
  for (const q of pts) {
    const prev = out[out.length - 1];
    if (!prev || Math.abs(prev[0] - q[0]) > 1e-4 || Math.abs(prev[1] - q[1]) > 1e-4) out.push(q);
  }
  while (out.length > 2) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) > 1e-4 || Math.abs(a[1] - b[1]) > 1e-4) break;
    out.pop();
  }
  return out;
};
function faceAt(m, pts, holes, s, sign) {
  pts = dedup(pts);
  holes = (holes || []).map(dedup).filter(h => h.length > 2);
  if (pts.length < 3) return;
  const contour = pts.map(p => new THREE.Vector2(p[0], p[1])), hv = (holes || []).map(h => h.map(p => new THREE.Vector2(p[0], p[1])));
  const all = contour.concat(...hv);
  for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, hv)) {
    const A = all[i], B = all[j], C = all[k], ar = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
    const a = [A.x, s, A.y], b = [B.x, s, B.y], c = [C.x, s, C.y];
    // for points (u, s, v): CCW in (u,v) gives a normal along -s
    if ((sign < 0) === (ar > 0)) m.tri(a, b, c); else m.tri(a, c, b);
  }
}
function discAt(m, ring, s, sign) {
  const cu = ring.reduce((a, q) => a + q[0], 0) / ring.length, cv = ring.reduce((a, q) => a + q[1], 0) / ring.length;
  for (let k = 0; k < ring.length; k++) {
    const q = ring[k], r = ring[(k + 1) % ring.length];
    const ar = (q[0] - cu) * (r[1] - cv) - (r[0] - cu) * (q[1] - cv);
    const a = [cu, s, cv], b = [q[0], s, q[1]], c = [r[0], s, r[1]];
    if ((sign < 0) === (ar > 0)) m.tri(a, b, c); else m.tri(a, c, b);
  }
}

/* ---------- zoned loft along +s ----------
   ys:     station coordinates
   zones:  [{j0, j1, outers: [j => CCW 2D pts], holes: [j => CW 2D pts], meta?: [j => ring index per outer point]}]
   faces:  [{j, pts, holes, sign}]   transition faces between zones
   discs:  [{j, ring, sign}]         closed ends of blind holes
   End caps come from the first and last zone. Output points are (u, s, v). */
function loftZoned(ys, zones, faces, discs, withMeta) {
  const m = new Mesh(withMeta), last = ys.length - 1;
  const wall = (ringAt, j0, j1, idxAt) => {
    for (let j = j0; j < j1; j++) {
      const A = ringAt(j), B = ringAt(j + 1), ia = idxAt ? idxAt(j) : null, ib = idxAt ? idxAt(j + 1) : null;
      const sa = ys[j], sb = ys[j + 1], n = A.length;
      for (let k = 0; k < n; k++) {
        const k2 = (k + 1) % n;
        const p0 = [A[k][0], sa, A[k][1]], p0n = [A[k2][0], sa, A[k2][1]], p1 = [B[k][0], sb, B[k][1]], p1n = [B[k2][0], sb, B[k2][1]];
        const mt = (i, kk, s) => [i ? i[kk] : -1, s];
        m.tri(p0, p1n, p0n, withMeta ? [...mt(ia, k, sa), ...mt(ib, k2, sb), ...mt(ia, k2, sa)] : null);
        m.tri(p0, p1, p1n, withMeta ? [...mt(ia, k, sa), ...mt(ib, k, sb), ...mt(ib, k2, sb)] : null);
      }
    }
  };
  for (const z of zones) {
    z.outers.forEach((o, i) => wall(o, z.j0, z.j1, z.meta && z.meta[i]));
    z.holes.forEach(h => wall(h, z.j0, z.j1, null));
  }
  const capOf = (z, j, sign) => {
    const holes = z.holes.map(h => h(j));
    z.outers.forEach(o => {
      const pts = o(j), inside = holes.filter(h => pointInPoly(h[0], pts));
      faceAt(m, pts, inside, ys[j], sign);
    });
  };
  capOf(zones[0], 0, -1);
  capOf(zones[zones.length - 1], last, 1);
  for (const f of faces) faceAt(m, f.pts, f.holes, ys[f.j], f.sign);
  for (const d of discs) discAt(m, d.ring, ys[d.j], d.sign);
  return m;
}
function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / ((yj - yi) || 1e-12) + xi) inside = !inside;
  }
  return inside;
}

/* ---------- hollow or solid tube along +x between convex rings ---------- */
function loftTube(stations) {
  const m = new Mesh(), n = stations[0].outer.length;
  const orient = (a, b, c, ref, away) => {
    const nrm = vcross(vsub(b, a), vsub(c, a)), cen = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const d = away ? vsub(cen, ref) : vsub(ref, cen); d[0] = 0;
    if (vdot(nrm, d) >= 0) m.tri(a, b, c); else m.tri(a, c, b);
  };
  const orientDir = (a, b, c, dir) => { const nrm = vcross(vsub(b, a), vsub(c, a)); if (vdot(nrm, dir) >= 0) m.tri(a, b, c); else m.tri(a, c, b); };
  const P = (st, ring, k) => [st.x, ring[k][0], ring[k][1]];
  for (let j = 0; j < stations.length - 1; j++) {
    const A = stations[j], B = stations[j + 1], ref = [(A.x + B.x) / 2, (A.c[0] + B.c[0]) / 2, (A.c[1] + B.c[1]) / 2];
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      const a = P(A, A.outer, k), b = P(A, A.outer, k2), c = P(B, B.outer, k2), d = P(B, B.outer, k);
      orient(a, b, c, ref, true); orient(a, c, d, ref, true);
      if (A.inner) {
        const ai = P(A, A.inner, k), bi = P(A, A.inner, k2), ci = P(B, B.inner, k2), di = P(B, B.inner, k);
        orient(ai, bi, ci, ref, false); orient(ai, ci, di, ref, false);
      }
    }
  }
  for (const [st, dir] of [[stations[0], [-1, 0, 0]], [stations[stations.length - 1], [1, 0, 0]]]) {
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      if (st.inner) { const a = P(st, st.outer, k), b = P(st, st.outer, k2), c = P(st, st.inner, k2), d = P(st, st.inner, k); orientDir(a, b, c, dir); orientDir(a, c, d, dir); }
      else orientDir([st.x, st.c[0], st.c[1]], P(st, st.outer, k), P(st, st.outer, k2), dir);
    }
  }
  return m;
}
/* vertical boss (tube along z) with an insert hole, from z0 to z1 */
function boss(x, y, z0, z1, rOut, rIn) {
  const tube = loftTube([0, z1 - z0].map(u => ({x: u, outer: circle(0, 0, rOut, 20), inner: rIn ? circle(0, 0, rIn, 20) : null, c: [0, 0]})));
  return tube.transformed([[0, 1, 0], [0, 0, 1], [1, 0, 0]], [x, y, z0]);         // local x -> world z
}

/* ---------- flat plate in (u,v), thickness along w ---------- */
function plate(outer, holes, th) {
  const m = new Mesh();
  if (signedArea2(outer) < 0) outer = outer.slice().reverse();
  holes = (holes || []).map(h => signedArea2(h) > 0 ? h.slice().reverse() : h);
  const walls = R => {
    for (let k = 0; k < R.length; k++) {
      const a = R[k], b = R[(k + 1) % R.length];
      const a0 = [a[0], a[1], 0], b0 = [b[0], b[1], 0], a1 = [a[0], a[1], th], b1 = [b[0], b[1], th];
      m.tri(a0, b0, b1); m.tri(a0, b1, a1);
    }
  };
  walls(outer); holes.forEach(walls);
  const contour = outer.map(p => new THREE.Vector2(p[0], p[1])), hv = holes.map(h => h.map(p => new THREE.Vector2(p[0], p[1])));
  const all = contour.concat(...hv);
  for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, hv)) {
    const A = all[i], B = all[j], C = all[k], s = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
    const lo = s < 0 ? [A, B, C] : [A, C, B], hi = s > 0 ? [A, B, C] : [A, C, B];
    m.tri([lo[0].x, lo[0].y, 0], [lo[1].x, lo[1].y, 0], [lo[2].x, lo[2].y, 0]);
    m.tri([hi[0].x, hi[0].y, th], [hi[1].x, hi[1].y, th], [hi[2].x, hi[2].y, th]);
  }
  return m;
}
// half-step phase keeps hole vertices off the axes, so neighbouring holes never share collinear points
const circle = (cx, cy, r, n = 20) => Array.from({length: n}, (_, i) => { const a = 2 * Math.PI * (i + 0.5) / n + 0.13; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; });
/* the half-step and the odd phase keep ring vertices off the outline vertices they sit near:
   aligned ones make the triangulator emit overlapping slivers (same reason circle() is offset) */
const holeRing = (cx, cz, r, n = 24) => Array.from({length: n}, (_, k) => { const a = -2 * Math.PI * (k + 0.5) / n + 0.11; return [cx + r * Math.cos(a), cz + r * Math.sin(a)]; });
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const roundRect = (x0, y0, x1, y1, r) => {
  r = Math.min(r, (x1 - x0) / 2 - 0.01, (y1 - y0) / 2 - 0.01);
  const pts = [], c = [[x1 - r, y0 + r, -90], [x1 - r, y1 - r, 0], [x0 + r, y1 - r, 90], [x0 + r, y0 + r, 180]];
  for (const [cx, cy, a0] of c) for (let i = 0; i <= 4; i++) { const a = (a0 + 22.5 * i) * D2R; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return pts;
};
/* superellipse ring; E may be one exponent or [top, bottom] for a flatter deck or belly */
const superRing = (hw, hh, zc, n, E = 2.6) => {
  const [Et, Eb] = Array.isArray(E) ? E : [E, E];
  return Array.from({length: n}, (_, k) => {
    const a = 2 * Math.PI * k / n, c = Math.cos(a), s = Math.sin(a), e = s >= 0 ? Et : Eb;
    return [hw * Math.sign(c) * Math.pow(Math.abs(c), 2 / e), zc + hh * Math.sign(s) * Math.pow(Math.abs(s), 2 / e)];
  });
};
/* outward offset of a CCW polygon (small distances) */
function offsetRing(pts, d) {
  const n = pts.length;
  return pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n], tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1;
    return [p[0] + d * ty / l, p[1] - d * tx / l];
  });
}

/* ---------- motor mount hole patterns ---------- */
function mountHoles(id, motor) {
  const pat = MOUNT_PATTERNS[id === "auto" || !MOUNT_PATTERNS[id] ? motor.mountId : id] || MOUNT_PATTERNS.x16_19;
  const r = pat.screw / 2, holes = [circle(0, 0, pat.center / 2, 20)];
  const at = (rad, ang) => circle(rad * Math.cos(ang), rad * Math.sin(ang), r, 12);
  if (pat.type === "square") for (let k = 0; k < 4; k++) holes.push(at(pat.s[0] / Math.SQRT2, Math.PI / 4 + k * Math.PI / 2));
  if (pat.type === "cross") for (let k = 0; k < 4; k++) holes.push(at(pat.d[k % 2] / 2, k * Math.PI / 2));
  if (pat.type === "combo") for (let k = 0; k < 4; k++) { holes.push(at(pat.s[0] / Math.SQRT2, Math.PI / 4 + k * Math.PI / 2)); holes.push(at(pat.s[1] / Math.SQRT2, k * Math.PI / 2)); }
  if (pat.type === "slots") for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + k * Math.PI / 2, ux = Math.cos(a), uy = Math.sin(a), pts = [];
    for (let i = 0; i <= 8; i++) { const t = -Math.PI / 2 + Math.PI * i / 8, c = Math.cos(t), s2 = Math.sin(t); pts.push([pat.r[1] * ux + r * (c * ux - s2 * uy), pat.r[1] * uy + r * (c * uy + s2 * ux)]); }
    for (let i = 0; i <= 8; i++) { const t = Math.PI / 2 + Math.PI * i / 8, c = Math.cos(t), s2 = Math.sin(t); pts.push([pat.r[0] * ux + r * (c * ux - s2 * uy), pat.r[0] * uy + r * (c * uy + s2 * ux)]); }
    holes.push(pts);
  }
  return {holes, pat, span: Math.max(...holes.flat().map(q => Math.hypot(q[0], q[1]))) * 2 + 8};
}
/* square motor plate; extra = additional holes (e.g. screw holes to bosses) */
function mountPlate(id, motor, minSide, th = 4, extra = []) {
  const mh = mountHoles(id, motor), s = Math.max(minSide, mh.span, motor.can * 0.9);
  return plate(roundRect(-s / 2, -s / 2, s / 2, s / 2, 4), mh.holes.concat(extra), th);
}

/* cut boundaries: auto = equal pieces that fit the printer height, manual = user list */
function cutBounds(len, zUse, manualStr, manual) {
  let cuts;
  if (manual) cuts = parseCuts(manualStr).filter(v => v > 15 && v < len - 15);
  else { const n = Math.max(1, Math.ceil(len / zUse)); cuts = Array.from({length: n - 1}, (_, i) => len * (i + 1) / n); }
  return [0, ...cuts, len];
}

/* airfoil points at chord fractions U (ascending, U[0] = 0): lower and upper arrays of [x, z]
   in the chord plane with twist about 25% chord and the trailing edge opened to minTE */
function foilPts(st, U, minTE) {
  const te = Math.min(minTE / st.c, 0.03), ang = st.twist * D2R, ca = Math.cos(ang), sa = Math.sin(ang), piv = 0.25 * st.c;
  const rot = (x, z) => { const dx = x - piv; return [st.x + piv + dx * ca + z * sa, -dx * sa + z * ca]; };
  const lo = [], up = [], k = st.thick || 1;
  for (const u of U) {
    const au = lerp(interpY(XG, st.fA.yu, u), interpY(XG, st.fB.yu, u), st.s), al = lerp(interpY(XG, st.fA.yl, u), interpY(XG, st.fB.yl, u), st.s), zc = (au + al) / 2;
    const yu = zc + (au - zc) * k + te / 2 * u;
    const yl = zc + (al - zc) * k - te / 2 * u;
    lo.push(rot(u * st.c, yl * st.c)); up.push(rot(u * st.c, yu * st.c));
  }
  up[0] = lo[0];
  return {lo, up};
}
/* skin z (upper, lower) at an absolute x in the chord plane, from foilPts arrays */
function skinAtX(P, x) {
  const f = arr => { for (let i = 1; i < arr.length; i++) if (arr[i][0] >= x) { const a = arr[i - 1], b = arr[i], t = (x - a[0]) / ((b[0] - a[0]) || 1); return a[1] + t * (b[1] - a[1]); } return arr[arr.length - 1][1]; };
  return [f(P.up), f(P.lo)];
}

/* ==========================================================================
   Writers: binary STL, stored ZIP, Selig .dat, AVL
   ========================================================================== */
function stlBinary(tris, name) {
  const n = tris.length / 9, buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf);
  const head = ("Airframe Forge " + name).slice(0, 79);
  for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i) & 127);
  dv.setUint32(80, n, true);
  let o = 84;
  for (let i = 0; i < n; i++) {
    const b = i * 9, a = [tris[b], tris[b + 1], tris[b + 2]], bb = [tris[b + 3], tris[b + 4], tris[b + 5]], c = [tris[b + 6], tris[b + 7], tris[b + 8]];
    const nr = vnorm(vcross(vsub(bb, a), vsub(c, a)));
    for (const v of nr) { dv.setFloat32(o, v, true); o += 4; }
    for (let k = 0; k < 9; k++) { dv.setFloat32(o, tris[b + k], true); o += 4; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return new Uint8Array(buf);
}
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function makeZip(files) {
  const enc = new TextEncoder(), chunks = [], central = [];
  let offset = 0;
  const d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const nm = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, sz, true); lh.setUint32(22, sz, true); lh.setUint16(26, nm.length, true);
    chunks.push(new Uint8Array(lh.buffer), nm, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, sz, true); ch.setUint32(24, sz, true);
    ch.setUint16(28, nm.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nm);
    offset += 30 + nm.length + sz;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const parts = [...chunks, ...central, new Uint8Array(end.buffer)];
  return typeof Blob !== "undefined" ? new Blob(parts, {type: "application/zip"}) : parts;
}
function datText(f) {
  const lines = [f.name];
  for (let i = K; i >= 0; i--) lines.push(`${XG[i].toFixed(5)} ${f.yu[i].toFixed(5)}`);
  for (let i = 1; i <= K; i++) lines.push(`${XG[i].toFixed(5)} ${f.yl[i].toFixed(5)}`);
  return lines.join("\n");
}
function avlText(A) {
  const L = A.L, W = L.wing, m = v => (v / 1000).toFixed(4), foils = new Set();
  const out = [`Airframe Forge ${fmtN(A.p.span)} mm`, "#Mach", "0.0", "#IYsym IZsym Zsym", "0 0 0.0",
    "#Sref Cref Bref (m)", `${(W.S * 1e-6).toFixed(5)} ${m(W.mac)} ${m(A.p.span)}`, "#Xref Yref Zref", `${m(A.xcg)} 0.0 ${m(L.zWing)}`, "#CDp", "0.0"];
  const section = s => { foils.add(s.s > 0.5 ? s.fB : s.fA); return ["SECTION", "#Xle Yle Zle Chord Ainc", `${m(s.x)} ${m(s.y)} ${m(s.z)} ${m(s.c)} ${s.twist.toFixed(2)}`, "AFILE", `airfoils/${(s.s > 0.5 ? s.fB : s.fA).id}.dat`]; };
  const surface = (name, st, dup, nsp) => {
    out.push("#" + "=".repeat(40), "SURFACE", name, "#Nchord Cspace Nspan Sspace", `8 1.0 ${nsp} -2.0`);
    if (dup) out.push("YDUPLICATE", "0.0");
    out.push("ANGLE", "0.0");
    st.forEach(s => out.push(...section(s)));
  };
  const ws = [0, W.blendEnd, W.half * 0.5, W.half].filter((v, i, a) => a.indexOf(v) === i).map(y => W.wingAt(y));
  surface("Wing", ws, true, 24);
  for (const s of L.surfaces) surface(s.name, [s.st[0], s.st[s.st.length - 1]], s.mirrored, 10);
  return {text: out.join("\n"), foils: [...foils]};
}
