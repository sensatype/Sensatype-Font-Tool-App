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
//
// Dijalankan lewat segments()+insertMarks() — bukan menyulam index seperti dulu. Versi lama
// mengganti pasangan offcurve lewat `firstOff = (endIdx − 2 + n) % n` lalu melompati satu index;
// pola itu benar HANYA bila kedua offcurve berdampingan di tengah array. Kalau keduanya melipat
// ujung array (offcurve ke-2 di index 0, mis. kontur yang daftar titiknya diawali offcurve),
// offcurve ke-2 ikut tersalin lagi → kontur rusak. Terukur: lingkaran 12 titik menjadi 16 titik
// (5 on, 11 off) padahal seharusnya 15 (5 on, 10 off).
export function addNode(pts: ContourPoint[], endIdx: number, t = 0.5): ContourPoint[] {
  const segIdx = segments(pts).findIndex((s) => s.endIdx === endIdx);
  if (segIdx < 0) return pts;                // endIdx bukan on-curve / kontur tak terbaca
  const [out] = insertMarks([pts], [{
    kind: "inflection", ci: 0, segIdx,
    t: Math.max(0.001, Math.min(0.999, t)), x: 0, y: 0,
  }]);
  return out;
}

// ── Analisis kontur: TITIK BELOK & EKSTREM ────────────────────────────────────
// Titik BELOK (inflection) = tempat arah lengkung berbalik (kurva berbentuk S).
// EKSTREM = tempat tangen mendatar/tegak (titik paling atas/bawah/kiri/kanan).
// Keduanya sebaiknya punya node: segmen ber-S sulit disetel, dan saat interpolasi
// antar-master posisi beloknya bergeser → muncul kerutan (kink) di berat antara.

export interface XY { x: number; y: number }

