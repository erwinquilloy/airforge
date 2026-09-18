"use strict";
/* ==========================================================================
   Geometry you bring yourself.
     - your own printed parts (STL): placed on the aircraft, weighed into the
       balance and written into the export with everything else;
     - a reference model (STL): drawn as a ghost to size your design against,
       never analysed and never exported;
     - the design file: every parameter, your imported airfoils and any
       uploaded geometry, in one .json you can reload or share.
   Triangles live here, out of the parameter set, so a design stays small.
   ========================================================================== */
const USER = {mesh: Object.create(null), ref: null};                 // id -> Float32Array (mm, as uploaded)

const bytesToStr = u8 => {                                           // no TextDecoder dependency
  let s = "";
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  return s;
};

/* Binary or ASCII STL to a flat triangle list. Throws with something readable. */
function parseSTL(buf) {
  const n = buf.byteLength;
  if (n < 15) throw new Error("That file is too small to be an STL.");
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  const head = bytesToStr(u8.subarray(0, Math.min(256, n))).toLowerCase();
  const claimed = n >= 84 ? dv.getUint32(80, true) : -1;
  const binarySized = claimed >= 0 && 84 + 50 * claimed === n;
  if (!binarySized && head.startsWith("solid") && head.includes("facet")) {
    const txt = bytesToStr(u8), out = [];
    const re = /vertex\s+(-?[\d.]+(?:[eE][-+]?\d+)?)\s+(-?[\d.]+(?:[eE][-+]?\d+)?)\s+(-?[\d.]+(?:[eE][-+]?\d+)?)/g;
    let m;
    while ((m = re.exec(txt))) out.push(+m[1], +m[2], +m[3]);
    if (out.length < 9) throw new Error("No triangles found in that STL.");
    return new Float32Array(out.slice(0, Math.floor(out.length / 9) * 9));
  }
  if (claimed <= 0 || 84 + 50 * claimed > n) throw new Error("That STL looks truncated or is not an STL.");
  const out = new Float32Array(claimed * 9);
  for (let i = 0, o = 84; i < claimed; i++, o += 50)
    for (let k = 0; k < 9; k++) out[i * 9 + k] = dv.getFloat32(o + 12 + k * 4, true);
  return out;
}

function trisBounds(t) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i++) { const k = i % 3; if (t[i] < mn[k]) mn[k] = t[i]; if (t[i] > mx[k]) mx[k] = t[i]; }
  return {mn, mx, size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]};
}
function trisVolume(t) {                                             // mm^3, signed then absolute
  let v = 0;
  for (let i = 0; i < t.length; i += 9)
    v += (t[i] * (t[i + 4] * t[i + 8] - t[i + 5] * t[i + 7]) - t[i + 1] * (t[i + 3] * t[i + 8] - t[i + 5] * t[i + 6])
      + t[i + 2] * (t[i + 3] * t[i + 7] - t[i + 4] * t[i + 6])) / 6;
  return Math.abs(v);
}

/* base64 both ways, so uploaded geometry can live in a design file (no host helpers needed) */
const B64C = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64FromTris(t) {
  const u8 = new Uint8Array(t.buffer, t.byteOffset, t.byteLength);
  let out = "";
  for (let i = 0; i < u8.length; i += 3) {
    const a = u8[i], b = i + 1 < u8.length ? u8[i + 1] : 0, c = i + 2 < u8.length ? u8[i + 2] : 0;
    out += B64C[a >> 2] + B64C[((a & 3) << 4) | (b >> 4)]
      + (i + 1 < u8.length ? B64C[((b & 15) << 2) | (c >> 6)] : "=")
      + (i + 2 < u8.length ? B64C[c & 63] : "=");
  }
  return out;
}
function trisFromB64(b) {
  const clean = String(b).replace(/[^A-Za-z0-9+/]/g, "");
  const u8 = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64C.indexOf(clean[i]) << 18) | (B64C.indexOf(clean[i + 1]) << 12)
      | ((B64C.indexOf(clean[i + 2]) & 63) << 6) | (B64C.indexOf(clean[i + 3]) & 63);
    if (o < u8.length) u8[o++] = (n >> 16) & 255;
    if (o < u8.length) u8[o++] = (n >> 8) & 255;
    if (o < u8.length) u8[o++] = n & 255;
  }
  const f = Math.floor(o / 4) * 4;
  return new Float32Array(u8.buffer.slice(0, f));
}

