export type GlyphCategory =
  | "uppercase" | "lowercase" | "figures"
  | "alternate" | "ligature" | "multilingual" | "other";

export interface Glyph {
  name: string;
  unicode: number | null;
  char: string | null;
  advance: number;
  lsb: number;
  rsb: number;
  contours: number;
  category: GlyphCategory;
  empty: boolean;
}

export interface KernPair {
  left: string;
  right: string;
  value: number;
}

// Kerapatan Smart Kerning. Menskalakan KEKUATAN koreksi optik, bukan target — pasangan LURUS
// (H|H) tetap 0 di semua mode, jadi spacing yang sudah dirancang tak dilawan; yang berubah hanya
// seberapa agresif pasangan terbuka/bulat dirapatkan. Untuk merenggangkan SEMUA pasangan secara
// seragam, pakai scope "Semuanya" (tracking) — itu kontrol yang berbeda.
export type KernMode = "tight" | "medium" | "loose";
export const KERN_MODES: { id: KernMode; label: string; hint: string }[] = [
  { id: "tight",  label: "Dekat",  hint: "Rapatkan lebih agresif (×1,20) — pasangan lurus tetap 0" },
  { id: "medium", label: "Sedang", hint: "Seimbang (default) — koreksi optik penuh (×1,00)" },
  { id: "loose",  label: "Jauh",   hint: "Lebih longgar (×0,80) — koreksi optik ditahan" },
];

// KERAPATAN PRIBADI: pengali kekuatan koreksi optik yang DIUKUR dari pasangan yang Anda setel
// sendiri, lalu bisa diterapkan ke seluruh font. Berlapis di atas mode Dekat/Sedang/Jauh (yang
// sebenarnya cuma tiga angka tetap pada knop yang sama: 1,20 / 1,00 / 0,80).
// PENTING: rasio mengalikan KOREKSI, jadi pasangan lurus (H·H, koreksinya 0) tetap 0 — untuk
// merenggangkan semuanya secara merata, alatnya "Spasi global", bukan ini. `fit` memberi tahu
// model mana yang sebenarnya cocok dgn kebiasaan Anda.
export interface KernTastePair {
  left: string;
  right: string;
  value: number;   // nilai Anda
  base: number;    // saran dasar sistem (tanpa kerapatan pribadi)
  ratio: number;
}
export interface KernTaste {
  samples: number;        // pasangan yang Anda setel sendiri
  used: number;           // yang benar-benar bisa dipakai mengukur rasio
  zeroBase: number;       // saran sistem 0 → tak membawa informasi rasio
  flipped: number;        // tandanya berlawanan dgn saran → niat lain, bukan kerapatan
  ratio: number | null;   // median rasio, sudah dijepit ke [0,2 … 3,0]
  rawRatio?: number;
  clamped?: boolean;
  delta: number | null;   // median selisih (model pembanding)
  residualRatio?: number;
  residualDelta?: number;
  fit: "ratio" | "delta" | null;  // "delta" → yang Anda mau sebenarnya Spasi global
  pairs: KernTastePair[];
  mode: KernMode;
  current: number;        // kerapatan yang sedang tersimpan
}

// MEMORI KERAPATAN lintas-project, per pengguna. Menyimpan BUKTI mentah (tiap pasangan yang
// Anda setel + saran sistem + irama font saat itu); kesimpulannya dihitung ulang tiap dibaca.
// Kecenderungan spasi disimpan sbg pecahan irama font agar sahih dibawa ke desain lain;
// `suggestTracking` = terjemahannya ke unit font yang sedang dibuka.
export interface KernMemory {
  samples: number;
  projects: number;
  enough: boolean;               // < 3 sampel → sistem tak mengaku tahu apa-apa
  usedForRatio?: number;
  ratio: number | null;
  deltaFrac: number | null;
  fit: "ratio" | "delta" | null;
  residualRatio?: number | null;
  residualDelta?: number | null;
  catFactors?: Record<string, number>;  // kategori bentuk → faktor thd angka global (1 = sama)
  catCounts?: Record<string, number>;   // sampel per kategori
  catRatios?: Record<string, number>;   // faktor × global, siap dibaca manusia
  catPrior?: number;                    // bobot prior shrinkage
  suggestTracking?: number;      // deltaFrac × irama font ini (unit em)
  rhythm?: number;
  current: number;               // kerapatan yang sedang tersimpan di project ini
  updatedAt?: number | null;
}

// kerning ter-resolusi (level kelas/grup, §9.6)
export interface KernInfo {
  left: string;
  right: string;
  value: number;                 // efektif (resolusi grup)
  leftGroup: string | null;      // public.kern1.* glyph kiri (atau null)
  rightGroup: string | null;     // public.kern2.* glyph kanan
  classValue: number | null;     // nilai (grupKiri, grupKanan)
  pairValue: number | null;      // exception (glyphKiri, glyphKanan)
  custom?: boolean;              // true = DITETAPKAN pengguna (dari provenance UFO, tahan refresh)
}