// Akar REAL dari a·t² + b·t + c = 0 yang berada di (0,1) eksklusif, terurut naik.
// Memakai bentuk stabil-numerik (q = −½(b + sgn(b)√D); akar = q/a dan c/q) supaya tak
// kehilangan presisi saat b² ≫ 4ac — di situ rumus sekolah mengurangkan dua bilangan
// yang hampir sama dan akar kecilnya hancur.
export function rootsIn01(a: number, b: number, c: number, eps = 1e-6): number[] {
  const out: number[] = [];
  const push = (t: number) => { if (Number.isFinite(t) && t > eps && t < 1 - eps) out.push(t); };
  if (Math.abs(a) < 1e-12) {                 // turun derajat → linear
    if (Math.abs(b) > 1e-12) push(-c / b);
    return out;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return out;
  const sq = Math.sqrt(disc);
  const q = -0.5 * (b + (b >= 0 ? sq : -sq));
  push(q / a);
  if (Math.abs(q) > 1e-12) push(c / q);
  return [...new Set(out)].sort((x, y) => x - y);
}

// Kubik dalam basis PANGKAT: B(t) = A·t³ + B·t² + C·t + D
function cubicPower(p0: XY, p1: XY, p2: XY, p3: XY) {
  return {
    ax: -p0.x + 3 * p1.x - 3 * p2.x + p3.x, ay: -p0.y + 3 * p1.y - 3 * p2.y + p3.y,
    bx: 3 * p0.x - 6 * p1.x + 3 * p2.x, by: 3 * p0.y - 6 * p1.y + 3 * p2.y,
    cx: -3 * p0.x + 3 * p1.x, cy: -3 * p0.y + 3 * p1.y,
  };
}

// TITIK BELOK kubik: akar dari cross(B′, B″) = 0 (pembilang kelengkungan berganti tanda).
//   B′  = 3A t² + 2B t + C
//   B″  = 6A t + 2B
//   cross(B′,B″) = B′x·B″y − B′y·B″x
// Suku t³ (18·AxAy − 18·AyAx) saling hapus, tersisa KUADRAT:
//   3(Ay·Bx − Ax·By)·t² + 3(Ay·Cx − Ax·Cy)·t + (By·Cx − Bx·Cy) = 0
// Diverifikasi pd S baku p0(0,0) p1(1,0) p2(0,1) p3(1,1) → t = ½ (benar, simetris).
export function cubicInflections(p0: XY, p1: XY, p2: XY, p3: XY): number[] {
  const k = cubicPower(p0, p1, p2, p3);
  return rootsIn01(
    3 * (k.ay * k.bx - k.ax * k.by),
    3 * (k.ay * k.cx - k.ax * k.cy),
    k.by * k.cx - k.bx * k.cy,
  );
}

// EKSTREM kubik: B′(t) = 0 per sumbu → 3A·t² + 2B·t + C = 0.
export function cubicExtrema(p0: XY, p1: XY, p2: XY, p3: XY): { t: number; axis: "x" | "y" }[] {
  const k = cubicPower(p0, p1, p2, p3);
  return [
    ...rootsIn01(3 * k.ax, 2 * k.bx, k.cx).map((t) => ({ t, axis: "x" as const })),
    ...rootsIn01(3 * k.ay, 2 * k.by, k.cy).map((t) => ({ t, axis: "y" as const })),
  ];
}

// EKSTREM kuadratik: B′(t) = 2[(1−t)(p1−p0) + t(p2−p1)] = 0 → linear per sumbu.
// (Kuadratik TIDAK punya titik belok: cross(B′,B″) = 4·cross(p1−p0, p2−p1) — KONSTAN,
//  jadi tandanya tak pernah berganti di tengah segmen.)
export function quadExtrema(p0: XY, p1: XY, p2: XY): { t: number; axis: "x" | "y" }[] {
  const one = (a: number, b: number, c: number, axis: "x" | "y") => {
    const den = a - 2 * b + c;
    if (Math.abs(den) < 1e-12) return [];
    const t = (a - b) / den;
    return t > 1e-6 && t < 1 - 1e-6 ? [{ t, axis }] : [];
  };
  return [...one(p0.x, p1.x, p2.x, "x"), ...one(p0.y, p1.y, p2.y, "y")];
}

export function cubicAt(p0: XY, p1: XY, p2: XY, p3: XY, t: number): XY {
  const m = 1 - t;
  return {
    x: m * m * m * p0.x + 3 * m * m * t * p1.x + 3 * m * t * t * p2.x + t * t * t * p3.x,
    y: m * m * m * p0.y + 3 * m * m * t * p1.y + 3 * m * t * t * p2.y + t * t * t * p3.y,
  };
}
export function quadAt(p0: XY, p1: XY, p2: XY, t: number): XY {
  const m = 1 - t;
  return {
    x: m * m * p0.x + 2 * m * t * p1.x + t * t * p2.x,
    y: m * m * p0.y + 2 * m * t * p1.y + t * t * p2.y,
  };
}

// Simpangan terjauh titik kendali dari TALI BUSUR p0→pEnd. Dipakai sebagai saringan
// "benar-benar melengkung": pada segmen yang praktis lurus, koefisien belok mengecil
// sampai seukuran derau dan akarnya jadi omong kosong — penanda yang muncul di situ
// cuma bikin kanvas ramai tanpa arti.
function chordDeviation(p0: XY, pEnd: XY, ctrl: XY[]): number {
  const dx = pEnd.x - p0.x, dy = pEnd.y - p0.y;
  const len = Math.hypot(dx, dy);
  let worst = 0;
  for (const c of ctrl) {
    const d = len < 1e-9
      ? Math.hypot(c.x - p0.x, c.y - p0.y)
      : Math.abs((c.x - p0.x) * dy - (c.y - p0.y) * dx) / len;
    if (d > worst) worst = d;
  }
  return worst;
}

// Satu segmen kontur: on-curve awal → offcurve (0/1/2) → on-curve akhir.
export interface Segment {
  startIdx: number;          // index on-curve awal di dalam array titik
  endIdx: number;            // index on-curve akhir
  start: ContourPoint;
  end: ContourPoint;
  offs: ContourPoint[];      // 0 = garis, 1 = kuadratik, 2 = kubik
}

// Pecah kontur jadi segmen berurutan, AMAN terhadap pelipatan array: segmen penutup
// (offcurve di ekor array, on-curve akhir di kepala) ditangani sama seperti yang lain.
export function segments(pts: ContourPoint[]): Segment[] {
  const n = pts.length;
  if (!n) return [];
  const onIdx: number[] = [];
  for (let i = 0; i < n; i++) if (pts[i].type !== "offcurve") onIdx.push(i);
  if (!onIdx.length) return [];              // kontur semua-offcurve → dilewati (spt contoursToPath)
  const segs: Segment[] = [];
  for (let k = 0; k < onIdx.length; k++) {
    const endIdx = onIdx[k];
    const startIdx = onIdx[(k - 1 + onIdx.length) % onIdx.length];
    const offs: ContourPoint[] = [];
    let i = (startIdx + 1) % n;
    // batas `offs.length < n` = jaring pengaman kalau data ganjil (mis. satu on-curve saja)
    while (i !== endIdx && pts[i].type === "offcurve" && offs.length < n) {
      offs.push(pts[i]);
      i = (i + 1) % n;
    }
    segs.push({ startIdx, endIdx, start: pts[startIdx], end: pts[endIdx], offs });
  }
  return segs;
}

export interface OutlineMark {
  kind: "inflection" | "extreme";
  ci: number;                // index kontur
  segIdx: number;            // index segmen di dalam kontur
  t: number;                 // parameter di sepanjang segmen (0..1)
  x: number; y: number;
  axis?: "x" | "y";          // hanya utk ekstrem
}

export interface AnalyzeOpts {
  inflections?: boolean;     // default true
  extremes?: boolean;        // default true
  flatTol?: number;          // simpangan minimum dari tali busur (unit font); default 1
  nodeTol?: number;          // jarak minimum ke node terdekat (unit font); default 2
}

// Cari titik belok & ekstrem yang BELUM punya node. Murni baca — tak mengubah kontur.
export function analyzeOutline(contours: ContourPoint[][], opts: AnalyzeOpts = {}): OutlineMark[] {
  const wantInf = opts.inflections !== false;
  const wantExt = opts.extremes !== false;
  const flatTol = opts.flatTol ?? 1;
  const nodeTol = opts.nodeTol ?? 2;
  const marks: OutlineMark[] = [];
  contours.forEach((pts, ci) => {
    segments(pts).forEach((seg, segIdx) => {
      const { start, end, offs } = seg;
      if (offs.length === 0) return;         // garis lurus: tak punya belok maupun ekstrem
      const ctrl = offs.map((o) => ({ x: o.x, y: o.y }));
      if (chordDeviation(start, end, ctrl) < flatTol) return;   // praktis lurus
      const at = (t: number) => offs.length === 2
        ? cubicAt(start, offs[0], offs[1], end, t)
        : quadAt(start, offs[0], end, t);
      const cand: { kind: OutlineMark["kind"]; t: number; axis?: "x" | "y" }[] = [];
      if (wantInf && offs.length === 2)
        for (const t of cubicInflections(start, offs[0], offs[1], end)) cand.push({ kind: "inflection", t });
      if (wantExt)
        for (const e of (offs.length === 2
          ? cubicExtrema(start, offs[0], offs[1], end)
          : quadExtrema(start, offs[0], end)))
          cand.push({ kind: "extreme", t: e.t, axis: e.axis });
      for (const c of cand) {
        const p = at(c.t);
        // sudah ada node di situ (ekstrem/belok tepat di ujung segmen) → bukan temuan
        if (Math.hypot(p.x - start.x, p.y - start.y) < nodeTol) continue;
        if (Math.hypot(p.x - end.x, p.y - end.y) < nodeTol) continue;
        marks.push({ kind: c.kind, ci, segIdx, t: c.t, x: p.x, y: p.y, axis: c.axis });
      }
    });
  });
  return marks;
}

// ── Sisip node di titik belok / ekstrem ───────────────────────────────────────

const lerpP = (a: XY, b: XY, t: number): XY => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });

// de Casteljau: pecah kubik di t → [kiri, kanan], masing-masing 4 titik kendali.
export function splitCubic(p0: XY, p1: XY, p2: XY, p3: XY, t: number): [XY[], XY[]] {
  const q0 = lerpP(p0, p1, t), q1 = lerpP(p1, p2, t), q2 = lerpP(p2, p3, t);
  const r0 = lerpP(q0, q1, t), r1 = lerpP(q1, q2, t);
  const s = lerpP(r0, r1, t);
  return [[p0, q0, r0, s], [s, r1, q2, p3]];
}
export function splitQuad(p0: XY, p1: XY, p2: XY, t: number): [XY[], XY[]] {
  const q0 = lerpP(p0, p1, t), q1 = lerpP(p1, p2, t);
  const s = lerpP(q0, q1, t);
  return [[p0, q0, s], [s, q1, p2]];
}

// Pecah satu segmen di BANYAK t sekaligus. Tiap pemecahan memparameterkan ulang sisa
// kurva, jadi t berikutnya harus dipetakan: t′ = (t − tSebelum) / (1 − tSebelum).
// Tanpa pemetaan itu, pemecahan kedua dst. mendarat di tempat yang salah.
function splitMany(ctrl: XY[], ts: number[]): XY[][] {
  const sorted = [...ts].sort((a, b) => a - b);
  const out: XY[][] = [];
  let cur = ctrl, prev = 0;
  for (const t of sorted) {
    const tt = (t - prev) / (1 - prev);
    if (!(tt > 1e-9 && tt < 1 - 1e-9)) continue;
    const [L, R] = cur.length === 4
      ? splitCubic(cur[0], cur[1], cur[2], cur[3], tt)
      : splitQuad(cur[0], cur[1], cur[2], tt);
    out.push(L);
    cur = R;
    prev = t;
  }
  out.push(cur);
  return out;
}

