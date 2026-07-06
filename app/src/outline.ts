import type { ContourPoint } from "./types";

// Konversi kontur UFO (cubic) -> SVG path (koordinat font, y-up; flip dilakukan via <g>).
export function contoursToPath(contours: ContourPoint[][]): string {
  let d = "";
  for (const pts of contours) {
    if (!pts.length) continue;
    const start = pts.findIndex((p) => p.type !== "offcurve");
    if (start < 0) continue;
    const n = pts.length;
    const ord: ContourPoint[] = [];
    for (let i = 0; i < n; i++) ord.push(pts[(start + i) % n]);
    const firstType = ord[0].type; // tipe titik awal = segmen penutup
    d += `M ${ord[0].x} ${ord[0].y} `;
    let pending: ContourPoint[] = [];
    for (let i = 1; i < ord.length; i++) {
      const p = ord[i];
      if (p.type === "offcurve") {
        pending.push(p);
      } else if (p.type === "line") {
        d += `L ${p.x} ${p.y} `;
        pending = [];
      } else {
        // curve / qcurve
        if (pending.length === 2) d += `C ${pending[0].x} ${pending[0].y} ${pending[1].x} ${pending[1].y} ${p.x} ${p.y} `;
        else if (pending.length === 1) d += `Q ${pending[0].x} ${pending[0].y} ${p.x} ${p.y} `;
        else d += `L ${p.x} ${p.y} `;
        pending = [];
      }
    }
    // segmen penutup kembali ke titik awal
    if (firstType === "curve" && pending.length === 2)
      d += `C ${pending[0].x} ${pending[0].y} ${pending[1].x} ${pending[1].y} ${ord[0].x} ${ord[0].y} `;
    else if (firstType === "qcurve" && pending.length === 1)
      d += `Q ${pending[0].x} ${pending[0].y} ${ord[0].x} ${ord[0].y} `;
    d += "Z ";
  }
  return d;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const P = (x: number, y: number, type: ContourPoint["type"]): ContourPoint => ({ x, y, type, smooth: false });

// Titik terdekat pada segmen yang BERAKHIR di on-curve `endIdx` ke (fx,fy).
// Kembalikan jarak + parameter t (0..1) di titik terdekat (sampling kurva nyata, bukan chord).
export function segClosest(pts: ContourPoint[], endIdx: number, fx: number, fy: number): { dist: number; t: number } {
  const n = pts.length;
  let i = (endIdx - 1 + n) % n;
  const offs: ContourPoint[] = [];
  while (pts[i].type === "offcurve") { offs.unshift(pts[i]); i = (i - 1 + n) % n; }
  const a = pts[i], b = pts[endIdx];
  let best = Infinity, bestT = 0.5;
  const samp = (x: number, y: number, t: number) => { const dd = Math.hypot(fx - x, fy - y); if (dd < best) { best = dd; bestT = t; } };
  if (offs.length === 2) {
    const [p1, p2] = offs;
    for (let t = 0; t <= 1.0001; t += 0.04) { const m = 1 - t;
      samp(m * m * m * a.x + 3 * m * m * t * p1.x + 3 * m * t * t * p2.x + t * t * t * b.x,
           m * m * m * a.y + 3 * m * m * t * p1.y + 3 * m * t * t * p2.y + t * t * t * b.y, t); }
  } else if (offs.length === 1) {
    const p1 = offs[0];
    for (let t = 0; t <= 1.0001; t += 0.04) { const m = 1 - t;
      samp(m * m * a.x + 2 * m * t * p1.x + t * t * b.x, m * m * a.y + 2 * m * t * p1.y + t * t * b.y, t); }
  } else {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    let t = l2 ? ((fx - a.x) * dx + (fy - a.y) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    samp(a.x + t * dx, a.y + t * dy, t);
  }
  return { dist: best, t: bestT };
}

// Tambah node pada segmen yang berakhir di on-curve `endIdx`, di parameter `t` (0..1; default tengah).
// Split tepat di t → node mendarat di posisi kurva paling dekat kursor.
export function addNode(pts: ContourPoint[], endIdx: number, t = 0.5): ContourPoint[] {
  t = Math.max(0.001, Math.min(0.999, t));
  const n = pts.length;
  const end = pts[endIdx];
  // titik on-curve sebelumnya + offcurve di antara
  let i = (endIdx - 1 + n) % n;
  const offs: ContourPoint[] = [];
  while (pts[i].type === "offcurve") {
    offs.unshift(pts[i]);
    i = (i - 1 + n) % n;
  }
  const startIdx = i;
  const start = pts[startIdx];
  if (end.type === "line" || offs.length === 0) {
    // sisip on-curve "line" di posisi t
    const res = [...pts];
    res.splice(endIdx, 0, P(lerp(start.x, end.x, t), lerp(start.y, end.y, t), "line"));
    return res;
  }
  if (offs.length === 2) {
    // de Casteljau split cubic di parameter t
    const p0 = start, p1 = offs[0], p2 = offs[1], p3 = end;
    const q0 = P(lerp(p0.x, p1.x, t), lerp(p0.y, p1.y, t), "offcurve");
    const q1 = P(lerp(p1.x, p2.x, t), lerp(p1.y, p2.y, t), "offcurve");
    const q2 = P(lerp(p2.x, p3.x, t), lerp(p2.y, p3.y, t), "offcurve");
    const r0 = P(lerp(q0.x, q1.x, t), lerp(q0.y, q1.y, t), "offcurve");
    const r1 = P(lerp(q1.x, q2.x, t), lerp(q1.y, q2.y, t), "offcurve");
    const s = { ...P(lerp(r0.x, r1.x, t), lerp(r0.y, r1.y, t), "curve"), smooth: true }; // titik baru = halus
    // ganti [off0, off1] (tepat sebelum endIdx) dengan [q0, r0, s(curve), r1, q2]; `end` tetap
    const firstOff = (endIdx - 2 + n) % n;
    const out: ContourPoint[] = [];
    for (let k = 0; k < n; k++) {
      if (k === firstOff) { out.push(q0, r0, s, r1, q2); k++; continue; } // lewati off kedua
      out.push(pts[k]);
    }
    return out;
  }
  // offs.length === 1 → split quadratic di parameter t
  const p0 = start, p1 = offs[0], p2 = end;
  const q0 = P(lerp(p0.x, p1.x, t), lerp(p0.y, p1.y, t), "offcurve");
  const q1 = P(lerp(p1.x, p2.x, t), lerp(p1.y, p2.y, t), "offcurve");
  const s = { ...P(lerp(q0.x, q1.x, t), lerp(q0.y, q1.y, t), end.type), smooth: true };
  const offIdx = (endIdx - 1 + n) % n;
  const out: ContourPoint[] = [];
  for (let k = 0; k < n; k++) {
    if (k === offIdx) { out.push(q0, s, q1); continue; } // ganti [off] dengan [q0, s(qcurve), q1]
    out.push(pts[k]);
  }
  return out;
}

// Hapus node on-curve `idx` beserta offcurve segmen yang menuju ke node itu.
export function removeNode(pts: ContourPoint[], idx: number): ContourPoint[] {
  const n = pts.length;
  if (pts[idx].type === "offcurve") return pts; // hanya on-curve
  const onCount = pts.filter((p) => p.type !== "offcurve").length;
  if (onCount <= 2) return pts; // jaga minimal 2 on-curve
  const remove = new Set<number>([idx]);
  // offcurve tepat sebelum node (segmen yang menuju node ini)
  let i = (idx - 1 + n) % n;
  while (pts[i].type === "offcurve" && remove.size < n) {
    remove.add(i);
    i = (i - 1 + n) % n;
  }
  return pts.filter((_, k) => !remove.has(k));
}