// data render seluruh glyph (mode Text — sekali muat)
export interface GlyphRender {
  path: string;
  advance: number;
  components: { base: string; transform: number[] }[];
  outline?: ContourPoint[][]; // kontur terstruktur → node/handle & X-Ray di mode Text
}

// satu sisi pasangan kerning (glyph atau grup) untuk panel daftar
export interface KernSide {
  key: string;
  isGroup: boolean;
  label: string;
  char?: string | null;
  size?: number; // jumlah anggota (bila grup)
}
export interface KernListEntry {
  left: KernSide;
  right: KernSide;
  value: number;
}

export interface FeatureSummary {
  ligatures: string[];
  alternates: string[];
  stylisticSets: string[];
}

export interface Axis {
  tag: string;
  name: string;
  min: number;
  max: number;
  default: number;
}

export interface Master {
  value: number | null;
  ufo: string;
  name: string;
}

export interface ProjectState {
  empty: boolean;
  family?: string;
  style?: string;
  upm?: number;
  preset?: string;
  tracking?: number; // spasi global (em), berlapis di atas kerning
  kernRatio?: number;   // kerapatan pribadi (pengali koreksi optik); 1 = netral
  kernMode?: KernMode;  // mode kerapatan terakhir — dipakai seed Re-seed agar konsisten
  metadata?: Record<string, string>;
  glyphs?: Glyph[];
  groups?: Record<string, string[]>;
  kerningCount?: number;
  features?: FeatureSummary;
  axis?: Axis | null;
  masters?: Master[];
  variable?: boolean;
  presets?: string[];
  edgePresets?: string[];  // preset bermode spasi-seragam → UI tampilkan field margin
  edgeMargin?: number;     // margin kiri & kanan (unit em) utk preset spasi-seragam
  backup?: { at: number; op: string } | null; // cadangan Re-seed tersedia → "Batalkan Re-seed"
  respace?: { glyphs: number; keptKern: number; droppedKern: number; backup: boolean }; // hanya di respons Re-seed
  version?: number;
}

export type PointType = "line" | "curve" | "qcurve" | "move" | "offcurve";

export interface ContourPoint {
  x: number;
  y: number;
  type: PointType;
  smooth: boolean;
}

export interface StagedShape {
  id: number;
  d: string;
  bbox: [number, number, number, number];
  band: number;
  excluded: boolean;
}

export interface StagedGuide {
  id: number;
  y: number;
  type: "baseline" | "cap";
  linked?: boolean; // false = garis lepas dari grup se-tipe (gerak sendiri)
}

// Apa yang ikut bergerak saat sebuah garis panduan diseret (langkah 2 impor).
// Preferensi tampilan saja — TIDAK ikut tersimpan ke staging; yang disimpan hanya y & type.
export type GuideMode = "type" | "pair" | "single";
export const GUIDE_MODES: { id: GuideMode; label: string; hint: string }[] = [
  { id: "type", label: "Se-warna",
    hint: "Semua garis sewarna ikut bergerak (biru↔biru, merah↔merah) — jarak antar-baris tetap. Cocok utk menggeser seluruh lembar sekaligus." },
  { id: "pair", label: "Pasangan",
    hint: "Hanya cap & baseline BARIS ITU yang bergerak, jaraknya terkunci → baris naik/turun utuh tanpa mengubah skalanya. Pasangan ditentukan dari posisi (cap + baseline terdekat di bawahnya), sama seperti saat impor memasangkannya." },
  { id: "single", label: "Lepas",
    hint: "Hanya garis yang Anda seret. Dipakai utk mengubah tinggi cap satu baris (jarak cap↔base berubah → skala baris itu ikut berubah)." },
];

export interface StagingState {
  shapes: StagedShape[];
  guides: StagedGuide[];
  viewBox: [number, number, number, number];
  autoTokens: string[];
  keptCount: number;
  canUndo?: boolean;
  canRedo?: boolean;
}

export interface Anchor {
  name: string;
  x: number;
  y: number;
}

export interface GlyphComponent {
  base: string;        // nama glyph basis
  transform: number[]; // [xx, xy, yx, yy, dx, dy] (= SVG matrix)
  basePath: string;    // path kontur glyph basis (untuk render/move live)
  baseBounds?: number[] | null; // [xMin,yMin,xMax,yMax] glyph basis (untuk bbox elemen)
}

export interface GlyphDetail extends Glyph {
  path: string;
  ascender: number;
  descender: number;
  capHeight: number;
  xHeight: number;
  upm: number;
  outline: ContourPoint[][];
  anchors: Anchor[];
  components: GlyphComponent[];
}