// Sisipkan node pada tiap posisi di `marks`. Kontur DIBANGUN ULANG dari daftar segmen —
// bukan disulam lewat index — sehingga segmen penutup (yang titik kendalinya melipat ke
// ujung array) diperlakukan persis sama dengan segmen lain.
export function insertMarks(contours: ContourPoint[][], marks: OutlineMark[]): ContourPoint[][] {
  if (!marks.length) return contours;
  const byContour = new Map<number, Map<number, number[]>>();
  for (const m of marks) {
    if (!byContour.has(m.ci)) byContour.set(m.ci, new Map());
    const segs = byContour.get(m.ci)!;
    if (!segs.has(m.segIdx)) segs.set(m.segIdx, []);
    segs.get(m.segIdx)!.push(m.t);
  }
  return contours.map((pts, ci) => {
    const want = byContour.get(ci);
    if (!want) return pts;
    const segs = segments(pts);
    if (!segs.length) return pts;
    const out: ContourPoint[] = [];
    let head = 0;                            // jumlah titik yang disumbang segmen ke-0
    segs.forEach((seg, si) => {
      const before = out.length;
      const rawTs = want.get(si);
      // ekstrem-x & ekstrem-y bisa jatuh di t yang (nyaris) sama → satu node saja
      // Saring t TAK-HINGGA lebih dulu: Math.max(1e-4, Math.min(1−1e-4, NaN)) tetap NaN, dan pada
      // cabang GARIS di bawah ia langsung jadi koordinat NaN (cabang kurva selamat karena splitMany
      // menolaknya). Satu titik NaN merusak seluruh path glyph.
      const ts = rawTs
        ? [...rawTs].filter((t) => Number.isFinite(t))
            .map((t) => Math.max(1e-4, Math.min(1 - 1e-4, t)))
            .sort((a, b) => a - b)
            .filter((t, i, arr) => i === 0 || t - arr[i - 1] > 1e-4)
        : [];
      if (!ts.length) {
        out.push(...seg.offs, seg.end);      // tak disentuh
      } else if (seg.offs.length === 0) {
        // segmen GARIS: sisipkan on-curve lurus di tiap t (dipakai "tambah node" manual;
        // analisis belok/ekstrem tak pernah menghasilkan t di segmen garis)
        for (const t of ts)
          out.push({ x: lerp(seg.start.x, seg.end.x, t), y: lerp(seg.start.y, seg.end.y, t),
                     type: "line", smooth: false });
        out.push(seg.end);
      } else {
        const parts = splitMany([seg.start, ...seg.offs, seg.end], ts);
        parts.forEach((part, pi) => {
          const last = pi === parts.length - 1;
          for (let k = 1; k < part.length - 1; k++)
            out.push({ x: part[k].x, y: part[k].y, type: "offcurve", smooth: false });
          const tip = part[part.length - 1];
          out.push(last
            // ujung asli: pertahankan tipe & sifat halusnya
            ? { ...seg.end, x: tip.x, y: tip.y }
            // node baru di tengah kurva → HALUS (tangen menyambung mulus)
            : { x: tip.x, y: tip.y, type: seg.end.type === "qcurve" ? "qcurve" : "curve", smooth: true });
        });
      }
      if (si === 0) head = out.length - before;
    });
    // Kembalikan ROTASI array seperti semula. `out` tersusun per-segmen sehingga diawali
    // offcurve milik segmen ke-0; input yang lazim (diawali on-curve) menaruh offcurve itu
    // di EKOR. Tanpa pemutaran ini, setiap penyisipan diam-diam menggeser urutan titik —
    // index seleksi & pembandingan outline jadi meleset tanpa sebab yang terlihat.
    // (Input yang memang diawali offcurve tetap setara secara siklik, hanya beda rotasi.)
    const k = head - 1;
    return k > 0 ? [...out.slice(k), ...out.slice(0, k)] : out;
  });
}

// Hapus node on-curve `idx` beserta offcurve segmen yang menuju ke node itu.
export function removeNode(pts: ContourPoint[], idx: number): ContourPoint[] {
  const n = pts.length;
  if (!n || !pts[idx]) return pts; // kontur sudah kosong / index tak valid
  if (pts[idx].type === "offcurve") return pts; // hanya on-curve
  const onCount = pts.filter((p) => p.type !== "offcurve").length;
  // tinggal ≤2 on-curve: kontur tak lagi berbentuk → hapus SELURUH kontur.
  // (Dulu di-guard "minimal 2" → dua node terakhir tak pernah bisa dihapus.)
  if (onCount <= 2) return [];
  const remove = new Set<number>([idx]);
  // offcurve tepat sebelum node (segmen yang menuju node ini)
  let i = (idx - 1 + n) % n;
  while (pts[i].type === "offcurve" && remove.size < n) {
    remove.add(i);
    i = (i - 1 + n) % n;
  }
  return pts.filter((_, k) => !remove.has(k));
}