const D2Rd = Math.PI / 180;
/* placed triangles: scale, then rotate about x, y, z, then offset to where it sits on the aircraft */
function userTris(cp) {
  const src = USER.mesh[cp.id];
  if (!src) return null;
  const s = cp.scale > 0 ? cp.scale : 1;
  const cx = Math.cos((cp.rx || 0) * D2Rd), sx = Math.sin((cp.rx || 0) * D2Rd);
  const cy = Math.cos((cp.ry || 0) * D2Rd), sy = Math.sin((cp.ry || 0) * D2Rd);
  const cz = Math.cos((cp.rz || 0) * D2Rd), sz = Math.sin((cp.rz || 0) * D2Rd);
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    let x = src[i] * s, y = src[i + 1] * s, z = src[i + 2] * s;
    let t1 = y * cx - z * sx; z = y * sx + z * cx; y = t1;
    t1 = x * cy + z * sy; z = -x * sy + z * cy; x = t1;
    t1 = x * cz - y * sz; y = x * sz + y * cz; x = t1;
    out[i] = x + (cp.x || 0); out[i + 1] = y + (cp.y || 0); out[i + 2] = z + (cp.z || 0);
  }
  return out;
}
/* where the placed part sits, for the balance */
function userCentroid(cp) {
  const t = userTris(cp);
  if (!t) return null;
  const b = trisBounds(t);
  return [(b.mn[0] + b.mx[0]) / 2, (b.mn[1] + b.mx[1]) / 2, (b.mn[2] + b.mx[2]) / 2];
}
/* a starting guess at mass: a printed shell, not a solid block */
function userMassGuess(cp, material) {
  const t = USER.mesh[cp.id];
  if (!t) return 0;
  const s = cp.scale > 0 ? cp.scale : 1;
  const vol = trisVolume(t) * s * s * s / 1000;                      // cm^3
  const rho = (material && material.rho) || 1.24;                    // g/cm^3
  return Math.max(1, Math.round(vol * rho * 0.32));                  // ~3 walls, light infill
}

function userPartList(p) { return (p.customParts || []).filter(cp => cp.include !== false && USER.mesh[cp.id]); }

/* ---------------- the design file ---------------- */
function designFile(p, foils) {
  const meshes = {};
  for (const cp of p.customParts || []) if (USER.mesh[cp.id]) meshes[cp.id] = b64FromTris(USER.mesh[cp.id]);
  return {
    app: "Airframe Forge", kind: "design", version: 1, savedAt: new Date().toISOString(),
    name: p.designName || p.template || "design",
    params: p, foils: foils || [], meshes,
    ref: USER.ref ? {name: USER.ref.name, tris: b64FromTris(USER.ref.tris)} : null,
  };
}
/* Returns {params, foils, notes[]}. Anything the tool does not recognise is dropped and reported,
   so a file from another version — or a hand-edited one — cannot leave the app in a broken state. */
function readDesignFile(text, schema, defaults) {
  let d;
  try { d = JSON.parse(text); } catch (e) { throw new Error("That file is not valid JSON."); }
  if (!d || d.kind !== "design" || !d.params) throw new Error("That is not an Airframe Forge design file.");
  const notes = [], known = new Set(schema.map(f => f.id).concat(["foilRoot", "foilTip", "foilTail", "components", "template", "designName", "customParts", "refShow", "refScale", "refX", "refY", "refZ"]));
  const out = Object.assign({}, defaults);
  let dropped = 0;
  for (const [k, v] of Object.entries(d.params)) {
    if (!known.has(k)) { dropped++; continue; }
    const f = schema.find(q => q.id === k);
    if (f && f.kind === "num" && typeof v === "number") {
      const lo = f.min !== undefined ? f.min : -Infinity, hi = f.max !== undefined ? f.max : Infinity;
      if (!isFinite(v)) { notes.push(`${f.label}: not a number, kept the default.`); continue; }
      if (v < lo || v > hi) notes.push(`${f.label}: ${v} is outside ${lo}–${hi}, clamped.`);
      out[k] = Math.min(hi, Math.max(lo, v));
      continue;
    }
    out[k] = v;
  }
  if (dropped) notes.push(`${dropped} setting${dropped > 1 ? "s" : ""} from another version were ignored.`);
  out.customParts = Array.isArray(d.params.customParts) ? d.params.customParts.filter(cp => cp && cp.id) : [];
  for (const [id, b] of Object.entries(d.meshes || {})) {
    try { USER.mesh[id] = trisFromB64(b); } catch (e) { notes.push("One uploaded part could not be read."); }
  }
  out.customParts = out.customParts.filter(cp => USER.mesh[cp.id]);
  USER.ref = null;
  if (d.ref && d.ref.tris) {
    try { USER.ref = {name: d.ref.name || "reference", tris: trisFromB64(d.ref.tris)}; }
    catch (e) { notes.push("The reference model could not be read."); }
  }
  return {params: out, foils: Array.isArray(d.foils) ? d.foils : [], notes};
}
