import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Move, Spline, Square, Circle, Trash2, ZoomIn, ZoomOut, Maximize, Undo2, Redo2, Magnet,
  Boxes, Ruler, ArrowLeftRight, Type, MousePointer2,
  FlipHorizontal2, FlipVertical2, RotateCcw, RotateCw, Anchor as AnchorIcon,
  Copy, Group, Ungroup, Combine, Loader2, Crosshair, Grid3x3, Moon, Sun, Check, X, Sparkles, Wand2 } from "lucide-react";
import { api } from "../api";
import { contoursToPath, addNode, removeNode, segClosest } from "../outline";
import type { Anchor, ContourPoint, Glyph, GlyphComponent, GlyphDetail, GlyphRender, KernInfo } from "../types";

const ANCHOR_COLOR = "#e8a13a"; // warna penanda anchor (amber)
const COMP_COLOR = "#4aa3df";   // warna komponen (biru)

// 6 mode ala FontLab.
type Mode = "contour" | "element" | "metrics" | "kerning" | "cleanup" | "text";
const TOOLS: { id: Mode; label: string; icon: any; hint: string; ready: boolean }[] = [
  { id: "contour", label: "Contour", icon: Spline, hint: "Edit node, handle, kontur", ready: true },
  { id: "element", label: "Element", icon: Boxes, hint: "Pindah/transform/group elemen utuh", ready: true },
  { id: "metrics", label: "Metrics", icon: Ruler, hint: "Advance & sidebearing", ready: true },
  { id: "kerning", label: "Kerning", icon: ArrowLeftRight, hint: "Atur pasangan kerning", ready: true },
  { id: "cleanup", label: "Rapikan", icon: Wand2, hint: "Hapus node/handle berlebih — bentuk dipertahankan", ready: true },
  { id: "text", label: "Text", icon: Type, hint: "Ketik/tempel teks (proofing)", ready: true },
];
// mode terakhir yang dipilih user — level modul agar SELAMAT dari remount per-glyph (key=nama)
const lastModeRef: { mode: Mode } = { mode: "contour" };
type Sel = Set<string>; // kunci node terpilih: "ci:pi" (multi-select)
const keyOf = (ci: number, pi: number) => `${ci}:${pi}`;
const parseKey = (k: string) => { const [ci, pi] = k.split(":"); return { ci: +ci, pi: +pi }; };
// perluas seleksi: tiap node on-curve membawa handle off-curve tetangganya → Map ci→Set(pi)
function expandSel(contours: ContourPoint[][], sel: Sel): Map<number, Set<number>> {
  const m = new Map<number, Set<number>>();
  const add = (ci: number, pi: number) => { if (!m.has(ci)) m.set(ci, new Set()); m.get(ci)!.add(pi); };
  for (const k of sel) {
    const { ci, pi } = parseKey(k); const c = contours[ci]; if (!c || !c[pi]) continue;
    add(ci, pi);
    if (c[pi].type !== "offcurve") {
      const n = c.length, prev = (pi - 1 + n) % n, next = (pi + 1) % n;
      if (c[prev].type === "offcurve") add(ci, prev);
      if (c[next].type === "offcurve") add(ci, next);
    }
  }
  return m;
}
type Snap = { contours: ContourPoint[][]; lsb: number; rsb: number; ascender: number; descender: number; capHeight: number; xHeight: number; components?: GlyphComponent[] };

export function GlyphEditor({
  name,
  glyphNames = [],
  charToName = {},
  fontV = 0,
  tracking = 0,
  onTracking,
  onKern,
  onChanged,
  onReload,
}: {
  name: string | null;
  glyphNames?: string[];
  charToName?: Record<string, string>;
  fontV?: number; // versi font (bump saat ada commit) → sinkron kern dgn panel samping
  tracking?: number; // spasi global (em)
  onTracking?: (v: number) => void;
  onKern?: () => void; // sinkron kern: bump editV (editor+panel refetch getKerning) + jadwalkan recompile webfont
  onChanged: (g: Glyph) => void;
  onReload?: () => Promise<void>; // muat ulang SELURUH project (dipakai operasi font-wide: rapatkan semua)
}) {
  const [d, setD] = useState<GlyphDetail | null>(null);
  // mode bertahan saat GANTI GLYPH: komponen di-remount per glyph (key=nama), jadi state biasa
  // selalu balik ke "contour" — simpan pilihan terakhir di variabel modul.
  const [mode, setModeState] = useState<Mode>(lastModeRef.mode);
  const setMode = (m: Mode) => { lastModeRef.mode = m; setModeState(m); };
  const [contours, setContours] = useState<ContourPoint[][]>([]);
  const [lsb, setLsb] = useState(0);
  const [rsb, setRsb] = useState(0);
  const [sel, setSel] = useState<Sel>(new Set());
  const selRef = useRef(sel); selRef.current = sel; // baca sinkron di handler drag
  const [marq, setMarq] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null); // kotak marquee (koord font)
  const primary = sel.size === 1 ? parseKey([...sel][0]) : null; // node tunggal → utk toggle smooth & readout
  // VIEW berbasis viewBox: fx/fy = pusat (fraksi frame konten), zoom = skala. SVG ukuran TETAP (= layar)
  // → hanya area terlihat yang dirender (raster konstan, tak peduli zoom). "render yang terlihat saja".
  const [view, setView] = useState({ fx: 0.5, fy: 0.5, zoom: 1 });
  const viewRef = useRef(view); viewRef.current = view;
  const setView2 = (v: { fx: number; fy: number; zoom: number }) => { viewRef.current = v; setView(v); };
  const [elem, setElem] = useState({ w: 800, h: 560 }); // ukuran piksel SVG (diukur via ResizeObserver)
  const frameRef = useRef({ vx: 0, vw: 1, vh: 1 });       // frame konten (utk listener wheel)
  const zoom = view.zoom;
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [snapOn, setSnapOn] = useState(false);          // snap ke GRID (kelipatan snapStep)
  const [snapStep, setSnapStep] = useState(10);
  const [showGrid, setShowGrid] = useState(() => localStorage.getItem("ge.grid") !== "0"); // garis grid kanvas (default AKTIF)
  useEffect(() => { localStorage.setItem("ge.grid", showGrid ? "1" : "0"); }, [showGrid]);
  const [canvasDark, setCanvasDark] = useState(() => localStorage.getItem("ge.canvasDark") === "1"); // kanvas gelap (opsional)
  useEffect(() => { localStorage.setItem("ge.canvasDark", canvasDark ? "1" : "0"); }, [canvasDark]);
  const [snapNodes, setSnapNodes] = useState(false);    // snap ALIGNMENT ke node/handle/metrik (opt-in; default off agar tak ganggu editing halus)
  const [snapG, setSnapG] = useState<{ x: number | null; y: number | null } | null>(null); // garis bantu snap (koord font)
  const [baseLineY, setBaseLineY] = useState(0); // posisi garis baseline saat diseret (ikut bergerak + nempel)
  // sub-alat dalam mode Contour: pilih node / gambar kotak / gambar elips / anchor
  const [tool, setTool] = useState<"select" | "rect" | "ellipse" | "anchor">("select");
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [anchors, setAnchors] = useState<Anchor[]>([]); // titik anchor glyph
  const [aSel, setASel] = useState<number | null>(null); // index anchor terpilih
  const anchorsRef = useRef(anchors); anchorsRef.current = anchors;
  const [comps, setComps] = useState<GlyphComponent[]>([]); // komponen (referensi glyph lain)
  const [cSel, setCSel] = useState<number | null>(null); // index komponen terpilih
  const compsRef = useRef(comps); compsRef.current = comps;
  const [addComp, setAddComp] = useState(""); // input nama glyph utk tambah komponen
  // ELEMENT mode: seleksi elemen utuh (kontur "c{i}" / komponen "m{i}") + grup (sesi-lokal)
  const [eSel, setESel] = useState<Set<string>>(new Set());
  const eSelRef = useRef(eSel); eSelRef.current = eSel;
  const [eGroups, setEGroups] = useState<string[][]>([]);
  const eGroupsRef = useRef(eGroups); eGroupsRef.current = eGroups;
  const [eMarq, setEMarq] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // METRICS mode: glyph referensi utk strip konteks spasi (lihat glyph di antara tetangga)
  const [ctxRef, setCtxRef] = useState("");
  const [refData, setRefData] = useState<{ path: string; advance: number } | null>(null);
  // KERNING mode: pasangan glyph aktif + partner, nilai kern (em)
  const [kernPartner, setKernPartner] = useState("");
  const [kernSelf, setKernSelf] = useState(name ?? ""); // glyph AKTIF pasangan — bisa diganti langsung di toolbar (tanpa klik panel kiri)
  const [kernSide, setKernSide] = useState<"left" | "right">("left"); // sisi glyph AKTIF dlm pasangan
  const [kernVal, setKernVal] = useState(0);
  const [kernInfo, setKernInfo] = useState<KernInfo | null>(null); // hasil resolusi (grup/exception)
  const [kernScope, setKernScope] = useState<"all" | "class" | "pair" | "smart">("class"); // Semuanya(tracking)/Kelas/Pasangan/Smart
  const [smartBusy, setSmartBusy] = useState(false); // sedang menghitung saran smart kern
  const [autoBusy, setAutoBusy] = useState(false); // sedang menjalankan auto-kern seluruh font
  const [autoMenu, setAutoMenu] = useState(false); // menu pilihan auto-kern (isi kosong / timpa semua)
  const [fitBusy, setFitBusy] = useState(false); // sedang merapatkan SEMUA glyph ke ink
  // mode Rapikan (bersihkan node/handle berlebih tanpa merusak bentuk)
  const [cleanBusy, setCleanBusy] = useState(false);
  const [cleanTol, setCleanTol] = useState(3);   // toleransi simpangan bentuk (unit em)
  const [cleanMsg, setCleanMsg] = useState<string | null>(null);
  // Nilai kerning/tracking kini DITAHAN dulu (pratinjau) → baru ditulis saat tombol "Terapkan"
  // diklik. kernDirty = ada nilai tertahan yang belum ditetapkan.
  const [kernDirty, setKernDirty] = useState(false);
  const kernDirtyRef = useRef(kernDirty); kernDirtyRef.current = kernDirty;
  const kernScopeRef = useRef(kernScope); kernScopeRef.current = kernScope; // utk .then fetch (scope bisa berganti selagi fetch jalan)
  const smartSkipRef = useRef(false); // one-shot: bump fontV berikut berasal dari apply smart kita → jangan hitung ulang saran
  const kernInfoRef = useRef<KernInfo | null>(null); kernInfoRef.current = kernInfo;
  const pendingKern = useRef<number | null>(null); // nilai kern yg BARU kita tulis → refetch echo tak menimpa nilai live
  // scope "Semuanya" = TRACKING GLOBAL (letter-spacing): nilai ABSOLUT & PERSISTEN yang berlaku
  // ke SEMUA pasangan (bukan hanya yang ber-kern) — live di preview (CSS letter-spacing) & di-bake
  // saat export. trackVal = nilai staged; disinkron dari project.tracking KECUALI saat sedang diedit.
  const [trackVal, setTrackVal] = useState(tracking);
  useEffect(() => { if (!kernDirtyRef.current) setTrackVal(tracking); }, [tracking]);
  const [kernBusy, setKernBusy] = useState(false); // proses perluas group
  const [partnerData, setPartnerData] = useState<{ path: string; advance: number } | null>(null);
  const [selfData, setSelfData] = useState<{ path: string; advance: number } | null>(null); // data glyph aktif pasangan bila ≠ glyph terpilih
  // TEXT mode: proofing teks bebas
  const [proofText, setProofText] = useState("");
  const [proofSize, setProofSize] = useState(96);
  const [proofKern, setProofKern] = useState(true);
  // mode Text: X-Ray (outline/rangka), node/handle, dan atur-kerning (seret glyph) — persist di localStorage
  const [proofXray, setProofXray] = useState(() => localStorage.getItem("ge.xray") === "1");
  const [proofNodes, setProofNodes] = useState(() => localStorage.getItem("ge.nodes") === "1");
  const [proofKernEdit, setProofKernEdit] = useState(() => localStorage.getItem("ge.kernEdit") === "1");
  useEffect(() => { localStorage.setItem("ge.xray", proofXray ? "1" : "0"); }, [proofXray]);
  useEffect(() => { localStorage.setItem("ge.nodes", proofNodes ? "1" : "0"); }, [proofNodes]);
  useEffect(() => { localStorage.setItem("ge.kernEdit", proofKernEdit ? "1" : "0"); }, [proofKernEdit]);
  const [proofZoom, setProofZoom] = useState(1); // zoom kanvas Text (⌘/Ctrl+scroll atau tombol)
  const zClamp = (z: number) => Math.min(8, Math.max(0.25, z));
  const glyphCache = useRef<Record<string, GlyphRender>>({}); // SEMUA glyph dimuat sekali → ketik instan
  const kernCache = useRef<Record<string, number>>({});
  // Anti-glitch mode Text (nilai "balik sendiri"/delay): respons refetch yang telat JANGAN menimpa
  // editan lokal yang lebih baru. kernWroteAt = stempel waktu tulisan kern lokal (dilindungi ~1.5s);
  // selfGlyphBump = bump fontV berasal dari editor sendiri & cache SUDAH disinkron → tak perlu
  // refetch glyphsRender penuh (dulu tiap commit refetch besar → berat + menimpa saat drag);
  // proofBusy = sedang seret di kanvas Text → respons wholesale ditunda/dibuang.
  const kernWroteAt = useRef<Record<string, number>>({});
  const selfGlyphBump = useRef(false);
  const proofBusy = useRef(false);
  const [proofTick, setProofTick] = useState(0); // paksa render saat cache terisi
  const [proofLoading, setProofLoading] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<any>(null);
  const contoursRef = useRef<ContourPoint[][]>([]);
  if (!drag.current) contoursRef.current = contours; // sinkron utk commit; saat drag dikelola applyContours
  // throttle update kontur ke 1×/frame (rAF) → kurangi re-render/raster saat drag (pointermove bisa >100/dtk)
  const rafId = useRef<number | null>(null);
  const pendingC = useRef<ContourPoint[][] | null>(null);
  function applyContours(next: ContourPoint[][]) {
    contoursRef.current = next; pendingC.current = next;
    if (rafId.current == null) rafId.current = requestAnimationFrame(() => {
      rafId.current = null; const p = pendingC.current; pendingC.current = null;
      if (p) setContours(p);
    });
  }
  // riwayat undo/redo (per glyph)
  const hist = useRef<Snap[]>([]);
  const hi = useRef(0);
  const applying = useRef(false);
  const lastPersisted = useRef<Snap | null>(null); // snapshot yg TERAKHIR ditulis ke backend (utk diff persist undo/redo)
  const persistGen = useRef(0);                     // generasi persist undo/redo → coalesce saat ⌘Z beruntun
  // antrean commit: serialkan semua tulis ke backend (urut, tak balapan saat operasi beruntun)
  const commitChain = useRef<Promise<unknown>>(Promise.resolve());
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = commitChain.current.then(fn, fn);
    commitChain.current = run.then(() => undefined, () => undefined);
    return run as Promise<T>;
  }
  // tepi VISUAL glyph (xMin/xMax) — STABIL selama edit spasi (glyph diam); hanya berubah
  // saat load / edit outline. Dipakai utk posisi bar; mencegah bar revert/lompat saat commit spasi.
  const bbox0 = useRef({ xMin: 0, xMax: 0 });

  useEffect(() => {
    if (!name) return;
    setD(null); setSel(new Set()); setASel(null); setCSel(null); setESel(new Set()); setEGroups([]); setBaseLineY(0); setView2({ fx: 0.5, fy: 0.5, zoom: 1 });
    api.glyph(name).then((g) => {
      bbox0.current = { xMin: g.lsb, xMax: g.advance - g.rsb };
      setD(g); setContours(g.outline); setLsb(g.lsb); setRsb(g.rsb); setAnchors(g.anchors ?? []); setComps(g.components ?? []);
      const snap0 = snapOf(g, g.outline, g.lsb, g.rsb);
      // persistGen TIDAK direset (monotonik) → job persist glyph lama yg masih tertunda tak salah ter-coalesce.
      hist.current = [snap0]; hi.current = 0; lastPersisted.current = snap0; updFlags();
    }).catch(() => setLoadErr(true)); // gagal muat → pesan jelas, bukan "Memuat…" selamanya
  }, [name]);
  const [loadErr, setLoadErr] = useState(false);

  // default glyph referensi (SEKALI saja per glyph — pakai init ref agar tak terisi ulang saat user mengosongkan)
  const ctxRefInit = useRef(false);
  useEffect(() => {
    if (ctxRefInit.current || !glyphNames.length || !d) return;
    ctxRefInit.current = true;
    if (ctxRef) return; // sudah terisi → jangan timpa
    const prefer = d.category === "uppercase" ? ["H", "O", "N", "n"]
      : d.category === "figures" ? ["zero", "one", "eight", "n"] : ["n", "o", "a", "H"];
    setCtxRef(prefer.find((x) => glyphNames.includes(x)) ?? glyphNames[0]);
  }, [d, glyphNames, ctxRef]);
  // ambil path+advance glyph referensi — hanya bila nama VALID (saat mengetik parsial jangan fetch 404)
  useEffect(() => {
    if (!ctxRef || !glyphNames.includes(ctxRef)) { setRefData(null); return; }
    let cancel = false;
    api.glyph(ctxRef).then((g) => { if (!cancel) setRefData({ path: g.path, advance: g.advance }); }).catch(() => { if (!cancel) setRefData(null); });
    return () => { cancel = true; };
  }, [ctxRef, glyphNames]);

  // KERNING: default partner (SEKALI saja — init ref agar bisa dihapus/ganti tanpa terisi ulang otomatis)
  const partnerInit = useRef(false);
  useEffect(() => {
    if (partnerInit.current || !glyphNames.length || !d) return;
    partnerInit.current = true;
    if (kernPartner) return; // sudah terisi → jangan timpa
    const prefer = d.category === "uppercase" ? ["A", "V", "T", "O"] : ["o", "a", "n", "v"];
    setKernPartner(prefer.find((x) => glyphNames.includes(x) && x !== name) ?? glyphNames.find((x) => x !== name) ?? glyphNames[0]);
  }, [d, glyphNames, kernPartner, name]);
  // input pasangan menerima NAMA GLYPH atau SATU KARAKTER (dipetakan via charToName) → cepat diketik
  const resolveGlyph = (s: string) => (glyphNames.includes(s) ? s : (charToName[s] ?? s));
  const kernPartnerName = resolveGlyph(kernPartner);
  const kernSelfName = resolveGlyph(kernSelf);
  // ambil path+advance partner — hanya bila nama VALID (ketik parsial di dropdown ≠ fetch 404 beruntun)
  useEffect(() => {
    if (!kernPartnerName || !glyphNames.includes(kernPartnerName)) { setPartnerData(null); return; }
    let cancel = false;
    api.glyph(kernPartnerName).then((g) => { if (!cancel) setPartnerData({ path: g.path, advance: g.advance }); }).catch(() => { if (!cancel) setPartnerData(null); });
    return () => { cancel = true; };
  }, [kernPartnerName, glyphNames]);
  // glyph AKTIF pasangan bisa diganti di toolbar → ambil datanya bila ≠ glyph terpilih di panel kiri
  useEffect(() => {
    if (!kernSelfName || kernSelfName === name || !glyphNames.includes(kernSelfName)) { setSelfData(null); return; }
    let cancel = false;
    api.glyph(kernSelfName).then((g) => { if (!cancel) setSelfData({ path: g.path, advance: g.advance }); }).catch(() => { if (!cancel) setSelfData(null); });
    return () => { cancel = true; };
  }, [kernSelfName, name, glyphNames]);
  // nama kiri/kanan pasangan (tergantung sisi glyph aktif)
  const kernLeft = kernSide === "left" ? kernSelfName : kernPartnerName;
  const kernRight = kernSide === "left" ? kernPartnerName : kernSelfName;
  // nilai kern utk scope aktif (pasangan → pairValue; class/smart → classValue sbg baseline)
  const kernScoped = (k: KernInfo | null, scope: "all" | "class" | "pair" | "smart") =>
    !k ? 0 : (scope === "pair" ? (k.pairValue ?? 0) : (k.classValue ?? 0));
  // pasangan berganti → reset guard echo + buang nilai tertahan. Ref di-sync SINKRON:
  // efek smart di bawah berjalan pada commit yang sama & membaca ref ini — kalau hanya setState,
  // ref masih berisi dirty lama → computeSmart terlewat → saran smart tak pernah dihitung.
  useEffect(() => { pendingKern.current = null; smartSkipRef.current = false; kernDirtyRef.current = false; setKernDirty(false);
    if (kernScopeRef.current === "all") setTrackVal(tracking); // scope "Semuanya": buang draft spasi yg belum diterapkan agar field tak menyesatkan (tampil "40" padahal belum tersimpan)
  }, [kernLeft, kernRight]); // eslint-disable-line react-hooks/exhaustive-deps
  // ambil info kern saat pasangan berubah — HANYA di mode Kerning (hemat: commit node/spasi
  // di mode lain tak perlu memicu fetch kern; masuk mode Kerning → fetch segar via dep `mode`)
  useEffect(() => {
    if (mode !== "kerning") return;
    if (!kernLeft || !kernRight || !glyphNames.includes(kernLeft) || !glyphNames.includes(kernRight)) { setKernInfo(null); setKernVal(0); return; }
    let cancel = false;
    api.getKerning(kernLeft, kernRight).then((k) => { if (!cancel) { setKernInfo(k); const sv = kernScoped(k, kernScopeRef.current);
      if (sv !== pendingKern.current && !kernDirtyRef.current) setKernVal(sv);        // nilai tertahan JANGAN ditimpa refetch
      else if (sv === pendingKern.current) pendingKern.current = null; } })            // echo tulisan sudah tiba → lepas guard (refetch berikut boleh masuk)
      .catch(() => { if (!cancel) { setKernInfo(null); setKernVal(0); } });
    return () => { cancel = true; };
  }, [mode, kernLeft, kernRight, fontV]); // eslint-disable-line react-hooks/exhaustive-deps  // fontV → refetch saat kern berubah
  // ganti scope → nilai tertahan scope lama SELALU dibuang (sync ref: efek smart di bawah berjalan
  // pada commit yang sama & membacanya — tanpa ini, draft kelas/pasangan nyangkut sbg "saran Smart" palsu).
  useEffect(() => {
    kernDirtyRef.current = false; setKernDirty(false); setTrackVal(tracking); // "Semuanya" tampil tracking tersimpan
    if (kernScope === "smart") return; // saran dihitung efek smart di bawah
    setKernVal(kernScoped(kernInfoRef.current, kernScope));
  }, [kernScope]); // eslint-disable-line react-hooks/exhaustive-deps
  // SMART KERNING: hitung saran optikal (sadar-bentuk) dari outline pasangan → tahan sbg nilai
  // yang siap "Terapkan". Baseline diambil SEGAR (paralel) — kernInfoRef bisa masih milik pasangan lama.
  const computeSmart = useCallback(async () => {
    if (!kernLeft || !kernRight || !glyphNames.includes(kernLeft) || !glyphNames.includes(kernRight)) return;
    setSmartBusy(true);
    try {
      const [r, k] = await Promise.all([api.smartKern(kernLeft, kernRight), api.getKerning(kernLeft, kernRight)]);
      setKernInfo(k); kernInfoRef.current = k;
      setKernVal(r.value);
      const dirty = r.value !== (k.classValue ?? 0);
      kernDirtyRef.current = dirty; setKernDirty(dirty); // beda dari tersimpan → tawarkan "Terapkan"
    } catch { /* abaikan */ }
    finally { setSmartBusy(false); }
  }, [kernLeft, kernRight, glyphNames]);
  useEffect(() => {
    if (mode !== "kerning" || kernScope !== "smart" || kernDirtyRef.current) return;
    if (smartSkipRef.current) { smartSkipRef.current = false; return; } // bump fontV dari apply kita sendiri → jangan timpa nilai yang baru diterapkan dgn saran baru
    computeSmart();
  }, [kernScope, mode, computeSmart, fontV]);
  // AUTO-KERN SELURUH FONT: hitung + terapkan kern optikal utk semua pasangan huruf/angka.
  // Dua mode (pilihan user): onlyEmpty=true → hanya MENGISI yang belum diatur (aman);
  // onlyEmpty=false → TIMPA SEMUA (termasuk yang sudah diatur manual).
  async function runAutoKernAll(onlyEmpty: boolean) {
    if (autoBusy) return;
    const msg = onlyEmpty
      ? "Auto-kern optikal pasangan huruf & angka?\n\nHanya MENGISI pasangan yang belum punya kerning — nilai yang sudah Anda atur TIDAK diubah. Bisa memakan beberapa detik."
      : "Auto-kern optikal SEMUA pasangan huruf & angka?\n\n⚠️ Nilai kerning yang sudah Anda atur akan DITIMPA hasil hitung optikal. Bisa memakan beberapa detik.";
    if (!confirm(msg)) return;
    setAutoBusy(true);
    try {
      const r = await serial(() => api.autoKernAll(onlyEmpty));
      onKern?.(); // bump editV → panel & webfont menyusul
      alert(`Auto-kern selesai:\n${r.written} pasangan ditulis · ${r.skipped} dilewati\ndari ${r.candidates} glyph huruf/angka.`);
    } catch (e) {
      alert("Auto-kern gagal: " + ((e as Error).message || e));
    } finally {
      setAutoBusy(false);
    }
  }
  // RAPATKAN SEMUA: sidebearing tiap glyph menempel ke node terluar (LSB=0, RSB=0). Font-wide →
  // muat ulang seluruh project setelahnya. Permanen (konfirmasi dulu).
  async function runFitAll() {
    if (fitBusy) return;
    if (!confirm(
      "Rapatkan SEMUA glyph ke ink?\n\n" +
      "Batas kiri/kanan setiap glyph akan menempel ke node terluar (LSB=0, RSB=0, advance = lebar ink). " +
      "Berlaku permanen ke seluruh font.\n\n" +
      "Setelah ini glyph tak punya spasi samping — atur jarak lewat preset/kerning bila perlu.")) return;
    setFitBusy(true);
    try {
      const r = await serial(() => api.fitAll());
      await onReload?.();
      // glyph aktif: effect load hanya keyed [name] (tak refire di fit-all) → refetch manual biar tak stale
      if (name) {
        const g = await api.glyph(name);
        bbox0.current = { xMin: g.lsb, xMax: g.advance - g.rsb };
        setD(g); setContours(g.outline); contoursRef.current = g.outline;
        setLsb(g.lsb); setRsb(g.rsb); setAnchors(g.anchors ?? []); setComps(g.components ?? []);
        const snap0 = snapOf(g, g.outline, g.lsb, g.rsb);
        hist.current = [snap0]; hi.current = 0; lastPersisted.current = snap0; updFlags();
      }
      alert(`Selesai: ${r.fitted} glyph dirapatkan ke ink${r.skipped ? ` · ${r.skipped} dilewati (tanpa ink)` : ""}.`);
    } catch (e) {
      alert("Rapatkan semua gagal: " + ((e as Error).message || e));
    } finally { setFitBusy(false); }
  }
  // RAPIKAN: hapus node/handle yang tak dibutuhkan — bentuk dipertahankan (toleransi di slider).
  // Hasil masuk histori (⌘Z membatalkan) & tersinkron ke semua mode (cache Text, grid, panel).
  async function runCleanup() {
    if (!name || !d || cleanBusy) return;
    const before = contours.reduce((n, c) => n + c.length, 0);
    setCleanBusy(true); setCleanMsg(null);
    try {
      const res = await serial(() => api.simplifyGlyph(name, cleanTol));
      const after = res.outline.reduce((n, c) => n + c.length, 0);
      setContours(res.outline); contoursRef.current = res.outline;
      setLsb(res.lsb); setRsb(res.rsb); bbox0.current = { xMin: res.lsb, xMax: res.advance - res.rsb };
      setD((p) => (p ? { ...p, ...res } : res));
      syncCacheOutline(name, res.outline, res.advance);
      pushHist({ contours: res.outline, lsb: res.lsb, rsb: res.rsb, ascender: res.ascender, descender: res.descender, capHeight: res.capHeight, xHeight: res.xHeight });
      onChanged({ name, unicode: res.unicode, char: res.char, advance: res.advance,
        lsb: res.lsb, rsb: res.rsb, contours: res.contours, category: res.category, empty: res.empty });
      setCleanMsg(after < before ? `${before} → ${after} titik (−${before - after}) · ⌘Z untuk membatalkan` : "Sudah rapi — tidak ada titik berlebih pada toleransi ini");
    } catch (e) {
      setCleanMsg("Gagal: " + ((e as Error).message || e));
    } finally { setCleanBusy(false); }
  }
  // keluar dari mode Kerning dgn nilai tertahan → BUANG SEPENUHNYA: kembalikan juga kernVal &
  // guard echo. (Dulu hanya setKernDirty(false) → draft nyangkut tampil sbg "tersimpan" palsu
  // saat masuk lagi, krn refetch di-skip oleh guard pendingKern.)
  useEffect(() => {
    if (mode !== "kerning" && kernDirtyRef.current) {
      kernDirtyRef.current = false; setKernDirty(false); setTrackVal(tracking);
      pendingKern.current = null;
      setKernVal(kernScoped(kernInfoRef.current, kernScopeRef.current));
    }
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  // STAGE: seret kanvas / ketik angka → pratinjau live + tandai "belum ditetapkan" (tak menulis apa pun)
  function stageKern(v: number) {
    if (kernScope === "all") { setTrackVal(v); setKernDirty(v !== tracking); return; }
    setKernVal(v); setKernDirty(v !== kernScoped(kernInfoRef.current, kernScope));
  }
  // TERAPKAN: tulis nilai tertahan (tracking global / kern kelas / exception pasangan)
  function applyKern() {
    if (kernScope === "all") {
      // "Semuanya" = tracking global ABSOLUT: berlaku ke SEMUA pasangan (live preview + bake export).
      // Non-destruktif (tak mengubah kerning) & PERSISTEN (field tetap menunjukkan nilainya).
      onTracking?.(Math.round(trackVal)); setKernDirty(false); return;
    }
    if (kernScope === "smart") smartSkipRef.current = true; // bump fontV hasil apply ini jangan memicu hitung-ulang yang menimpa nilai baru
    commitKern(kernVal); setKernDirty(false);
  }
  // BATAL: buang nilai tertahan, kembali ke nilai tersimpan
  function cancelKern() {
    if (kernScope === "all") setTrackVal(tracking); // kembali ke tracking tersimpan
    else setKernVal(kernScoped(kernInfoRef.current, kernScope));
    setKernDirty(false);
  }
  function commitKern(v: number) {
    if (!kernLeft || !kernRight || kernScope === "all") return; // "Semuanya" = tracking, bukan kern pasangan
    if (!glyphNames.includes(kernLeft) || !glyphNames.includes(kernRight)) return; // partner belum valid → jangan tulis
    const writeScope = kernScope === "smart" ? "class" : kernScope; // Smart → ditulis di level kelas (menyebar ke se-grup)
    setKernVal(v); pendingKern.current = v;                     // instan (JANGAN ditimpa respons/echo → tak lompat)
    const key = `${kernLeft} ${kernRight}`;
    kernCache.current[key] = v; kernWroteAt.current[key] = Date.now(); // proof teks ikut seketika + terlindung dari refetch telat
    setProofTick((t) => t + 1);
    // tulis CEPAT tanpa recompile webfont; setelah tersimpan → onKern bump editV (panel refetch getKerning) + jadwalkan recompile
    serial(() => api.setKerning({ left: kernLeft, right: kernRight, value: v, scope: writeScope, recompile: false }))
      .then((k) => { setKernInfo(k); kernInfoRef.current = k; onKern?.(); })
      .catch(() => { /* abaikan */ });
  }
  // TEXT mode: atur kerning langsung dgn menyeret glyph (kern dgn glyph sebelumnya). Live via cache
  // (glyph geser seketika); commit CEPAT (recompile=false) lalu onKern → sinkron panel & webfont.
  function proofKernLive(l: string, r: string, v: number) {
    const key = `${l} ${r}`;
    kernCache.current[key] = v; kernWroteAt.current[key] = Date.now();
    setProofTick((t) => t + 1);
  }
  function proofKernCommit(l: string, r: string, v: number) {
    const key = `${l} ${r}`;
    kernCache.current[key] = v; kernWroteAt.current[key] = Date.now();
    setProofTick((t) => t + 1);
    serial(() => api.setKerning({ left: l, right: r, value: v, scope: "class", recompile: false }))
      .then((k) => {
        kernCache.current[key] = k.value; kernWroteAt.current[key] = Date.now();
        selfGlyphBump.current = true; // bump fontV berikut berasal dari kita → jangan refetch glyphsRender penuh
        setProofTick((t) => t + 1); onKern?.();
      })
      .catch(() => { /* abaikan */ });
  }
  // Sinkron cache glyph mode Text saat outline berubah DARI MANA PUN (Contour/Text/undo) → real-time
  // lintas mode: semua kemunculan glyph di teks + thumbnail ikut segar tanpa menunggu refetch.
  function syncCacheOutline(nm: string, outline: ContourPoint[][], advance?: number) {
    const prev = glyphCache.current[nm];
    if (prev) {
      glyphCache.current[nm] = { ...prev, outline, path: contoursToPath(outline), ...(advance != null ? { advance } : {}) };
      selfGlyphBump.current = true; // cache sudah sinkron → bump fontV berikut tak perlu refetch penuh
    }
  }
  // TEXT mode: edit node/handle glyph terpilih langsung di kanvas. Live: cache; commit: tulis outline.
  function proofOutlineLive(nm: string, contours: ContourPoint[][]) {
    syncCacheOutline(nm, contours);
    setProofTick((t) => t + 1);
  }
  function proofOutlineCommit(nm: string, contours: ContourPoint[][]) {
    proofOutlineLive(nm, contours);
    serial(() => api.setOutline(nm, contours)).then((res) => {
      glyphCache.current[nm] = {
        path: res.path, advance: res.advance, outline: res.outline,
        components: (res.components ?? []).map((c) => ({ base: c.base, transform: c.transform })),
      };
      setProofTick((t) => t + 1);
      if (nm === name) { // glyph aktif → sinkronkan state Contour + histori undo (edit Text = real-time di Contour)
        setContours(res.outline); contoursRef.current = res.outline;
        setLsb(res.lsb); setRsb(res.rsb); bbox0.current = { xMin: res.lsb, xMax: res.advance - res.rsb };
        setD((p) => (p ? { ...p, ...res } : res));
        pushHist({ contours: res.outline, lsb: res.lsb, rsb: res.rsb, ascender: res.ascender, descender: res.descender, capHeight: res.capHeight, xHeight: res.xHeight });
      }
      onChanged({ name: nm, unicode: res.unicode, char: res.char, advance: res.advance,
        lsb: res.lsb, rsb: res.rsb, contours: res.contours, category: res.category, empty: res.empty });
    }).catch(() => { /* abaikan */ });
  }
  // "Nolkan semua kerning" kini di TopBar (App.onClearKern) — aksi font-wide global, di samping "Re-seed".
  async function expandKernClasses() {
    setKernBusy(true);
    try {
      await serial(() => api.expandKernGroups());
      if (kernLeft && kernRight) { const k = await api.getKerning(kernLeft, kernRight); setKernInfo(k); kernInfoRef.current = k; setKernVal(kernScoped(k, kernScope)); }
      if (d) onChanged({ name: name!, unicode: d.unicode, char: d.char, advance: d.advance, lsb: d.lsb, rsb: d.rsb, contours: d.contours, category: d.category, empty: d.empty });
    } catch { /* gagal perluas → biarkan state lama (jangan unhandled rejection) */ }
    finally { setKernBusy(false); }
  }

  // TEXT: muat SEMUA glyph SEKALI saat masuk mode text → ketik langsung tampil (tanpa fetch per-huruf).
  // Cache per-versi: keluar-masuk mode TANPA edit apa pun = instan (tak fetch ulang ~270KB);
  // ada edit (fontV berubah) → fetch segar.
  const proofLoadedV = useRef(-1);
  const kernVerRef = useRef(-1); // versi font terakhir saat kern di-resolve → deteksi perlu refetch
  // KONSUMSI selfGlyphBump di SETIAP perubahan fontV (mode-independent, jalan lebih dulu) → tak "nyangkut"
  // ke bump berikutnya. Bump dari edit yang SUDAH sinkron cache → tandai cache mutakhir (skip refetch).
  // Bump lain (respace/expand/metrik) → biarkan proofLoadedV basi → efek Text refetch penuh.
  useEffect(() => {
    if (selfGlyphBump.current) { selfGlyphBump.current = false; proofLoadedV.current = fontV; }
  }, [fontV]);
  useEffect(() => {
    if (mode !== "text") return;
    if (proofLoadedV.current === fontV && Object.keys(glyphCache.current).length) return;
    let cancel = false; setProofLoading(true);
    api.glyphsRender().then((r) => {
      if (cancel) return;
      // JANGAN kosongkan kernCache di sini — dulu ini bikin kern "balik sendiri" ke 0 setelah commit.
      // Nilai kern disegarkan oleh efek resolve-kern (dep fontV) yang refetch pasangan terlihat.
      if (proofBusy.current && Object.keys(glyphCache.current).length) { setProofLoading(false); return; } // sedang seret → jangan timpa
      glyphCache.current = r.glyphs; proofLoadedV.current = fontV;
      setProofLoading(false); setProofTick((t) => t + 1);
    }).catch(() => { if (!cancel) setProofLoading(false); });
    return () => { cancel = true; };
  }, [mode, fontV]);
  // TEXT: resolve KERN pasangan yg terlihat (glyph sudah dimuat; kern menyusul, ringan, debounce kecil)
  useEffect(() => {
    if (mode !== "text" || !proofKern || !proofText.trim()) return;
    const fontChanged = kernVerRef.current !== fontV;
    const timer = setTimeout(async () => {
      kernVerRef.current = fontV; // konsumsi DI DALAM timer — kalau di badan efek, debounce yang dibatalkan (ketikan beruntun <120ms) menelan sinyal & pasangan terlihat tak pernah disegarkan
      const pairs = new Set<string>();
      for (const line of proofText.split("\n")) {
        let prev: string | null = null;
        for (const ch of line) { const nm = charToName[ch]; if (!nm) { prev = null; continue; } if (prev) pairs.add(`${prev} ${nm}`); prev = nm; }
      }
      // font berubah (kern diedit / recompile / expand) → segarkan SEMUA pasangan terlihat;
      // hanya teks yang berubah → cukup pasangan yang belum ada di cache.
      // KECUALI pasangan yang BARU ditulis lokal (<1.5s): respons refetch bisa lebih tua dari
      // tulisan kita (GET tak lewat antrean serial) → menimpa = nilai "balik sendiri" saat diseret.
      const fresh = (p: string) => Date.now() - (kernWroteAt.current[p] ?? 0) < 1500;
      if (fontChanged) // pasangan ter-cache yang TAK terlihat ikut basi (mis. auto-kern/kelas) → buang; difetch lagi saat muncul
        for (const p of Object.keys(kernCache.current)) if (!pairs.has(p) && !fresh(p)) delete kernCache.current[p];
      const need = fontChanged ? [...pairs].filter((p) => !fresh(p))
                               : [...pairs].filter((p) => !(p in kernCache.current));
      if (!need.length) return;
      const got = await Promise.all(need.map((p) => { const [l, r] = p.split(" "); return api.getKerning(l, r).then((k) => [p, k.value] as const).catch(() => [p, 0] as const); }));
      for (const e of got) { if (!fresh(e[0])) kernCache.current[e[0]] = e[1]; } // cek ulang saat respons tiba
      setProofTick((t) => t + 1);
    }, 120);
    return () => clearTimeout(timer);
  }, [mode, proofText, charToName, proofKern, fontV]);

  function snapOf(m: GlyphDetail, c: ContourPoint[][], l: number, r: number): Snap {
    return { contours: c, lsb: l, rsb: r, ascender: m.ascender, descender: m.descender, capHeight: m.capHeight, xHeight: m.xHeight, components: m.components ?? [] };
  }
  function updFlags() { setCanUndo(hi.current > 0); setCanRedo(hi.current < hist.current.length - 1); }
  function pushHist(s: Snap) {
    if (applying.current) return;
    // komponen disuntik otomatis dari state terkini bila pemanggil tak menyertakannya
    const snap: Snap = { ...s, components: s.components ?? compsRef.current };
    hist.current = hist.current.slice(0, hi.current + 1);
    hist.current.push(snap);
    if (hist.current.length > 60) hist.current.shift();
    hi.current = hist.current.length - 1; updFlags();
    // commit ini SUDAH ditulis ke backend (pushHist dipanggil di akhir body serial) → jadi acuan diff persist.
    lastPersisted.current = snap;
  }

  // keyboard: Delete node · ⌘Z undo · ⌘⇧Z / ⌘Y redo
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // sedang mengetik di kolom input/textarea → JANGAN bajak (Backspace ≠ hapus node, ⌘Z ≠ undo glyph)
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
      if (mode === "element") {
        if (mod && e.key.toLowerCase() === "a") { e.preventDefault();
          setESel(new Set([...contours.map((_, i) => `c${i}`), ...comps.map((_, i) => `m${i}`)])); return; }
        if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateElements(); return; }
        if (mod && e.key.toLowerCase() === "g") { e.preventDefault(); e.shiftKey ? ungroupSel() : groupSel(); return; }
        if (!eSel.size) return;
        if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteElements(); return; }
        const EN: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
        if (EN[e.key]) { e.preventDefault(); const st = (snapOn && snapStep > 0 ? snapStep : 1) * (e.shiftKey ? 10 : 1); nudgeElements(EN[e.key][0] * st, EN[e.key][1] * st); }
        return;
      }
      if (mode !== "contour") return;
      if (e.key === "Delete" || e.key === "Backspace") {
        if (cSel != null) { e.preventDefault(); deleteComp(cSel); return; }
        if (aSel != null) { e.preventDefault(); deleteAnchor(aSel); return; }
        if (sel.size) { e.preventDefault(); doRemove(); }
        return;
      }
      if (!sel.size) return;
      const NUD: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
      if (NUD[e.key]) { // panah = geser node terpilih (Shift = 10×); y-up
        e.preventDefault();
        const step = (snapOn && snapStep > 0 ? snapStep : 1) * (e.shiftKey ? 10 : 1);
        const [ux, uy] = NUD[e.key];
        nudgeSel(ux * step, uy * step);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const path = useMemo(() => contoursToPath(contours), [contours]);

  // ---- zoom/pan berbasis viewBox (render hanya area terlihat) ----
  const clampZ = (z: number) => Math.min(12, Math.max(0.3, z));
  // viewBox kini = jendela terlihat dari frame konten; aspek viewBox = aspek elemen (tanpa distorsi)
  function zoomAtCursor(factor: number, clientX: number, clientY: number) {
    const svg = svgRef.current; if (!svg) return;
    const r = svg.getBoundingClientRect();
    const { vx, vw, vh } = frameRef.current; const v = viewRef.current;
    const aspect = r.width / r.height;
    const efx = (clientX - r.left) / r.width, efy = (clientY - r.top) / r.height;
    const fitW = Math.max(vw, vh * aspect);
    const vbW = fitW / v.zoom, vbH = vbW / aspect;
    const vbX = (vx + v.fx * vw) - vbW / 2, vbY = (v.fy * vh) - vbH / 2;
    const Px = vbX + efx * vbW, Py = vbY + efy * vbH;      // titik konten di bawah kursor
    const nz = clampZ(v.zoom * factor);
    const vbW2 = fitW / nz, vbH2 = vbW2 / aspect;
    const ccx2 = (Px - efx * vbW2) + vbW2 / 2, ccy2 = (Py - efy * vbH2) + vbH2 / 2;
    setView2({ fx: (ccx2 - vx) / vw, fy: ccy2 / vh, zoom: nz });
  }
  function panBy(dxPx: number, dyPx: number) {
    const svg = svgRef.current; if (!svg) return;
    const r = svg.getBoundingClientRect();
    const { vx, vw, vh } = frameRef.current; const v = viewRef.current;
    const aspect = r.width / r.height;
    const vbW = Math.max(vw, vh * aspect) / v.zoom;
    const upp = vbW / r.width;
    setView2({ fx: v.fx + (dxPx * upp) / vw, fy: v.fy + (dyPx * upp) / vh, zoom: v.zoom });
  }
  // listener wheel non-pasif + ResizeObserver via callback-ref (terpasang saat svg mount)
  const cleanupCanvas = useRef<(() => void) | undefined>(undefined);
  const svgCb = useCallback((el: SVGSVGElement | null) => {
    cleanupCanvas.current?.(); cleanupCanvas.current = undefined;
    svgRef.current = el;
    if (el) {
      const wheel = (e: WheelEvent) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) zoomAtCursor(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
        else panBy(-e.deltaX, -e.deltaY); // scroll = geser
      };
      el.addEventListener("wheel", wheel, { passive: false });
      const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); if (r.width && r.height) setElem({ w: r.width, h: r.height }); });
      ro.observe(el);
      const r0 = el.getBoundingClientRect(); if (r0.width && r0.height) setElem({ w: r0.width, h: r0.height });
      cleanupCanvas.current = () => { el.removeEventListener("wheel", wheel); ro.disconnect(); };
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  function zoomBtn(f: number) { const r = svgRef.current!.getBoundingClientRect(); zoomAtCursor(f, r.left + r.width / 2, r.top + r.height / 2); }
  function resetView() { setView2({ fx: 0.5, fy: 0.5, zoom: 1 }); }

  if (!name) return <div className="flex-1 grid place-items-center text-faint">Pilih glyph</div>;
  if (!d) return <div className="flex-1 grid place-items-center text-faint">{loadErr ? "Gagal memuat glyph — cek server lalu pilih ulang." : "Memuat glyph…"}</div>;

  // palet kanvas: terang (putih) / gelap — tinta, garis metrik, grid, handle ikut kontras
  const cv = canvasDark
    ? { bg: "#14171d", ink: "#e7eaf1", hollow: "#14171d", line: "#414b5c", line2: "#333a47", gMinor: "#262d39", gMajor: "#3c4656" }
    : { bg: "#ffffff", ink: "#1b1f27", hollow: "#ffffff", line: "var(--border)", line2: "var(--border-2)", gMinor: "#dde2eb", gMajor: "#b9c2d0" };

  // tepi VISUAL glyph dari snapshot STABIL (bukan d yang berubah saat commit spasi) →
  // bar tetap di posisi yang diatur, tak revert/lompat.
  const xMinV = bbox0.current.xMin;
  const xMaxV = bbox0.current.xMax;
  // glyph DIAM; bar kiri = origin (xMinV − lsb), bar kanan = advance (xMaxV + rsb)
  const leftBarX = xMinV - lsb;
  const rightBarX = xMaxV + rsb;
  // framing: cakup origin, advance, dan extent NYATA glyph (beberapa glyph menjorok keluar advance)
  const xs = contours.flat().map((p) => p.x);
  const gxMin = xs.length ? Math.min(...xs) : 0;
  const gxMax = xs.length ? Math.max(...xs) : d.advance;
  const pad = Math.round(d.upm * 0.18);
  const vx = Math.min(0, gxMin) - pad;
  const vw = Math.max(d.advance, gxMax) - vx + pad;
  // Frame vertikal TETAP supaya menggeser garis metrik hanya menggerakkan garis itu.
  const frameTop = d.upm * 1.0;
  const frameBottom = -d.upm * 0.3;
  const vh = frameTop - frameBottom;
  const flip = `matrix(1 0 0 -1 0 ${frameTop})`;
  frameRef.current = { vx, vw, vh }; // utk listener wheel (zoom/pan)
  // viewBox TERLIHAT = jendela dari frame (aspek = elemen). SVG ukuran tetap → raster konstan.
  const elemAspect = elem.w / elem.h;
  const fitW = Math.max(vw, vh * elemAspect);
  const vbW = fitW / view.zoom;
  const vbH = vbW / elemAspect;
  const vbX = (vx + view.fx * vw) - vbW / 2;
  const vbY = (view.fy * vh) - vbH / 2;
  const upp = () => vbW / (svgRef.current?.getBoundingClientRect().width || elem.w);
  // ukuran ikon node/handle PROPORSIONAL zoom (dibagi zoom → konstan di layar)
  const nodeR = (vw * 0.0132) / zoom;
  const handleR = nodeR * 0.82;
  const hitR = nodeR * 2.1; // area klik transparan (lebih besar dari ikon) → gampang diklik
  const nodeStroke = (vw * 0.0016) / zoom;
  const handleStroke = (vw * 0.0012) / zoom;
  // advance live = lebar glyph + lsb + rsb (ikut perubahan LSB & RSB sebelum commit; konsisten dgn strip & bar)
  const curAdvance = (bbox0.current.xMax - bbox0.current.xMin) + lsb + rsb;
  // rentang garis metrik = area glyph (origin..advance) + overhang kecil
  const over = vw * 0.025;
  const lineX1 = leftBarX - over;
  const lineX2 = rightBarX + over;
  // snapping: bulatkan ke kelipatan snapStep (em) bila aktif, jika tidak → integer
  const snap1 = (v: number) => { const s = snapOn && snapStep > 0 ? snapStep : 1; return Math.round(v / s) * s; };
  // snap node/handle: alignment ke X/Y node-handle lain + garis metrik (prioritas), grid fallback.
  // exclude (ci,pi) yang sedang diseret; metrik hanya utk Y. Mengembalikan posisi + koord garis-bantu (gx/gy null bila tak align).
  function snapNode(rawX: number, rawY: number, exclCi: number, exclPi: Set<number>) {
    let x = rawX, y = rawY, gx: number | null = null, gy: number | null = null;
    if (snapNodes) {
      const thr = 6 * upp(); // 6px layar → unit font
      let bestX = thr, bestY = thr;
      for (let ci = 0; ci < contoursRef.current.length; ci++) {
        const c = contoursRef.current[ci];
        for (let pi = 0; pi < c.length; pi++) {
          if (ci === exclCi && exclPi.has(pi)) continue; // jangan snap ke diri/handle sendiri
          const p = c[pi];
          const dxv = Math.abs(p.x - rawX); if (dxv < bestX) { bestX = dxv; gx = p.x; }
          const dyv = Math.abs(p.y - rawY); if (dyv < bestY) { bestY = dyv; gy = p.y; }
        }
      }
      if (d) for (const my of [0, d.xHeight, d.capHeight, d.ascender, d.descender]) {
        const dyv = Math.abs(my - rawY); if (dyv < bestY) { bestY = dyv; gy = my; }
      }
      if (gx != null) x = gx;
      if (gy != null) y = gy;
    }
    if (snapOn && snapStep > 0) { // grid pada sumbu yang TIDAK ter-align
      if (gx == null) x = Math.round(x / snapStep) * snapStep;
      if (gy == null) y = Math.round(y / snapStep) * snapStep;
    }
    return { x: Math.round(x), y: Math.round(y), gx, gy };
  }

  // ---- spacing commit ----
  async function commitSpace(nl: number, nr: number) {
    return serial(async () => {
      const res = await api.setSpacing(name!, { lsb: nl, rsb: nr });
      setLsb(res.lsb); setRsb(res.rsb);
      setD((p) => (p ? { ...p, lsb: res.lsb, rsb: res.rsb, advance: res.advance } : p));
      // CATATAN: set_spacing MENGGESER outline (dx) + ubah advance. JANGAN sinkron cache Text sebagian
      // di sini (advance saja) lalu skip refetch — itu bikin posisi glyph di Text salah. Biarkan
      // glyphsRender refetch (selfGlyphBump TIDAK diset) → outline tergeser yang benar ikut termuat.
      onChanged({ name: name!, unicode: d!.unicode, char: d!.char, advance: res.advance,
        lsb: res.lsb, rsb: res.rsb, contours: d!.contours, category: d!.category, empty: false });
      pushHist({ contours: contoursRef.current, lsb: res.lsb, rsb: res.rsb, ascender: d!.ascender, descender: d!.descender, capHeight: d!.capHeight, xHeight: d!.xHeight });
    });
  }
  // ---- outline commit ----
  async function commitOutline(next: ContourPoint[][]) {
    // OPTIMISTIC: tampilkan kontur baru SEKARANG (di luar antrean serial) → hapus/geser langsung terlihat,
    // dan JANGAN pernah menimpanya dengan respons async (yg bisa telat & lebih tua) → tak ada "lompat balik".
    if (!drag.current) { setContours(next); contoursRef.current = next; }
    return serial(async () => {
      const res = await api.setOutline(name!, next);
      bbox0.current = { xMin: res.lsb, xMax: res.advance - res.rsb }; // outline berubah → tepi visual baru
      // Hanya sinkron METRIK dari respons; kontur tetap milik client (yg dikirim).
      setD((p) => (p ? { ...p, outline: next, advance: res.advance, lsb: res.lsb, rsb: res.rsb, contours: res.contours, unicode: res.unicode, char: res.char, category: res.category, empty: false } : res));
      setLsb(res.lsb); setRsb(res.rsb);
      onChanged({ name: name!, unicode: res.unicode, char: res.char, advance: res.advance,
        lsb: res.lsb, rsb: res.rsb, contours: res.contours, category: res.category, empty: false });
      pushHist({ contours: next, lsb: res.lsb, rsb: res.rsb, ascender: res.ascender, descender: res.descender, capHeight: res.capHeight, xHeight: res.xHeight });
      syncCacheOutline(name!, next, res.advance); // real-time: mode Text ikut segar
    });
  }
  // ---- metrik vertikal (font-wide) ----
  async function commitMetric(key: "ascender" | "descender" | "capHeight" | "xHeight", v: number) {
    return serial(async () => {
      const res = await api.setMetrics({ [key]: v } as any);
      setD((p) => (p ? { ...p, ...res } : p));
      pushHist({ contours: contoursRef.current, lsb, rsb, ascender: res.ascender, descender: res.descender, capHeight: res.capHeight, xHeight: res.xHeight });
      // metrik vertikal font-wide → bump editV + jadwalkan recompile (grid/PreviewBar/preview webfont ikut)
      if (d) onChanged({ name: name!, unicode: d.unicode, char: d.char, advance: d.advance, lsb, rsb, contours: d.contours, category: d.category, empty: false });
    }).catch(() => { // backend menolak (metrik tak valid) → pulihkan garis ke nilai tersimpan
      api.glyph(name!).then((g) => setD((p) => (p ? { ...p, ascender: g.ascender, descender: g.descender, capHeight: g.capHeight, xHeight: g.xHeight } : p))).catch(() => {});
    });
  }
  // ---- edit advance langsung: atur RSB agar advance = glyphWidth + lsb + rsb ----
  function commitAdvance(v: number) {
    const gw = bbox0.current.xMax - bbox0.current.xMin; // lebar visual glyph (stabil)
    commitSpace(lsb, Math.round(v - gw - lsb));
  }
  // ---- geser baseline = geser glyph vertikal (dy em) ----
  function shiftGlyphY(dy: number) {
    if (!dy) return;
    commitOutline(contours.map((c) => c.map((p) => ({ ...p, y: Math.round(p.y + dy) }))));
  }

  // ---- undo / redo (REAL-TIME: UI diperbarui serentak, backend menyusul di latar) ----
  // Terapkan snapshot ke UI SEKARANG tanpa menunggu backend → undo/redo terasa instan.
  function applySnapUI(s: Snap) {
    let mn = Infinity, mx = -Infinity; // tepi visual dari geometri kontur (utk posisi bar & advance)
    for (const c of s.contours) for (const p of c) { if (p.x < mn) mn = p.x; if (p.x > mx) mx = p.x; }
    const bb = isFinite(mn) ? { xMin: mn, xMax: mx } : { xMin: 0, xMax: 0 };
    bbox0.current = bb;
    const adv = Math.round((bb.xMax - bb.xMin) + s.lsb + s.rsb); // = xMax + rsb (konvensi UFO, xMin=lsb)
    setContours(s.contours); contoursRef.current = s.contours;
    setLsb(s.lsb); setRsb(s.rsb);
    setComps(s.components ?? []); compsRef.current = s.components ?? [];
    syncCacheOutline(name!, s.contours, adv); // undo/redo → mode Text ikut segar (real-time)
    setD((p) => (p ? { ...p, outline: s.contours, lsb: s.lsb, rsb: s.rsb, advance: adv, contours: s.contours.length,
      ascender: s.ascender, descender: s.descender, capHeight: s.capHeight, xHeight: s.xHeight } : p));
    onChanged({ name: name!, unicode: d!.unicode, char: d!.char, advance: adv, lsb: s.lsb, rsb: s.rsb, contours: s.contours.length, category: d!.category, empty: false });
  }
  // Persist snapshot ke backend di LATAR (serial). Coalesce saat beruntun (hanya generasi terakhir yg ditulis)
  // + diff terhadap state backend terakhir → hanya bagian yg BERUBAH yang di-recompile (mis. metrik dilewati).
  function schedulePersist(s: Snap) {
    const gen = ++persistGen.current;
    const forName = name!; // kunci glyph SAAT dijadwalkan → job menulis ke glyph yg benar meski user ganti glyph
    serial(async () => {
      // Coalesce HANYA untuk glyph yg masih aktif (disusul undo/redo lebih baru → lewati). Bila glyph sudah
      // berpindah, tetap tulis (kesempatan terakhir menyimpan state glyph lama) & jangan sentuh acuan diff glyph baru.
      const sameGlyph = forName === name;
      if (sameGlyph && gen !== persistGen.current) return;
      applying.current = true;
      let wrote = false;
      try {
        const prev = sameGlyph ? lastPersisted.current : null; // beda glyph → tak ada acuan diff → tulis penuh
        const jc = (cs: ContourPoint[][]) => JSON.stringify(cs);
        const jcomp = (cs: GlyphComponent[]) => JSON.stringify(cs.map((c) => ({ base: c.base, transform: c.transform })));
        const cChanged = !prev || jc(prev.contours) !== jc(s.contours);
        if (cChanged) { await api.setOutline(forName, s.contours); wrote = true; }
        // WAJIB setSpacing juga saat kontur berubah: setOutline mempertahankan width lama → lsb/rsb turunan bisa
        // meleset (mis. lompatan coalesce ke snapshot ber-xMax beda tapi rsb kebetulan sama). setSpacing memaku ulang.
        if (cChanged || !prev || prev.lsb !== s.lsb || prev.rsb !== s.rsb) { await api.setSpacing(forName, { lsb: s.lsb, rsb: s.rsb }); wrote = true; }
        if (!prev || prev.ascender !== s.ascender || prev.descender !== s.descender || prev.capHeight !== s.capHeight || prev.xHeight !== s.xHeight)
          { await api.setMetrics({ ascender: s.ascender, descender: s.descender, capHeight: s.capHeight, xHeight: s.xHeight }); wrote = true; }
        if (!prev || jcomp(prev.components ?? []) !== jcomp(s.components ?? []))
          { await api.setComponents(forName, (s.components ?? []).map((c) => ({ base: c.base, transform: c.transform }))); wrote = true; }
        if (sameGlyph) lastPersisted.current = s; // acuan diff hanya berlaku utk glyph aktif
      } finally { applying.current = false; }
      // Backend kini SINKRON dgn snapshot → muat ulang webfont sekali lagi supaya thumbnail grid/preview ikut
      // bentuk hasil undo/redo. (applySnapUI tadi memicu bumpFont saat backend MASIH basi = preview lama.)
      if (wrote && d) {
        let mn = Infinity, mx = -Infinity;
        for (const c of s.contours) for (const p of c) { if (p.x < mn) mn = p.x; if (p.x > mx) mx = p.x; }
        const bb = isFinite(mn) ? { xMin: mn, xMax: mx } : { xMin: 0, xMax: 0 };
        const adv = Math.round((bb.xMax - bb.xMin) + s.lsb + s.rsb);
        onChanged({ name: forName, unicode: d.unicode, char: d.char, advance: adv, lsb: s.lsb, rsb: s.rsb, contours: s.contours.length, category: d.category, empty: false });
      }
    });
  }
  function undo() { if (hi.current <= 0) return; hi.current--; updFlags(); const s = hist.current[hi.current]; applySnapUI(s); schedulePersist(s); }
  function redo() { if (hi.current >= hist.current.length - 1) return; hi.current++; updFlags(); const s = hist.current[hi.current]; applySnapUI(s); schedulePersist(s); }

  // ---- drag ----
  function startBar(side: "l" | "r", e: React.PointerEvent) {
    e.stopPropagation(); (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = { kind: "bar", side, cx: e.clientX, lsb, rsb };
  }
  function startNode(ci: number, pi: number, e: React.PointerEvent) {
    e.stopPropagation(); (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setASel(null); setCSel(null); // berinteraksi dgn node → lepas seleksi anchor/komponen
    const key = keyOf(ci, pi);
    if (e.shiftKey) { // Shift-klik = toggle keanggotaan seleksi, tanpa drag
      setSel((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
      drag.current = null; return;
    }
    const c = contours[ci]; const p = c[pi];
    // node on-curve yang sudah bagian dari multi-seleksi → GROUP MOVE (geser semua terpilih bareng)
    if (p.type !== "offcurve" && selRef.current.has(key) && selRef.current.size > 1) {
      const moveSet = expandSel(contours, selRef.current);
      drag.current = { kind: "nodeGroup", cx: e.clientX, cy: e.clientY, moveSet,
        orig: contours.map((cc) => cc.map((pp) => ({ ...pp }))), moved: false };
      return;
    }
    setSel(new Set([key])); // selain itu → pilih hanya node ini
    const base: any = { kind: "node", ci, pi, cx: e.clientX, cy: e.clientY, ox: p.x, oy: p.y };
    if (p.type === "offcurve") {
      // handle: temukan anchor (on-curve tetangga) + handle lawan (utk node halus)
      const n = c.length, prev = (pi - 1 + n) % n, next = (pi + 1) % n;
      let anchorIdx = -1, oppIdx = -1;
      if (c[prev].type !== "offcurve") { anchorIdx = prev; oppIdx = (anchorIdx - 1 + n) % n; }
      else if (c[next].type !== "offcurve") { anchorIdx = next; oppIdx = (anchorIdx + 1) % n; }
      const anchor = anchorIdx >= 0 ? c[anchorIdx] : null;
      const tied = !!anchor?.smooth && oppIdx >= 0 && c[oppIdx]?.type === "offcurve";
      const ax = anchor?.x ?? 0, ay = anchor?.y ?? 0;
      drag.current = { ...base, isOff: true, hasAnchor: anchorIdx >= 0, ax, ay,
        tied, oppIdx: tied ? oppIdx : -1, oppDist: tied ? Math.hypot(c[oppIdx].x - ax, c[oppIdx].y - ay) : 0 };
    } else {
      // node on-curve: bawa handle yang menempel saat digeser
      const n = c.length, prev = (pi - 1 + n) % n, next = (pi + 1) % n;
      const handles: any[] = [];
      if (c[prev].type === "offcurve") handles.push({ hi: prev, hx: c[prev].x, hy: c[prev].y });
      if (c[next].type === "offcurve") handles.push({ hi: next, hx: c[next].x, hy: c[next].y });
      drag.current = { ...base, isOff: false, handles };
    }
  }
  // ---- anchors ----
  async function commitAnchors(next: Anchor[]) {
    if (!name) return;
    setAnchors(next);
    await serial(async () => {
      const res = await api.setAnchors(name, next);
      setAnchors(res.anchors ?? []); // sinkron dengan UFO (mis. pembulatan)
    });
  }
  function deleteAnchor(i: number) {
    const next = anchorsRef.current.filter((_, idx) => idx !== i);
    setASel(null); commitAnchors(next);
  }
  function renameAnchor(i: number, nm: string) {
    commitAnchors(anchorsRef.current.map((a, idx) => (idx === i ? { ...a, name: nm } : a)));
  }
  function startAnchor(i: number, e: React.PointerEvent) {
    e.stopPropagation(); (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setASel(i); setSel(new Set()); setCSel(null); // pilih anchor → lepas node/komponen
    const a = anchorsRef.current[i];
    drag.current = { kind: "anchor", i, cx: e.clientX, cy: e.clientY, ox: a.x, oy: a.y, moved: false };
  }

  // ---- components (referensi glyph lain) ----
  async function commitComps(next: GlyphComponent[]) {
    if (!name) return;
    setComps(next); compsRef.current = next;
    await serial(async () => {
      const res = await api.setComponents(name, next.map((c) => ({ base: c.base, transform: c.transform })));
      setComps(res.components ?? []); compsRef.current = res.components ?? [];
      { // real-time: komponen baru ikut ke cache mode Text
        const prev = glyphCache.current[name];
        if (prev) {
          glyphCache.current[name] = { ...prev, advance: res.advance,
            components: (res.components ?? []).map((c) => ({ base: c.base, transform: c.transform })) };
          selfGlyphBump.current = true;
        }
      }
      // JANGAN setContours(res.outline): set_components mengembalikan kontur BASIS apa adanya (operasi komponen
      // tak mengubah kontur) → client tetap otoritas kontur. Respons basi bisa menimpa editan node yg lebih baru
      // (mis. geser komponen lalu cepat tambah node) → node hilang. Cukup sinkron metrik/preview via setD.
      setD(res);
      onChanged({ name: name!, unicode: res.unicode, char: res.char, advance: res.advance,
        lsb: res.lsb, rsb: res.rsb, contours: res.contours, category: res.category, empty: res.empty });
      // catat ke riwayat → gerak/transform komponen bisa di-undo
      pushHist({ contours: res.outline, lsb: res.lsb, rsb: res.rsb, ascender: res.ascender, descender: res.descender, capHeight: res.capHeight, xHeight: res.xHeight, components: res.components ?? [] });
    });
  }
  function addComponent(base: string) {
    base = base.trim(); if (!base) return;
    if (!glyphNames.includes(base)) return; // hanya glyph yang ada
    const next = [...compsRef.current, { base, transform: [1, 0, 0, 1, 0, 0], basePath: "" }];
    setCSel(next.length - 1); setSel(new Set()); setASel(null); setAddComp("");
    commitComps(next); // backend mengisi basePath
  }
  function deleteComp(i: number) { const next = compsRef.current.filter((_, idx) => idx !== i); setCSel(null); commitComps(next); }
  function startComponent(i: number, e: React.PointerEvent) {
    e.stopPropagation(); (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setCSel(i); setSel(new Set()); setASel(null);
    const t = compsRef.current[i].transform;
    drag.current = { kind: "component", i, cx: e.clientX, cy: e.clientY, odx: t[4], ody: t[5], moved: false };
  }

  // ---- ELEMENT mode: kontur "c{i}" / komponen "m{i}" sbg unit utuh ----
  function splitSel(set: Set<string>) {
    const cset = new Set<number>(), mset = new Set<number>();
    for (const k of set) (k[0] === "c" ? cset : mset).add(+k.slice(1));
    return { cset, mset };
  }
  function expandGroups(set: Set<string>): Set<string> {
    const out = new Set(set);
    for (const k of set) { const g = eGroupsRef.current.find((gr) => gr.includes(k)); if (g) g.forEach((x) => out.add(x)); }
    return out;
  }
  function elemBBox(key: string) {
    if (key[0] === "c") { const c = contours[+key.slice(1)]; if (!c?.length) return null;
      const xs = c.map((p) => p.x), ys = c.map((p) => p.y);
      return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }; }
    const cm = comps[+key.slice(1)]; return cm ? compBBox(cm) : null;
  }
  function combinedBBox(keys: Iterable<string>) {
    let b: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
    for (const k of keys) { const e = elemBBox(k); if (!e) continue;
      b = b ? { minX: Math.min(b.minX, e.minX), minY: Math.min(b.minY, e.minY), maxX: Math.max(b.maxX, e.maxX), maxY: Math.max(b.maxY, e.maxY) } : e; }
    return b;
  }
  // commit elemen: hanya panggil endpoint yg perlu (kontur dan/atau komponen)
  async function commitElements(nc: ContourPoint[][], nm: GlyphComponent[], didC: boolean, didM: boolean) {
    if (didC) await commitOutline(nc);
    if (didM) await commitComps(nm);
  }
  function startElement(key: string, e: React.PointerEvent) {
    e.stopPropagation(); (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setSel(new Set()); setASel(null); setCSel(null);
    if (e.shiftKey) { // Shift-klik = toggle keanggotaan (+ grup-nya), TANPA memulai drag
      const next = new Set(eSelRef.current);
      const members = eGroupsRef.current.find((gr) => gr.includes(key)) ?? [key];
      const has = members.every((m) => next.has(m));
      members.forEach((m) => (has ? next.delete(m) : next.add(m)));
      setESel(next); eSelRef.current = next; drag.current = null; return;
    }
    const next = eSelRef.current.has(key) ? new Set(eSelRef.current) : expandGroups(new Set([key]));
    setESel(next); eSelRef.current = next;
    const { cset, mset } = splitSel(next);
    drag.current = { kind: "elemMove", cx: e.clientX, cy: e.clientY, cset, mset,
      snapC: contours.map((c) => c.map((p) => ({ ...p }))), snapM: comps.map((c) => ({ ...c })), moved: false };
  }
  function deleteElements() {
    if (!eSel.size) return;
    const { cset, mset } = splitSel(eSel);
    const nc = contours.filter((_, ci) => !cset.has(ci));
    const nm = comps.filter((_, i) => !mset.has(i));
    setESel(new Set()); setEGroups([]); // struktur berubah → reset grup
    commitElements(nc, nm, cset.size > 0, mset.size > 0);
  }
  function duplicateElements() {
    if (!eSel.size) return;
    const { cset, mset } = splitSel(eSel);
    const off = Math.round((d?.upm ?? 1000) * 0.05);
    const dupC = [...cset].sort((a, b) => a - b).map((ci) => contours[ci].map((p) => ({ ...p, x: p.x + off, y: p.y - off })));
    const dupM = [...mset].sort((a, b) => a - b).map((i) => ({ ...comps[i], transform: [comps[i].transform[0], comps[i].transform[1], comps[i].transform[2], comps[i].transform[3], comps[i].transform[4] + off, comps[i].transform[5] - off] }));
    const nc = [...contours, ...dupC], nm = [...comps, ...dupM];
    const newSel = new Set<string>([...dupC.map((_, k) => `c${contours.length + k}`), ...dupM.map((_, k) => `m${comps.length + k}`)]);
    setEGroups([]); setESel(newSel);
    commitElements(nc, nm, dupC.length > 0, dupM.length > 0);
  }
  function groupSel() {
    if (eSel.size < 2) return;
    const overlap = eGroups.filter((g) => g.some((k) => eSel.has(k))).flat();
    const merged = Array.from(new Set([...eSel, ...overlap]));
    setEGroups([...eGroups.filter((g) => !g.some((k) => eSel.has(k))), merged]);
    setESel(new Set(merged));
  }
  function ungroupSel() { if (eSel.size) setEGroups(eGroups.filter((g) => !g.some((k) => eSel.has(k)))); }
  function elemTransform(M: Aff) {
    if (!eSel.size) return;
    const { cset, mset } = splitSel(eSel);
    const nc = cset.size ? contours.map((c, ci) => (cset.has(ci) ? c.map((p) => { const [x, y] = aApply(M, p.x, p.y); return { ...p, x: Math.round(x), y: Math.round(y) }; }) : c)) : contours;
    const nm = mset.size ? comps.map((cm, i) => (mset.has(i) ? { ...cm, transform: roundAff(aCompose(M, cm.transform as Aff)) } : cm)) : comps;
    if (cset.size) setContours(nc);
    if (mset.size) { setComps(nm); compsRef.current = nm; } // sync → snapshot history konsisten
    commitElements(nc, nm, cset.size > 0, mset.size > 0);
  }
  function elemFlip(axis: "h" | "v") { const b = combinedBBox(eSel); if (!b) return; const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2; elemTransform(axis === "h" ? aFlipH(cx) : aFlipV(cy)); }
  function elemRotate(deg: number) { const b = combinedBBox(eSel); if (!b) return; elemTransform(aRot(deg, (b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2)); }
  function elemScale(pct: number) { const b = combinedBBox(eSel); if (!b || pct <= 0) return; elemTransform(aScale(pct / 100, (b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2)); }
  function nudgeElements(dx: number, dy: number) { elemTransform(aMove(dx, dy)); }
  function startGuide(key: string, e: React.PointerEvent) {
    e.stopPropagation(); (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = { kind: "guide", key, cy: e.clientY, start: (d as any)[key] };
  }
  function startBase(e: React.PointerEvent) {
    e.stopPropagation(); (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = { kind: "base", cy: e.clientY, orig: contours.map((c) => c.map((p) => ({ ...p }))) };
  }
  function onMove(e: React.PointerEvent) {
    const g = drag.current; if (!g) return;
    const k = upp();
    if (g.kind === "bar") {
      const dx = (e.clientX - g.cx) * k;
      // glyph diam: bar kiri = origin (geser kanan → LSB turun); bar kanan = advance (geser kanan → RSB naik)
      if (g.side === "l") { g.nl = snap1(g.lsb - dx); setLsb(g.nl); }
      else { g.nr = snap1(g.rsb + dx); setRsb(g.nr); }
    } else if (g.kind === "node") {
      g.moved = true;
      let dx = (e.clientX - g.cx) * k, dy = -(e.clientY - g.cy) * k;
      if (g.isOff) {
        let nx = g.ox + dx, ny = g.oy + dy;
        if (e.shiftKey && g.hasAnchor) { // Shift = snap sudut 45° (diprioritaskan, abaikan snap lain)
          const [vx2, vy2] = snap45(nx - g.ax, ny - g.ay); nx = Math.round(g.ax + vx2); ny = Math.round(g.ay + vy2);
          setSnapG(null);
        } else { const s = snapNode(nx, ny, g.ci, new Set([g.pi, g.oppIdx].filter((i) => i >= 0))); nx = s.x; ny = s.y; setSnapG(s.gx != null || s.gy != null ? { x: s.gx, y: s.gy } : null); }
        applyContours(contoursRef.current.map((c, ci) => ci !== g.ci ? c : c.map((p, pi) => {
          if (pi === g.pi) return { ...p, x: nx, y: ny };
          if (g.tied && pi === g.oppIdx) { // node halus: handle lawan tetap collinear (panjangnya dipertahankan)
            const len = Math.hypot(nx - g.ax, ny - g.ay) || 1;
            return { ...p, x: Math.round(g.ax - g.oppDist * (nx - g.ax) / len), y: Math.round(g.ay - g.oppDist * (ny - g.ay) / len) };
          }
          return p;
        })));
      } else {
        if (e.shiftKey) { const [sx, sy] = snap45(dx, dy); dx = sx; dy = sy; }
        // snap POSISI node (alignment node/handle/metrik + grid) → node mendarat tepat, handle ikut delta sama
        let nxp: number, nyp: number;
        if (e.shiftKey) { nxp = Math.round(g.ox + dx); nyp = Math.round(g.oy + dy); setSnapG(null); }
        else { const s = snapNode(g.ox + dx, g.oy + dy, g.ci, new Set([g.pi, ...g.handles.map((h: any) => h.hi)])); nxp = s.x; nyp = s.y; setSnapG(s.gx != null || s.gy != null ? { x: s.gx, y: s.gy } : null); }
        const ndx = nxp - g.ox, ndy = nyp - g.oy;
        applyContours(contoursRef.current.map((c, ci) => ci !== g.ci ? c : c.map((p, pi) => {
          if (pi === g.pi) return { ...p, x: g.ox + ndx, y: g.oy + ndy };
          const h = g.handles.find((x: any) => x.hi === pi); // node membawa handle-nya
          if (h) return { ...p, x: h.hx + ndx, y: h.hy + ndy };
          return p;
        })));
      }
    } else if (g.kind === "nodeGroup") {
      g.moved = true;
      let dx = (e.clientX - g.cx) * k, dy = -(e.clientY - g.cy) * k;
      if (e.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; } // kunci sumbu H/V
      const s = snapOn && snapStep > 0 ? snapStep : 1;
      dx = Math.round(dx / s) * s; dy = Math.round(dy / s) * s; // snap delta ke grid
      applyContours(g.orig.map((c: ContourPoint[], ci: number) => {
        const set = g.moveSet.get(ci); if (!set) return c;
        return c.map((p, pi) => set.has(pi) ? { ...p, x: Math.round(p.x + dx), y: Math.round(p.y + dy) } : p);
      }));
    } else if (g.kind === "anchor") {
      g.moved = true;
      let dx = (e.clientX - g.cx) * k, dy = -(e.clientY - g.cy) * k;
      if (e.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; } // kunci sumbu
      const s = snapNode(g.ox + dx, g.oy + dy, -1, new Set()); // anchor snap ke semua node/metrik
      setSnapG(s.gx != null || s.gy != null ? { x: s.gx, y: s.gy } : null);
      setAnchors(anchorsRef.current.map((a, i) => (i === g.i ? { ...a, x: s.x, y: s.y } : a)));
    } else if (g.kind === "component") {
      g.moved = true;
      let dx = (e.clientX - g.cx) * k, dy = -(e.clientY - g.cy) * k;
      if (e.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
      const ndx = snap1(g.odx + dx), ndy = snap1(g.ody + dy);
      const nm = compsRef.current.map((c, i) => (i === g.i ? { ...c, transform: [c.transform[0], c.transform[1], c.transform[2], c.transform[3], ndx, ndy] } : c));
      compsRef.current = nm; setComps(nm); // sinkron → onUp baca nilai terbaru
    } else if (g.kind === "elemMove") {
      g.moved = true;
      let dx = (e.clientX - g.cx) * k, dy = -(e.clientY - g.cy) * k;
      if (e.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
      const sg = snapOn && snapStep > 0 ? snapStep : 1;
      dx = Math.round(dx / sg) * sg; dy = Math.round(dy / sg) * sg;
      if (g.cset.size) applyContours(g.snapC.map((c: ContourPoint[], ci: number) => (g.cset.has(ci) ? c.map((p) => ({ ...p, x: Math.round(p.x + dx), y: Math.round(p.y + dy) })) : c)));
      if (g.mset.size) { const nm = g.snapM.map((cm: GlyphComponent, i: number) => (g.mset.has(i) ? { ...cm, transform: [cm.transform[0], cm.transform[1], cm.transform[2], cm.transform[3], Math.round(cm.transform[4] + dx), Math.round(cm.transform[5] + dy)] } : cm)); compsRef.current = nm; setComps(nm); }
    } else if (g.kind === "elemMarquee") {
      g.moved = true; const s = clientToFont(e); setEMarq({ x0: g.x0, y0: g.y0, x1: s.x, y1: s.y });
      const x0 = Math.min(g.x0, s.x), x1 = Math.max(g.x0, s.x), y0 = Math.min(g.y0, s.y), y1 = Math.max(g.y0, s.y);
      const hit = new Set<string>(g.add ? g.base : []);
      contoursRef.current.forEach((c, ci) => { if (!c.length) return; const xs = c.map((p) => p.x), ys = c.map((p) => p.y);
        if (!(Math.max(...xs) < x0 || Math.min(...xs) > x1 || Math.max(...ys) < y0 || Math.min(...ys) > y1)) hit.add(`c${ci}`); });
      compsRef.current.forEach((cm, i) => { const b = compBBox(cm); if (!(b.maxX < x0 || b.minX > x1 || b.maxY < y0 || b.minY > y1)) hit.add(`m${i}`); });
      setESel(expandGroups(hit));
    } else if (g.kind === "marquee") {
      g.moved = true; const s = clientToFont(e); g.x1 = s.x; g.y1 = s.y;
      setMarq({ x0: g.x0, y0: g.y0, x1: s.x, y1: s.y });
      const x0 = Math.min(g.x0, s.x), x1 = Math.max(g.x0, s.x), y0 = Math.min(g.y0, s.y), y1 = Math.max(g.y0, s.y);
      const next = new Set<string>(g.add ? g.base : []);
      contoursRef.current.forEach((c, ci) => c.forEach((p, pi) => {
        if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) next.add(keyOf(ci, pi));
      }));
      setSel(next);
    } else if (g.kind === "guide") {
      const dy = -(e.clientY - g.cy) * k;
      g.val = snap1(g.start + dy);
      setD((p) => (p ? { ...p, [g.key]: g.val } as GlyphDetail : p));
    } else if (g.kind === "base") {
      const dy = -(e.clientY - g.cy) * k; // tarik ke atas → garis naik
      g.dy = snap1(dy);
      setBaseLineY(g.dy); // HANYA garis yang bergerak saat diseret — karakter diam (komitmen di onUp)
    } else if (g.kind === "draw") {
      const s = clientToFont(e);
      let x1 = s.x, y1 = s.y;
      if (e.shiftKey) { // Shift = kotak/lingkaran sempurna (sisi sama)
        const dx = x1 - g.x0, dy = y1 - g.y0, m = Math.max(Math.abs(dx), Math.abs(dy));
        x1 = g.x0 + (dx < 0 ? -m : m); y1 = g.y0 + (dy < 0 ? -m : m);
      }
      g.x1 = x1; g.y1 = y1;
      setDraft({ x0: g.x0, y0: g.y0, x1, y1 });
    }
  }
  async function onUp() {
    const g = drag.current; drag.current = null;
    if (rafId.current) { cancelAnimationFrame(rafId.current); rafId.current = null; pendingC.current = null; }
    if (snapG) setSnapG(null); // bersihkan garis bantu snap
    if (!g) return;
    if (g.kind === "bar") { if (g.nl != null || g.nr != null) commitSpace(g.nl ?? lsb, g.nr ?? rsb); } // klik tanpa geser → jangan tulis/pushHist
    else if (g.kind === "node" || g.kind === "nodeGroup") { if (g.moved) { setContours(contoursRef.current); commitOutline(contoursRef.current); } }
    else if (g.kind === "marquee") { setMarq(null); if (!g.moved && !g.add) setSel(new Set()); } // klik kosong = batal pilih
    else if (g.kind === "anchor") { if (g.moved) commitAnchors(anchorsRef.current); }
    else if (g.kind === "component") { if (g.moved) commitComps(compsRef.current); }
    else if (g.kind === "elemMove") { if (g.moved) commitElements(contoursRef.current, compsRef.current, g.cset.size > 0, g.mset.size > 0); }
    else if (g.kind === "elemMarquee") { setEMarq(null); if (!g.moved && !g.add) setESel(new Set()); }
    else if (g.kind === "base") {
      setBaseLineY(0);
      if (g.dy) {
        // Baseline dipindah +dy → dalam koordinat font, karakter bergeser −dy (baseline definisi y=0).
        // Supaya karakter DIAM secara visual, view di-pan +dy — yang tampak pindah hanya garisnya.
        const next = contours.map((c) => c.map((p) => ({ ...p, y: Math.round(p.y - g.dy) })));
        setContours(next); contoursRef.current = next;
        commitOutline(next);
        const { vh } = frameRef.current; const v = viewRef.current;
        setView2({ ...v, fy: v.fy + g.dy / vh });
      }
    }
    else if (g.kind === "guide" && g.val != null) {
      commitMetric(g.key as "ascender" | "descender" | "capHeight" | "xHeight", g.val);
    } else if (g.kind === "draw") {
      setDraft(null);
      const x0 = Math.min(g.x0, g.x1), x1 = Math.max(g.x0, g.x1);
      const y0 = Math.min(g.y0, g.y1), y1 = Math.max(g.y0, g.y1);
      if (x1 - x0 < 4 || y1 - y0 < 4) return; // terlalu kecil → batal
      const c = g.shape === "ellipse" ? makeEllipse(x0, y0, x1, y1) : makeRect(x0, y0, x1, y1);
      const next = [...contoursRef.current, c];
      setContours(next); commitOutline(next);
      setTool("select"); // selesai gambar → kembali ke pilih (seperti FontLab)
    }
  }

  // titik klien → koordinat font (membatalkan flip Y)
  function clientToFont(e: { clientX: number; clientY: number }) {
    const rect = svgRef.current!.getBoundingClientRect();
    const k = upp();
    return { x: vbX + (e.clientX - rect.left) * k, y: frameTop - (vbY + (e.clientY - rect.top) * k) };
  }

  // ---- mulai gambar bentuk (kotak/elips) di area kosong saat sub-alat aktif ----
  function onCanvasDown(e: React.PointerEvent) {
    if (mode === "element") { // seret area kosong = marquee elemen; klik kosong = batal
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      const s0 = clientToFont(e);
      drag.current = { kind: "elemMarquee", x0: s0.x, y0: s0.y, base: new Set(eSelRef.current), add: e.shiftKey, moved: false };
      setEMarq({ x0: s0.x, y0: s0.y, x1: s0.x, y1: s0.y });
      return;
    }
    if (mode !== "contour") return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const s = clientToFont(e);
    if (tool === "select") { // seret di area kosong = marquee (pilih banyak node)
      setASel(null); setCSel(null);
      drag.current = { kind: "marquee", x0: s.x, y0: s.y, base: new Set(selRef.current), add: e.shiftKey, moved: false };
      setMarq({ x0: s.x, y0: s.y, x1: s.x, y1: s.y });
      return;
    }
    if (tool === "anchor") { // klik = tambah anchor baru di titik itu
      const next = [...anchorsRef.current, { name: `anchor${anchorsRef.current.length + 1}`, x: Math.round(s.x), y: Math.round(s.y) }];
      setASel(next.length - 1); setSel(new Set()); commitAnchors(next);
      return;
    }
    drag.current = { kind: "draw", shape: tool, x0: s.x, y0: s.y, x1: s.x, y1: s.y };
    setDraft({ x0: s.x, y0: s.y, x1: s.x, y1: s.y });
  }

  // ---- add node (double-click → segmen terdekat) ----
  function onDouble(e: React.MouseEvent) {
    if (mode !== "contour" || tool !== "select") return;
    const { x: fx, y: fy } = clientToFont(e);
    const u = upp();
    // (1) BATAL bila klik dekat node/handle mana pun → user sedang mengedit titik, BUKAN menambah
    const near = 11 * u;
    for (const c of contours) for (const p of c) if (Math.hypot(p.x - fx, p.y - fy) <= near) return;
    // (2) cari segmen + parameter t TERDEKAT ke titik klik → node mendarat tepat di kursor
    let best = { ci: -1, pi: -1, dist: Infinity, t: 0.5 };
    contours.forEach((c, ci) => {
      const onIdx = c.map((p, i) => (p.type !== "offcurve" ? i : -1)).filter((i) => i >= 0);
      for (let a = 0; a < onIdx.length; a++) {
        const endI = onIdx[(a + 1) % onIdx.length];
        const r = segClosest(c, endI, fx, fy); // titik terdekat pada KURVA nyata (bukan chord)
        if (r.dist < best.dist) best = { ci, pi: endI, dist: r.dist, t: r.t };
      }
    });
    if (best.ci >= 0 && best.dist <= 18 * u) { // hanya tambah bila benar-benar di dekat sebuah segmen
      const next = contours.map((c, ci) => (ci === best.ci ? addNode(c, best.pi, best.t) : c));
      setContours(next); commitOutline(next);
    }
  }
  // ---- transform seleksi (node + handle-nya) ----
  // bbox dari semua titik terpilih (yang sudah diperluas) → pusat utk flip/rotate/scale
  function selBBox() {
    const m = expandSel(contours, sel); const xs: number[] = [], ys: number[] = [];
    m.forEach((set, ci) => set.forEach((pi) => { const p = contours[ci][pi]; xs.push(p.x); ys.push(p.y); }));
    if (!xs.length) return null;
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    return { minX, maxX, minY, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }
  function transformSel(fn: (x: number, y: number) => [number, number]) {
    if (!sel.size) return;
    const m = expandSel(contours, sel);
    const next = contours.map((c, ci) => {
      const set = m.get(ci); if (!set) return c;
      return c.map((p, pi) => { if (!set.has(pi)) return p; const [nx, ny] = fn(p.x, p.y); return { ...p, x: Math.round(nx), y: Math.round(ny) }; });
    });
    setContours(next); commitOutline(next);
  }
  function nudgeSel(dx: number, dy: number) { transformSel((x, y) => [x + dx, y + dy]); }
  function flipSel(axis: "h" | "v") { const b = selBBox(); if (!b) return; transformSel((x, y) => axis === "h" ? [2 * b.cx - x, y] : [x, 2 * b.cy - y]); }
  function rotateSel(deg: number) {
    const b = selBBox(); if (!b) return; const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    transformSel((x, y) => { const dx = x - b.cx, dy = y - b.cy; return [b.cx + dx * c - dy * s, b.cy + dx * s + dy * c]; });
  }
  function scaleSel(pct: number) { const b = selBBox(); if (!b || pct <= 0) return; const f = pct / 100; transformSel((x, y) => [b.cx + (x - b.cx) * f, b.cy + (y - b.cy) * f]); }

  function doRemove() {
    if (!sel.size) return;
    const byC = new Map<number, number[]>();
    for (const k of sel) { const { ci, pi } = parseKey(k); const p = contours[ci]?.[pi]; if (p && p.type !== "offcurve") { if (!byC.has(ci)) byC.set(ci, []); byC.get(ci)!.push(pi); } }
    if (!byC.size) return;
    const next = contours
      .map((c, ci) => { const arr = byC.get(ci); if (!arr) return c; let cc = c; for (const pi of arr.sort((a, b) => b - a)) { cc = removeNode(cc, pi); if (!cc.length) break; } return cc; })
      .filter((c) => c.length); // kontur yang habis nodenya dibuang seluruhnya (glyph boleh jadi kosong)
    setSel(new Set()); setContours(next); commitOutline(next);
  }
  // ubah node on-curve antara SUDUT (kotak, handle independen) ⇄ HALUS (lingkaran, handle terikat)
  const selSmooth = !!(primary && contours[primary.ci]?.[primary.pi]?.smooth);
  const selIsOn = !!(primary && contours[primary.ci]?.[primary.pi] && contours[primary.ci][primary.pi].type !== "offcurve");
  function toggleSmooth() {
    if (!primary) return;
    const c = contours[primary.ci]; const p = c?.[primary.pi];
    if (!p || p.type === "offcurve") return;
    const ns = !p.smooth;
    const n = c.length, pIdx = primary.pi;
    const inIdx = c[(pIdx - 1 + n) % n].type === "offcurve" ? (pIdx - 1 + n) % n : -1;
    const outIdx = c[(pIdx + 1) % n].type === "offcurve" ? (pIdx + 1) % n : -1;
    let inPos = inIdx >= 0 ? { ...c[inIdx] } : null;
    let outPos = outIdx >= 0 ? { ...c[outIdx] } : null;
    if (ns && inPos && outPos) { // jadikan halus → luruskan kedua handle (collinear lewat node)
      let dx = outPos.x - inPos.x, dy = outPos.y - inPos.y; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      const dIn = Math.hypot(inPos.x - p.x, inPos.y - p.y), dOut = Math.hypot(outPos.x - p.x, outPos.y - p.y);
      inPos = { ...inPos, x: Math.round(p.x - dx * dIn), y: Math.round(p.y - dy * dIn) };
      outPos = { ...outPos, x: Math.round(p.x + dx * dOut), y: Math.round(p.y + dy * dOut) };
    }
    const next = contours.map((cc, ci) => ci !== primary.ci ? cc : cc.map((pp, pi) => {
      if (pi === pIdx) return { ...pp, smooth: ns };
      if (pi === inIdx && inPos) return inPos;
      if (pi === outIdx && outPos) return outPos;
      return pp;
    }));
    setContours(next); commitOutline(next);
  }

  // [nilai y, label, warna, key metrik | null (=baseline)] — warna dari palet kanvas (cv)
  const guides: [number, string, string, string | null][] = [
    [d.ascender, "asc", cv.line2, "ascender"],
    [d.capHeight, "cap", cv.line, "capHeight"],
    [d.xHeight, "x", cv.line, "xHeight"],
    [0, "base", "var(--accent)", null],
    [d.descender, "desc", cv.line2, "descender"],
  ];

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-4 py-2.5 border-b flex items-center gap-3" style={{ borderColor: "var(--border)" }}>
        <span className="text-base font-semibold">{d.char ?? d.name}</span>
        <span className="text-muted text-xs">{d.name}</span>
        {d.contours >= 2 && <span className="text-good text-xs">◎ counter</span>}
        <div className="ml-auto flex items-center gap-2">
          {/* snapping: snap node/handle (alignment) + snap grid + nilai grid (em) */}
          <div className="flex items-center gap-1 p-0.5 rounded-lg" style={{ background: "var(--bg-2)" }}>
            <button className="btn !p-1.5" onClick={() => setCanvasDark((s) => !s)}
              title={canvasDark ? "Kanvas GELAP — klik untuk kanvas terang" : "Kanvas terang — klik untuk kanvas gelap"}>
              {canvasDark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
            </button>
            <button className="btn !p-1.5" onClick={() => setShowGrid((s) => !s)} title={showGrid ? "Garis grid kanvas: TAMPIL (klik utk sembunyikan)" : "Garis grid kanvas: tersembunyi"}
              style={{ background: showGrid ? "var(--accent)" : "transparent", color: showGrid ? "#fff" : "var(--muted)" }}>
              <Grid3x3 className="size-3.5" />
            </button>
            <button className="btn !p-1.5" onClick={() => setSnapNodes((s) => !s)} title={snapNodes ? "Snap ke node/handle/metrik: AKTIF" : "Snap ke node/handle: nonaktif"}
              style={{ background: snapNodes ? "var(--accent)" : "transparent", color: snapNodes ? "#fff" : "var(--muted)" }}>
              <Crosshair className="size-3.5" />
            </button>
            <button className="btn !p-1.5" onClick={() => setSnapOn((s) => !s)} title={snapOn ? "Snap ke grid: AKTIF" : "Snap ke grid: nonaktif"}
              style={{ background: snapOn ? "var(--accent)" : "transparent", color: snapOn ? "#fff" : "var(--muted)" }}>
              <Magnet className="size-3.5" />
            </button>
            <input type="number" min={1} value={snapStep} title="Nilai grid snap (unit em)"
              onChange={(e) => setSnapStep(Math.max(1, Math.round(Number(e.target.value) || 1)))}
              className="field !w-12 !py-1 !px-1.5 text-xs tabular-nums" style={{ opacity: snapOn ? 1 : 0.5 }} />
          </div>
          <div className="flex gap-0.5 p-0.5 rounded-lg" style={{ background: "var(--bg-2)" }}>
            <button className="btn !p-1.5" disabled={!canUndo} onClick={undo} title="Undo (⌘Z)"><Undo2 className="size-3.5" /></button>
            <button className="btn !p-1.5" disabled={!canRedo} onClick={redo} title="Redo (⌘⇧Z)"><Redo2 className="size-3.5" /></button>
          </div>
          <span className="text-muted text-xs font-medium tabular-nums">{TOOLS.find((t) => t.id === mode)?.label}</span>
        </div>
      </div>

      {/* Kanvas Edit Glyph: terang/gelap sesuai toggle. Override --glyph → tinta kontras dgn latar.
          Hanya berlaku di dalam kanvas ini (cascade), panel & layar lain tetap tema gelap. */}
      <div className="flex-1 min-h-0 relative overflow-hidden" style={{ background: cv.bg, "--glyph": cv.ink } as React.CSSProperties}>
          {/* Panel Tools (vertikal, kiri) — pemilih 5 mode ala FontLab */}
          <div className="absolute top-3 left-3 z-10 flex flex-col gap-1 rounded-xl p-1"
            style={{ background: "var(--panel)", border: "1px solid var(--border)" }}>
            {TOOLS.map((t) => (
              <ToolBtn key={t.id} active={mode === t.id} ready={t.ready}
                onClick={() => setMode(t.id)} icon={t.icon} label={t.label} hint={t.hint} />
            ))}
            {/* sub-alat khusus mode Contour */}
            {mode === "contour" && (
              <>
                <div className="h-px mx-1 my-0.5" style={{ background: "var(--border)" }} />
                <ToolBtn active={tool === "select"} ready onClick={() => setTool("select")} icon={MousePointer2} label="Pilih" hint="Pilih & geser node (dobel-klik segmen = tambah node)" />
                <ToolBtn active={tool === "rect"} ready onClick={() => setTool("rect")} icon={Square} label="Kotak" hint="Seret untuk gambar kotak (Shift = bujur sangkar)" />
                <ToolBtn active={tool === "ellipse"} ready onClick={() => setTool("ellipse")} icon={Circle} label="Elips" hint="Seret untuk gambar elips (Shift = lingkaran)" />
                <ToolBtn active={tool === "anchor"} ready onClick={() => setTool("anchor")} icon={AnchorIcon} label="Anchor" hint="Klik untuk taruh anchor (titik attachment bernama)" />
              </>
            )}
          </div>
          {mode === "kerning" ? (
            <KerningCanvas
              left={kernSide === "left"
                ? (kernSelfName === name ? { path, comps, advance: d.advance, isCurrent: true } : (selfData ? { path: selfData.path, comps: [], advance: selfData.advance, isCurrent: false } : null))
                : (partnerData ? { path: partnerData.path, comps: [], advance: partnerData.advance, isCurrent: false } : null)}
              right={kernSide === "left"
                ? (partnerData ? { path: partnerData.path, comps: [], advance: partnerData.advance, isCurrent: false } : null)
                : (kernSelfName === name ? { path, comps, advance: d.advance, isCurrent: true } : (selfData ? { path: selfData.path, comps: [], advance: selfData.advance, isCurrent: false } : null))}
              // "Semuanya" = tracking global → berlaku ke SEMUA pasangan (letter-spacing). Preview:
              // trackVal ditambahkan seragam ke gap pasangan mana pun (jujur — semua ikut saat Terapkan).
              kern={kernVal} tracking={kernScope === "all" ? trackVal : tracking}
              editValue={kernScope === "all" ? trackVal : kernVal}
              onEdit={kernScope === "all" ? setTrackVal : setKernVal}
              onCommit={stageKern} // lepas seretan → nilai TERTAHAN (pratinjau); tulis saat "Terapkan"
              ascender={d.ascender} descender={d.descender} line={cv.line} />
          ) : mode === "text" ? (
            // proofTick (state) memicu re-render parent → TextProof baca cache terbaru
            <TextProof text={proofText} charToName={charToName} glyphs={glyphCache.current} kerns={kernCache.current}
              kernOn={proofKern} upm={d.upm} ascender={d.ascender} descender={d.descender} fontSize={proofSize} loading={proofLoading} tracking={tracking}
              onTextChange={setProofText} bg={cv.bg}
              xray={proofXray} showNodes={proofNodes} kernEdit={proofKernEdit}
              onKernLive={proofKernLive} onKernCommit={proofKernCommit}
              showGrid={showGrid} gMinor={cv.gMinor} gMajor={cv.gMajor} snapStep={snapStep}
              onOutlineLive={proofOutlineLive} onOutlineCommit={proofOutlineCommit}
              zoom={proofZoom} onZoom={(f) => setProofZoom((z) => zClamp(z * f))} interact={proofBusy} />
          ) : (
          <>
          {/* SVG ukuran TETAP (= layar); zoom/pan via viewBox → hanya area terlihat yang dirender */}
          <svg
            ref={svgCb}
            viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
            preserveAspectRatio="none"
            style={{ width: "100%", height: "100%", touchAction: "none", display: "block",
              cursor: mode === "contour" && tool !== "select" ? "crosshair" : "default" }}
            onPointerDown={onCanvasDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} onDoubleClick={onDouble}
          >
            <g transform={flip}>
              {/* GRID kanvas (toggle) — komponen memo: selama drag node view tak berubah →
                  React melewati ±ratusan <line> ini sama sekali (hot path drag tetap ringan) */}
              {showGrid && <CanvasGrid vbX={vbX} vbY={vbY} vbW={vbW} vbH={vbH} frameTop={frameTop}
                step={snapStep} pxPer={elem.w / vbW} sw={handleStroke} minor={cv.gMinor} major={cv.gMajor} />}
              {/* garis metrik horizontal — draggable di mode Metrics. BASELINE: menyeretnya mengatur
                  POSISI BASELINE TERHADAP KARAKTER — karakter diam secara visual (data digeser −dy,
                  view di-pan +dy: saling meniadakan), hanya garisnya yang pindah. */}
              {guides.map(([y, label, color, key]) => {
                const isBase = key === null;
                const dragg = mode === "metrics";
                const ly = isBase ? baseLineY : y; // garis base ikut bergerak saat diseret (nempel ke grid)
                return (
                  <g key={label} style={{ cursor: dragg ? "ns-resize" : "default" }}
                    onPointerDown={dragg ? (isBase ? startBase : (e) => startGuide(key!, e)) : undefined}>
                    <line x1={lineX1} y1={ly} x2={lineX2} y2={ly} stroke={color}
                      strokeWidth={vw * (isBase ? 0.0016 : 0.001)}
                      strokeDasharray={isBase ? undefined : `${vw * 0.012} ${vw * 0.008}`} />
                    {dragg && <rect x={lineX1} y={ly - vw * 0.012} width={lineX2 - lineX1} height={vw * 0.024} fill="transparent" />}
                  </g>
                );
              })}
              {/* komponen (referensi glyph lain) — bagian dari bentuk glyph; biru & dapat diseret di mode Contour */}
              {comps.map((c, i) => {
                const inContour = mode === "contour", inElem = mode === "element";
                const eseld = inElem && eSel.has(`m${i}`);
                // appearance: di Element mode TIDAK interaktif (hit-layer komponen di bawah yg menangani klik → z-order benar)
                return (
                  <path key={i} d={c.basePath} transform={`matrix(${c.transform.join(" ")})`} fillRule="nonzero"
                    fill={inContour ? COMP_COLOR : "var(--glyph)"} fillOpacity={inContour ? (cSel === i ? 0.55 : 0.32) : 1}
                    stroke={inContour ? COMP_COLOR : eseld ? "var(--accent)" : "none"} strokeWidth={eseld ? nodeStroke * 1.6 : nodeStroke}
                    style={{ cursor: inContour ? "move" : "default", pointerEvents: inContour ? "auto" : "none" }}
                    onPointerDown={inContour ? (e) => startComponent(i, e) : undefined} />
                );
              })}

              {/* outline — DIAM (tak digeser saat LSB/RSB diubah) */}
              <path d={path} fill="var(--glyph)" fillRule="nonzero" opacity={mode === "contour" ? 0.5 : 1} style={{ pointerEvents: "none" }} />

              {/* ELEMENT: layer pemilih per-kontur (fill transparan = bisa diklik) + bbox terpilih */}
              {mode === "element" && (
                <>
                  {contours.map((c, ci) => (
                    <path key={`e${ci}`} d={contoursToPath([c])} fill="transparent"
                      stroke={eSel.has(`c${ci}`) ? "var(--accent)" : "transparent"} strokeWidth={nodeStroke * 1.6}
                      style={{ cursor: "move" }} onPointerDown={(e) => startElement(`c${ci}`, e)} />
                  ))}
                  {/* hit-layer komponen DI ATAS kontur → komponen yg overlap tetap bisa dipilih */}
                  {comps.map((c, i) => (
                    <path key={`em${i}`} d={c.basePath} transform={`matrix(${c.transform.join(" ")})`} fill="transparent"
                      style={{ cursor: "move" }} onPointerDown={(e) => startElement(`m${i}`, e)} />
                  ))}
                  {[...eSel].map((kk) => { const b = elemBBox(kk); if (!b) return null;
                    return <rect key={`bb${kk}`} x={b.minX} y={b.minY} width={Math.max(1, b.maxX - b.minX)} height={Math.max(1, b.maxY - b.minY)}
                      fill="none" stroke="var(--accent)" strokeWidth={nodeStroke} strokeDasharray={`${nodeR * 0.7} ${nodeR * 0.7}`} opacity={0.7} style={{ pointerEvents: "none" }} />; })}
                </>
              )}

              {/* mode Rapikan: tampilkan node/handle READ-ONLY — user melihat titik mana yang hilang */}
              {mode === "cleanup" && contours.map((c, ci) => (
                <g key={`cl${ci}`} style={{ pointerEvents: "none" }}>
                  {c.map((p, pi) => {
                    if (p.type !== "offcurve") return null;
                    const n = c.length;
                    const prev = c[(pi - 1 + n) % n], next = c[(pi + 1) % n];
                    const lines = [];
                    if (prev.type !== "offcurve") lines.push([prev, p] as const);
                    if (next.type !== "offcurve") lines.push([next, p] as const);
                    return lines.map(([a, b], li) => (
                      <line key={`${pi}-${li}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--faint)" strokeWidth={handleStroke} />
                    ));
                  })}
                  {c.map((p, pi) => p.type === "offcurve"
                    ? <circle key={`o${pi}`} cx={p.x} cy={p.y} r={nodeR * 0.55} fill="var(--bg-2)" stroke="var(--accent)" strokeWidth={nodeStroke} />
                    : <rect key={`n${pi}`} x={p.x - nodeR * 0.7} y={p.y - nodeR * 0.7} width={nodeR * 1.4} height={nodeR * 1.4} fill="var(--accent)" />)}
                </g>
              ))}

              {mode === "contour" && contours.map((c, ci) => (
                <g key={ci}>
                  {c.map((p, pi) => {
                    if (p.type !== "offcurve") return null;
                    const n = c.length;
                    const prev = c[(pi - 1 + n) % n], next = c[(pi + 1) % n];
                    const lines = [];
                    if (prev.type !== "offcurve") lines.push([prev, p]);
                    if (next.type !== "offcurve") lines.push([next, p]);
                    return lines.map(([a, b], li) => (
                      <line key={`${pi}-${li}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--faint)" strokeWidth={handleStroke} />
                    ));
                  })}
                  {c.map((p, pi) => {
                    const isSel = sel.has(keyOf(ci, pi));
                    // area klik transparan (radius hitR) di belakang ikon → target lebih besar, mudah diklik
                    const hit = <circle cx={p.x} cy={p.y} r={hitR} fill="transparent"
                      style={{ cursor: "grab" }} onPointerDown={(e) => startNode(ci, pi, e)}
                      onDoubleClick={(e) => e.stopPropagation()} />; {/* dblclick di node ≠ tambah node */}
                    // handle off-curve = lingkaran KECIL (hollow)
                    if (p.type === "offcurve")
                      return <g key={pi}>{hit}<circle cx={p.x} cy={p.y} r={handleR} fill={isSel ? "var(--accent)" : cv.hollow}
                        stroke="var(--accent)" strokeWidth={handleStroke} style={{ pointerEvents: "none" }} /></g>;
                    // node on-curve: HALUS = lingkaran, SUDUT = kotak
                    if (p.smooth)
                      return <g key={pi}>{hit}<circle cx={p.x} cy={p.y} r={nodeR} fill={isSel ? "var(--accent)" : "var(--glyph)"}
                        stroke="var(--accent)" strokeWidth={nodeStroke} style={{ pointerEvents: "none" }} /></g>;
                    return <g key={pi}>{hit}<rect x={p.x - nodeR} y={p.y - nodeR} width={nodeR * 2} height={nodeR * 2}
                      fill={isSel ? "var(--accent)" : "var(--glyph)"} stroke="var(--accent)" strokeWidth={nodeStroke}
                      style={{ pointerEvents: "none" }} /></g>;
                  })}
                </g>
              ))}

              {/* pratinjau bentuk saat digambar (kotak/elips) */}
              {draft && (() => {
                const x0 = Math.min(draft.x0, draft.x1), x1 = Math.max(draft.x0, draft.x1);
                const y0 = Math.min(draft.y0, draft.y1), y1 = Math.max(draft.y0, draft.y1);
                const common = { fill: "color-mix(in srgb, var(--accent) 18%, transparent)", stroke: "var(--accent)", strokeWidth: nodeStroke, strokeDasharray: `${nodeR} ${nodeR}` } as const;
                return tool === "ellipse"
                  ? <ellipse cx={(x0 + x1) / 2} cy={(y0 + y1) / 2} rx={(x1 - x0) / 2} ry={(y1 - y0) / 2} {...common} />
                  : <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} {...common} />;
              })()}

              {/* kotak marquee (pilih banyak node) */}
              {marq && (() => {
                const x0 = Math.min(marq.x0, marq.x1), x1 = Math.max(marq.x0, marq.x1);
                const y0 = Math.min(marq.y0, marq.y1), y1 = Math.max(marq.y0, marq.y1);
                return <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0}
                  fill="color-mix(in srgb, var(--accent) 12%, transparent)" stroke="var(--accent)"
                  strokeWidth={nodeStroke} strokeDasharray={`${nodeR * 0.8} ${nodeR * 0.8}`} />;
              })()}

              {/* marquee elemen */}
              {eMarq && (() => {
                const x0 = Math.min(eMarq.x0, eMarq.x1), x1 = Math.max(eMarq.x0, eMarq.x1);
                const y0 = Math.min(eMarq.y0, eMarq.y1), y1 = Math.max(eMarq.y0, eMarq.y1);
                return <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0}
                  fill="color-mix(in srgb, var(--accent) 12%, transparent)" stroke="var(--accent)"
                  strokeWidth={nodeStroke} strokeDasharray={`${nodeR * 0.8} ${nodeR * 0.8}`} style={{ pointerEvents: "none" }} />;
              })()}

              {/* anchors — penanda silang + lingkaran (amber); seret = pindah */}
              {mode === "contour" && anchors.map((a, i) => {
                const r = nodeR * 1.05, arm = nodeR * 1.7;
                return (
                  <g key={i} style={{ cursor: "grab" }} onPointerDown={(e) => startAnchor(i, e)}>
                    <circle cx={a.x} cy={a.y} r={hitR} fill="transparent" />
                    <circle cx={a.x} cy={a.y} r={r} fill={aSel === i ? ANCHOR_COLOR : "transparent"} stroke={ANCHOR_COLOR} strokeWidth={nodeStroke} style={{ pointerEvents: "none" }} />
                    <line x1={a.x - arm} y1={a.y} x2={a.x + arm} y2={a.y} stroke={ANCHOR_COLOR} strokeWidth={handleStroke} style={{ pointerEvents: "none" }} />
                    <line x1={a.x} y1={a.y - arm} x2={a.x} y2={a.y + arm} stroke={ANCHOR_COLOR} strokeWidth={handleStroke} style={{ pointerEvents: "none" }} />
                  </g>
                );
              })}

              {/* garis bantu snap (alignment ke node/handle/metrik) — saat menyeret */}
              {snapG?.x != null && <line x1={snapG.x} y1={frameBottom} x2={snapG.x} y2={frameTop} stroke="#ff3df0" strokeWidth={nodeStroke} strokeDasharray={`${nodeR} ${nodeR}`} opacity={0.9} style={{ pointerEvents: "none" }} />}
              {snapG?.y != null && <line x1={lineX1} y1={snapG.y} x2={lineX2} y2={snapG.y} stroke="#ff3df0" strokeWidth={nodeStroke} strokeDasharray={`${nodeR} ${nodeR}`} opacity={0.9} style={{ pointerEvents: "none" }} />}

              {/* LSB / RSB bars (kiri = origin, kanan = advance) */}
              <MetricBar x={leftBarX} desc={d.descender} asc={d.ascender} color="var(--accent)"
                w={vw} onDown={(e: React.PointerEvent) => startBar("l", e)} active={mode === "metrics"} />
              <MetricBar x={rightBarX} desc={d.descender} asc={d.ascender} color="var(--good)"
                w={vw} onDown={(e: React.PointerEvent) => startBar("r", e)} active={mode === "metrics"} />
            </g>
            {/* label metrik (tak ikut flip) */}
            {guides.map(([y, label, , key]) => {
              const ly = key === null ? baseLineY : y; // label base ikut garis yang bergerak
              return (
                <text key={label} x={lineX1} y={frameTop - ly - vw * 0.005} fill="var(--faint)" fontSize={vw * 0.022}>
                  {label}{key ? ` ${Math.round(y)}` : ""}
                </text>
              );
            })}
            {/* label nama anchor (tak ikut flip → teks tegak) */}
            {mode === "contour" && anchors.map((a, i) => (
              <text key={`a${i}`} x={a.x + nodeR * 2} y={frameTop - a.y - nodeR * 0.6} fill={ANCHOR_COLOR}
                fontSize={vw * 0.02} style={{ pointerEvents: "none", fontWeight: aSel === i ? 700 : 400 }}>
                {a.name || "?"}
              </text>
            ))}
          </svg>
        {/* kontrol zoom (di luar SVG, fixed di pojok) */}
        <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg p-1" style={{ background: "var(--panel)", border: "1px solid var(--border)" }}>
          <button className="btn !p-1.5" onClick={() => zoomBtn(0.8)} title="Zoom out"><ZoomOut className="size-4" /></button>
          <span className="text-xs text-muted tabular-nums w-12 text-center">{Math.round(zoom * 100)}%</span>
          <button className="btn !p-1.5" onClick={() => zoomBtn(1.25)} title="Zoom in"><ZoomIn className="size-4" /></button>
          <button className="btn !p-1.5" onClick={resetView} title="Reset (100%)"><Maximize className="size-4" /></button>
        </div>
          </>
          )}
      </div>

      {/* METRICS: strip konteks spasi (glyph di antara glyph referensi; update live saat geser bar/ketik) */}
      {mode === "metrics" && (
        <div className="border-t flex items-stretch gap-3 px-3 py-2" style={{ borderColor: "var(--border)", background: "var(--bg-2)", height: 132 }}>
          <div className="flex flex-col gap-1 shrink-0 justify-center">
            <span className="label">Konteks</span>
            <input list="ge-glyphnames-m" className="field !w-24 !py-1 text-sm" value={ctxRef}
              onChange={(e) => setCtxRef(e.target.value)} placeholder="glyph ref" title="Glyph referensi di kiri-kanan (mis. n, o, H, O)" />
            <GlyphNameList id="ge-glyphnames-m" names={glyphNames} />
            <span className="text-faint text-[10px]">ref · glif · glif · ref</span>
          </div>
          <div className="flex-1 min-w-0">
            <MetricsStrip curPath={path} curComps={comps} glyphW={bbox0.current.xMax - bbox0.current.xMin}
              lsb={lsb} rsb={rsb} glyphXMin={bbox0.current.xMin} refGlyph={refData} ascender={d.ascender} descender={d.descender} />
          </div>
        </div>
      )}

      {/* kontrol bawah */}
      <div className="px-4 py-3 border-t flex items-center gap-x-4 gap-y-2 flex-wrap min-h-[64px]" style={{ borderColor: "var(--border)" }}>
        {mode === "metrics" ? (
          <>
            <Num label="LSB" value={lsb} color="var(--accent)" onCommit={(v) => commitSpace(v, rsb)} />
            <Num label="RSB" value={rsb} color="var(--good)" onCommit={(v) => commitSpace(lsb, v)} />
            <Num label="Advance" value={Math.round(curAdvance)} color="var(--glyph)" onCommit={commitAdvance} title="Lebar maju (advance); ubah → RSB diatur otomatis agar glyph tetap di tempat" />
            <button className="btn !py-1.5" onClick={() => commitSpace(0, 0)} title="Rapatkan batas kiri/kanan glyph INI ke node terluar (LSB=0, RSB=0). ⌘Z membatalkan.">
              <Ruler className="size-4" />Ke ink
            </button>
            <button className="btn !py-1.5" onClick={runFitAll} disabled={fitBusy} title="Rapatkan SEMUA glyph ke ink sekaligus (LSB=0, RSB=0, advance = lebar ink). Permanen — konfirmasi dulu.">
              {fitBusy ? <Loader2 className="size-4 animate-spin" /> : <Ruler className="size-4" />}Semua
            </button>
            <div className="h-9 w-px self-end mb-1" style={{ background: "var(--border)" }} />
            <Num label="Base ±" value={0} color="var(--accent)" compact resetOnCommit onCommit={(v) => shiftGlyphY(v)} title="Geser glyph vertikal (em); + naik, − turun" />
            <Num label="Cap" value={d.capHeight} color="var(--muted)" compact onCommit={(v) => commitMetric("capHeight", v)} />
            <Num label="x" value={d.xHeight} color="var(--muted)" compact onCommit={(v) => commitMetric("xHeight", v)} />
            <Num label="Asc" value={d.ascender} color="var(--muted)" compact onCommit={(v) => commitMetric("ascender", v)} />
            <Num label="Desc" value={d.descender} color="var(--muted)" compact onCommit={(v) => commitMetric("descender", v)} />
            <span className="text-faint text-xs ml-auto whitespace-nowrap hidden xl:block">Geser bar / garis · ketik · ⌘+scroll zoom</span>
          </>
        ) : mode === "contour" ? (
          cSel != null && comps[cSel] ? (
            <>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: "var(--bg-2)", color: COMP_COLOR }}>Komponen</span>
              <span className="text-sm font-medium" style={{ color: COMP_COLOR }}>{comps[cSel].base}</span>
              <Num label="X" value={comps[cSel].transform[4]} color={COMP_COLOR} compact onCommit={(v) => commitComps(comps.map((c, i) => (i === cSel ? { ...c, transform: [c.transform[0], c.transform[1], c.transform[2], c.transform[3], v, c.transform[5]] } : c)))} />
              <Num label="Y" value={comps[cSel].transform[5]} color={COMP_COLOR} compact onCommit={(v) => commitComps(comps.map((c, i) => (i === cSel ? { ...c, transform: [c.transform[0], c.transform[1], c.transform[2], c.transform[3], c.transform[4], v] } : c)))} />
              <Num label="Skala%" value={Math.round(comps[cSel].transform[0] * 100)} color={COMP_COLOR} compact onCommit={(v) => { const s = (v || 100) / 100; commitComps(comps.map((c, i) => (i === cSel ? { ...c, transform: [s, c.transform[1], c.transform[2], s, c.transform[4], c.transform[5]] } : c))); }} />
              <button className="btn ml-auto" onClick={() => deleteComp(cSel)}><Trash2 className="size-4" /> Hapus komponen</button>
            </>
          ) : aSel != null && anchors[aSel] ? (
            <>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: "var(--bg-2)", color: ANCHOR_COLOR }}>Anchor</span>
              <label className="flex flex-col gap-1">
                <span className="label" style={{ color: ANCHOR_COLOR }}>Nama</span>
                <input className="field !w-36" value={anchors[aSel].name} placeholder="nama (mis. top)"
                  onChange={(e) => setAnchors((as) => as.map((a, i) => (i === aSel ? { ...a, name: e.target.value } : a)))}
                  onBlur={(e) => renameAnchor(aSel, e.target.value.trim())}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
              </label>
              <Num label="X" value={anchors[aSel].x} color={ANCHOR_COLOR} compact onCommit={(v) => commitAnchors(anchors.map((a, i) => (i === aSel ? { ...a, x: v } : a)))} />
              <Num label="Y" value={anchors[aSel].y} color={ANCHOR_COLOR} compact onCommit={(v) => commitAnchors(anchors.map((a, i) => (i === aSel ? { ...a, y: v } : a)))} />
              <button className="btn ml-auto" onClick={() => deleteAnchor(aSel)}><Trash2 className="size-4" /> Hapus anchor</button>
            </>
          ) : (
          <>
            <span className="text-faint text-xs">
              {tool !== "select"
                ? `Seret di kanvas untuk gambar ${tool === "rect" ? "kotak" : "elips"} · Shift = sisi sama`
                : sel.size > 1 ? `${sel.size} node terpilih · seret = geser bareng · panah = nudge`
                : primary ? `Node (${Math.round(contours[primary.ci]?.[primary.pi]?.x ?? 0)}, ${Math.round(contours[primary.ci]?.[primary.pi]?.y ?? 0)})`
                : "Klik node · seret area = marquee · Shift-klik = tambah · dobel-klik segmen = tambah node"}
            </span>
            {/* tambah komponen (referensi glyph lain) */}
            <div className="flex items-center gap-1">
              <input list="ge-glyphnames" className="field !w-28 !py-1.5 text-xs" placeholder="+ komponen" value={addComp}
                onChange={(e) => setAddComp(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addComponent(addComp)} title="Ketik nama glyph basis lalu Tambah" />
              <button className="btn !py-1.5" onClick={() => addComponent(addComp)} disabled={!glyphNames.includes(addComp.trim())} title="Tambah komponen">
                <Boxes className="size-4" />Tambah
              </button>
              <GlyphNameList id="ge-glyphnames" names={glyphNames} />
            </div>
            {sel.size > 0 && tool === "select" && (
              <div className="flex items-center gap-1 ml-auto p-0.5 rounded-lg" style={{ background: "var(--bg-2)" }} title="Transform seleksi (di sekitar pusatnya)">
                <button className="btn !p-1.5" onClick={() => flipSel("h")} title="Flip horizontal"><FlipHorizontal2 className="size-4" /></button>
                <button className="btn !p-1.5" onClick={() => flipSel("v")} title="Flip vertical"><FlipVertical2 className="size-4" /></button>
                <button className="btn !p-1.5" onClick={() => rotateSel(90)} title="Putar 90° CCW"><RotateCcw className="size-4" /></button>
                <button className="btn !p-1.5" onClick={() => rotateSel(-90)} title="Putar 90° CW"><RotateCw className="size-4" /></button>
                <TransformNum label="Putar°" onApply={(v) => rotateSel(v)} placeholder="0" />
                <TransformNum label="Skala%" onApply={(v) => scaleSel(v)} placeholder="100" />
              </div>
            )}
            <button className={`btn ${sel.size > 0 && tool === "select" ? "" : "ml-auto"}`} onClick={toggleSmooth} disabled={!selIsOn}
              title="Sudut = handle independen (kotak) · Halus = handle terikat collinear (lingkaran)">
              {selSmooth ? <Square className="size-4" /> : <Circle className="size-4" />}
              {selSmooth ? "Jadikan sudut" : "Jadikan halus"}
            </button>
            <button className="btn" onClick={doRemove} disabled={!sel.size}>
              <Trash2 className="size-4" /> Hapus node{sel.size > 1 ? ` (${sel.size})` : ""}
            </button>
          </>
          )
        ) : mode === "element" ? (
          <>
            <span className="text-faint text-xs">
              {eSel.size ? `${eSel.size} elemen terpilih · seret = pindah · ⌘G group · ⌘D duplikat`
                : "Klik elemen (kontur/komponen) · seret = pindah · seret kosong = marquee · Shift-klik = tambah"}
            </span>
            <div className="flex items-center gap-1 ml-auto">
              {eSel.size > 0 && (
                <div className="flex items-center gap-1 p-0.5 rounded-lg" style={{ background: "var(--bg-2)" }} title="Transform elemen (di sekitar bbox-nya)">
                  <button className="btn !p-1.5" onClick={() => elemFlip("h")} title="Flip horizontal"><FlipHorizontal2 className="size-4" /></button>
                  <button className="btn !p-1.5" onClick={() => elemFlip("v")} title="Flip vertical"><FlipVertical2 className="size-4" /></button>
                  <button className="btn !p-1.5" onClick={() => elemRotate(90)} title="Putar 90° CCW"><RotateCcw className="size-4" /></button>
                  <button className="btn !p-1.5" onClick={() => elemRotate(-90)} title="Putar 90° CW"><RotateCw className="size-4" /></button>
                  <TransformNum label="Putar°" onApply={(v) => elemRotate(v)} placeholder="0" />
                  <TransformNum label="Skala%" onApply={(v) => elemScale(v)} placeholder="100" />
                </div>
              )}
              <button className="btn" onClick={duplicateElements} disabled={!eSel.size} title="Duplikat (⌘D)"><Copy className="size-4" /></button>
              <button className="btn" onClick={groupSel} disabled={eSel.size < 2} title="Group (⌘G)"><Group className="size-4" /></button>
              <button className="btn" onClick={ungroupSel} disabled={!eSel.size} title="Ungroup (⌘⇧G)"><Ungroup className="size-4" /></button>
              <button className="btn" onClick={deleteElements} disabled={!eSel.size}><Trash2 className="size-4" />{eSel.size > 1 ? ` ${eSel.size}` : ""}</button>
            </div>
          </>
        ) : mode === "kerning" ? (
          <>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: "var(--bg-2)", color: "var(--good)" }}>Kerning</span>
            {/* glyph AKTIF bisa diganti LANGSUNG di sini (nama glyph atau 1 karakter) — tanpa klik panel kiri */}
            <label className="flex items-center gap-1">
              <span className="label">Glyph</span>
              <input list="ge-glyphnames-k" className="field !w-20 !py-1.5 text-sm" value={kernSelf}
                onChange={(e) => setKernSelf(e.target.value)} placeholder="glyph"
                title="Glyph aktif pasangan — ketik nama glyph atau satu karakter (mis. A). Tak perlu klik panel kiri." />
            </label>
            <span className="text-sm font-semibold tabular-nums" title="Pasangan (kiri · kanan)">{kernLeft || "?"} · {kernRight || "?"}</span>
            <button className="btn !py-1.5" onClick={() => setKernSide((s) => (s === "left" ? "right" : "left"))} title="Tukar: glyph aktif di kiri/kanan pasangan">
              <ArrowLeftRight className="size-4" />{kernSide === "left" ? "aktif di kiri" : "aktif di kanan"}
            </button>
            <label className="flex items-center gap-1">
              <span className="label">Partner</span>
              <input list="ge-glyphnames-k" className="field !w-20 !py-1.5 text-sm" value={kernPartner}
                onChange={(e) => setKernPartner(e.target.value)} placeholder="glyph" title="Glyph pasangan kerning — nama glyph atau satu karakter" />
              <GlyphNameList id="ge-glyphnames-k" names={glyphNames} />
            </label>
            {/* satu field: "Semuanya"→tracking global · "Kelas"/"Pasangan"→kern pasangan.
                Nilai DITAHAN dulu (amber = belum ditetapkan) → tulis saat "Terapkan". */}
            {kernScope === "all"
              ? <Num label={kernDirty ? "Spasi semua*" : "Spasi semua"} value={trackVal} color={kernDirty ? "#e8a13a" : "var(--accent)"} onCommit={stageKern} title="Spasi global (em) — jarak seragam ke SEMUA pasangan (letter-spacing), berlapis di atas kerning. + renggang, − rapat. Nilai persisten; ikut export." />
              : <Num label={(kernScope === "smart" ? "Smart" : "Kern") + (kernDirty ? "*" : "")} value={kernVal} color={kernDirty ? "#e8a13a" : "var(--good)"} onCommit={stageKern} title="Nilai kern (em); + renggang, − rapat. Smart = saran optikal dari bentuk. Klik Terapkan utk menyimpan." />}
            {/* scope + nilai TERSIMPAN per level → jelas level mana yang punya nilai apa */}
            <div className="flex gap-0.5 p-0.5 rounded-lg" style={{ background: "var(--bg-2)" }} title="Semuanya = spasi global seragam ke SEMUA pasangan (letter-spacing, non-destruktif, ikut export) · Kelas = semua glyph se-grup · Pasangan = pasangan ini saja (exception) · Smart = saran kern optikal dari bentuk outline. Angka kecil = nilai tersimpan level itu.">
              {(["all", "class", "pair", "smart"] as const).map((s) => {
                const sv = s === "all" ? (tracking || null) : s === "class" ? kernInfo?.classValue ?? null : s === "pair" ? kernInfo?.pairValue ?? null : null;
                const label = s === "all" ? "Semuanya" : s === "class" ? "Kelas" : s === "pair" ? "Pasangan" : "Smart";
                return (
                  <button key={s} className="text-xs px-2 py-1 rounded-md font-medium flex items-center gap-1" onClick={() => setKernScope(s)}
                    style={{ background: kernScope === s ? "var(--accent)" : "transparent", color: kernScope === s ? "#fff" : "var(--muted)" }}>
                    {s === "smart" && <Sparkles className="size-3" />}{label}
                    {s === "smart"
                      ? (kernScope === "smart" && smartBusy && <Loader2 className="size-3 animate-spin" />)
                      : (sv != null && <span className="tabular-nums text-[10px] opacity-75">{sv > 0 ? `+${sv}` : sv}</span>)}
                  </button>
                );
              })}
            </div>
            {/* konfirmasi: muncul saat ada nilai tertahan */}
            {kernDirty && (
              <div className="flex items-center gap-1">
                <button className="btn btn-accent !py-1.5" onClick={applyKern}
                  title={kernScope === "all" ? "Tetapkan tracking global (tersimpan & ikut export)" : `Tetapkan nilai ${kernScope === "class" ? "level kelas (semua se-grup ikut)" : "exception pasangan ini"}`}>
                  <Check className="size-4" />Terapkan
                </button>
                <button className="btn !py-1.5 !px-2" onClick={cancelKern} title="Batalkan — kembali ke nilai tersimpan">
                  <X className="size-4" />
                </button>
              </div>
            )}
            {kernScope === "smart" && (
              <button className="btn !py-1.5" onClick={computeSmart} disabled={smartBusy}
                title="Hitung ulang saran Smart (kern optikal dari bentuk outline) untuk pasangan ini">
                {smartBusy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}Hitung ulang
              </button>
            )}
            {kernScope === "smart" && (
              <div className="relative">
                <button className="btn btn-accent !py-1.5" onClick={() => setAutoMenu((v) => !v)} disabled={autoBusy}
                  title="Auto-kern optikal SELURUH pasangan huruf & angka — pilih: isi yang kosong saja, atau timpa semua">
                  {autoBusy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}Auto-kern semua
                </button>
                {autoMenu && (
                  <div className="absolute top-full left-0 mt-1 z-50 rounded-xl border p-1 flex flex-col w-72 shadow-lg"
                       style={{ background: "var(--panel)", borderColor: "var(--border)" }}>
                    <button className="text-left text-xs px-2.5 py-2 rounded-lg hover:bg-[var(--bg)]"
                      onClick={() => { setAutoMenu(false); runAutoKernAll(true); }}>
                      <div className="font-medium">Hanya yang belum diatur (aman)</div>
                      <div className="text-faint mt-0.5">Mengisi pasangan kosong — kerning yang sudah Anda atur tidak diubah</div>
                    </button>
                    <button className="text-left text-xs px-2.5 py-2 rounded-lg hover:bg-[var(--bg)]"
                      onClick={() => { setAutoMenu(false); runAutoKernAll(false); }}>
                      <div className="font-medium" style={{ color: "#e8a13a" }}>Timpa semua</div>
                      <div className="text-faint mt-0.5">Hitung ulang optikal SEMUA pasangan — termasuk yang sudah diatur manual</div>
                    </button>
                  </div>
                )}
              </div>
            )}
            <button className="btn !py-1.5" onClick={expandKernClasses} disabled={kernBusy}
              title="Gabungkan varian aksen (Á,Â,Ä…) ke kelas huruf dasarnya → kern dasar otomatis berlaku utk aksen. Sekali jalan; mengubah groups + kerning.">
              {kernBusy ? <Loader2 className="size-4 animate-spin" /> : <Combine className="size-4" />}Perluas kelas
            </button>
            {/* "Nolkan semua kerning" dipindah ke TopBar (samping kiri "Re-seed") — aksi font-wide global. */}
            <span className="text-xs ml-auto whitespace-nowrap hidden lg:block" style={{ color: kernDirty ? "#e8a13a" : "var(--faint)" }}>
              {kernDirty
                ? (kernScope === "smart"
                  ? "Saran Smart siap — klik Terapkan (disimpan level kelas), atau ✕ batal"
                  : "Nilai belum ditetapkan — klik Terapkan untuk menyimpan, atau ✕ untuk batal")
                : kernScope === "smart"
                ? "Smart = kern optikal dari bentuk outline (lurus/bulat/menjorok/diagonal menyesuaikan). Pilih pasangan → saran muncul."
                : kernScope === "all"
                ? "Spasi global → jarak seragam ke SEMUA pasangan (letter-spacing), berlapis di atas kerning · persisten & ikut export"
                : kernScope === "class"
                ? (kernInfo?.leftGroup || kernInfo?.rightGroup
                  ? `Kelas ${(kernInfo?.leftGroup ?? kernLeft ?? "").replace("public.kern1.", "")} · ${(kernInfo?.rightGroup ?? kernRight ?? "").replace("public.kern2.", "")} → semua se-grup ikut`
                  : "Glyph ini tak punya kelas → tersimpan sbg pasangan")
                : `Pasangan ${kernLeft}·${kernRight} saja (exception)${kernInfo?.classValue != null ? ` · kelas=${kernInfo.classValue}` : ""}`}
            </span>
          </>
        ) : mode === "cleanup" ? (
          <>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: "var(--bg-2)", color: "var(--good)" }}>Rapikan</span>
            <label className="flex flex-col gap-1 shrink-0" title="Simpangan bentuk maksimum (unit em) — makin besar, makin agresif menghapus titik">
              <span className="label">Toleransi {cleanTol}</span>
              <input type="range" min={1} max={15} value={cleanTol} onChange={(e) => setCleanTol(Number(e.target.value))} className="w-28" />
            </label>
            <button className="btn btn-accent !py-1.5" onClick={runCleanup} disabled={cleanBusy}
              title="Hapus node/handle yang tidak dibutuhkan — bentuk karakter dipertahankan (dalam toleransi). ⌘Z membatalkan.">
              {cleanBusy ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}Rapikan node
            </button>
            <span className="text-xs tabular-nums text-muted shrink-0">{contours.reduce((n, c) => n + c.length, 0)} titik</span>
            <span className="text-xs ml-auto whitespace-nowrap hidden lg:block" style={{ color: cleanMsg?.startsWith("Gagal") ? "#e5654b" : "var(--faint)" }}>
              {cleanMsg ?? "Sistem menghapus node/handle yang tak dibutuhkan tanpa merusak bentuk — mulai dari toleransi kecil"}
            </span>
          </>
        ) : mode === "text" ? (
          <>
            <textarea className="field !py-1.5 flex-1 min-w-[200px] resize-none text-sm" rows={2} value={proofText}
              onChange={(e) => setProofText(e.target.value)} placeholder="Ketik di kolom ini atau LANGSUNG di kanvas (klik kanvas lalu ketik) · Enter = baris baru" />
            <label className="flex flex-col gap-1 shrink-0" title="Ukuran tampilan (px)">
              <span className="label">Ukuran {proofSize}px</span>
              <input type="range" min={24} max={240} value={proofSize} onChange={(e) => setProofSize(Number(e.target.value))} className="w-28" />
            </label>
            <div className="flex items-center gap-0.5 shrink-0" title="Zoom kanvas (⌘/Ctrl + scroll juga bisa)">
              <button className="btn !px-1.5 !py-1" onClick={() => setProofZoom((z) => zClamp(z / 1.25))}><ZoomOut className="size-3.5" /></button>
              <button className="text-xs tabular-nums w-11 text-center text-muted hover:text-[var(--text)]" title="Reset zoom 100%"
                onClick={() => setProofZoom(1)}>{Math.round(proofZoom * 100)}%</button>
              <button className="btn !px-1.5 !py-1" onClick={() => setProofZoom((z) => zClamp(z * 1.25))}><ZoomIn className="size-3.5" /></button>
            </div>
            <label className="flex items-center gap-1.5 shrink-0 text-xs" title="Terapkan kerning di pratinjau">
              <input type="checkbox" checked={proofKern} onChange={(e) => setProofKern(e.target.checked)} /> Kerning
            </label>
            <div className="flex items-center gap-1 shrink-0">
              <ProofToggle on={proofXray} onClick={() => setProofXray((v) => !v)} icon={Crosshair} label="X-Ray"
                title="Rangka (outline) — KLIK karakter untuk pilih mana yg di-X-Ray (Shift = beberapa)" />
              <ProofToggle on={proofNodes} onClick={() => setProofNodes((v) => !v)} icon={Spline} label="Node"
                title="Node & handle — KLIK karakter untuk pilih; seret node utk edit (Shift = beberapa)" />
              <ProofToggle on={proofKernEdit} onClick={() => setProofKernEdit((v) => !v)} icon={ArrowLeftRight} label="Atur kern"
                title="Seret sebuah glyph mendatar untuk mengatur kerning dengan glyph sebelumnya" />
            </div>
          </>
        ) : (
          <span className="text-faint text-xs flex items-center gap-2">
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: "var(--bg-2)", color: "var(--muted)" }}>
              {TOOLS.find((t) => t.id === mode)?.label}
            </span>
            Mode ini segera hadir — {TOOLS.find((t) => t.id === mode)?.hint}. Glyph tampil read-only.
          </span>
        )}
      </div>
    </div>
  );
}

// Datalist nama glyph (dropdown Partner/komponen/referensi) — memo: TIDAK dibangun ulang tiap
// render editor (dulu 3×199 <option> di-reconcile tiap frame drag → dropdown Chrome kadang glitch).
const GlyphNameList = memo(function GlyphNameList({ id, names }: { id: string; names: string[] }) {
  return <datalist id={id}>{names.map((n) => <option key={n} value={n} />)}</datalist>;
});

// Garis grid kanvas. Langkah adaptif tangga ×2/×2.5 dari snapStep → jarak garis ≥ 9px layar
// berapa pun zoom (jumlah garis konstan); hanya area viewBox terlihat yang digambar.
// memo: hanya re-render saat view/zoom/step berubah — TIDAK ikut tiap frame drag node.
const CanvasGrid = memo(function CanvasGrid({ vbX, vbY, vbW, vbH, frameTop, step, pxPer, sw, minor, major: majorCol }: {
  vbX: number; vbY: number; vbW: number; vbH: number; frameTop: number; step: number; pxPer: number; sw: number;
  minor: string; major: string;
}) {
  let s = Math.max(1, step);
  while (s * pxPer < 9) s *= (/^2/.test(String(s)) ? 2.5 : 2); // 10→20→50→100→200→500→…
  const major = s * 5; // garis mayor tiap 5 langkah (sedikit lebih tegas)
  const yTop = frameTop - vbY, yBot = frameTop - (vbY + vbH);
  const L: React.ReactNode[] = [];
  for (let x = Math.ceil(vbX / s) * s; x <= vbX + vbW; x += s)
    L.push(<line key={`vx${x}`} x1={x} y1={yBot} x2={x} y2={yTop}
      stroke={x % major === 0 ? majorCol : minor} strokeWidth={sw} />);
  for (let y = Math.ceil(yBot / s) * s; y <= yTop; y += s)
    L.push(<line key={`hy${y}`} x1={vbX} y1={y} x2={vbX + vbW} y2={y}
      stroke={y % major === 0 ? majorCol : minor} strokeWidth={sw} />);
  return <g style={{ pointerEvents: "none" }}>{L}</g>;
});

// ---- affine [a,b,c,d,e,f] (= SVG matrix): x'=a*x+c*y+e, y'=b*x+d*y+f ----
type Aff = [number, number, number, number, number, number];
const aApply = (M: Aff, x: number, y: number): [number, number] => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
// A∘B = terapkan B dulu lalu A
const aCompose = (A: Aff, B: Aff): Aff => [
  A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
  A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
];
const aMove = (dx: number, dy: number): Aff => [1, 0, 0, 1, dx, dy];
const aFlipH = (cx: number): Aff => [-1, 0, 0, 1, 2 * cx, 0];
const aFlipV = (cy: number): Aff => [1, 0, 0, -1, 0, 2 * cy];
const aScale = (s: number, cx: number, cy: number): Aff => [s, 0, 0, s, cx * (1 - s), cy * (1 - s)];
const aRot = (deg: number, cx: number, cy: number): Aff => {
  const a = (deg * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a);
  return [co, si, -si, co, cx - cx * co + cy * si, cy - cx * si - cy * co];
};
const roundAff = (M: Aff): Aff => [+M[0].toFixed(4), +M[1].toFixed(4), +M[2].toFixed(4), +M[3].toFixed(4), Math.round(M[4]), Math.round(M[5])];
// bbox komponen terpasang (dari baseBounds + transform)
function compBBox(cm: GlyphComponent) {
  const t = cm.transform as Aff, bb = cm.baseBounds;
  if (!bb) return { minX: t[4], minY: t[5], maxX: t[4], maxY: t[5] };
  const cs = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]].map(([x, y]) => aApply(t, x, y));
  const xs = cs.map((c) => c[0]), ys = cs.map((c) => c[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

// kotak: 4 node sudut (line), searah jarum jam di ruang font (y-up)
function makeRect(x0: number, y0: number, x1: number, y1: number): ContourPoint[] {
  const r = Math.round;
  return [
    { x: r(x0), y: r(y0), type: "line", smooth: false },
    { x: r(x0), y: r(y1), type: "line", smooth: false },
    { x: r(x1), y: r(y1), type: "line", smooth: false },
    { x: r(x1), y: r(y0), type: "line", smooth: false },
  ];
}
// elips: 4 node on-curve (curve, smooth) + 8 handle off-curve (aproksimasi kappa)
function makeEllipse(x0: number, y0: number, x1: number, y1: number): ContourPoint[] {
  const r = Math.round, K = 0.5522847498307936;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
  const kx = K * rx, ky = K * ry;
  const on = (x: number, y: number): ContourPoint => ({ x: r(x), y: r(y), type: "curve", smooth: true });
  const off = (x: number, y: number): ContourPoint => ({ x: r(x), y: r(y), type: "offcurve", smooth: false });
  return [
    on(cx + rx, cy),                                   // kanan
    off(cx + rx, cy + ky), off(cx + kx, cy + ry), on(cx, cy + ry),  // atas
    off(cx - kx, cy + ry), off(cx - rx, cy + ky), on(cx - rx, cy),  // kiri
    off(cx - rx, cy - ky), off(cx - kx, cy - ry), on(cx, cy - ry),  // bawah
    off(cx + kx, cy - ry), off(cx + rx, cy - ky),                   // tutup → kanan
  ];
}

// snap vektor (vx,vy) ke kelipatan 45° (lurus H/V/diagonal), panjang dipertahankan
function snap45(vx: number, vy: number): [number, number] {
  const mag = Math.hypot(vx, vy);
  if (!mag) return [0, 0];
  const a = Math.round(Math.atan2(vy, vx) / (Math.PI / 4)) * (Math.PI / 4);
  return [mag * Math.cos(a), mag * Math.sin(a)];
}

// Strip konteks spasi: ref · glyph · glyph · ref. Glyph live (lsb/rsb), tanpa kerning (murni sidebearing).
function MetricsStrip({ curPath, curComps, glyphW, lsb, rsb, glyphXMin, refGlyph, ascender, descender }: {
  curPath: string; curComps: GlyphComponent[]; glyphW: number; lsb: number; rsb: number; glyphXMin: number;
  refGlyph: { path: string; advance: number } | null; ascender: number; descender: number;
}) {
  const adv = glyphW + lsb + rsb; // advance current live
  // kontur tak ditranslasi saat spasi → xMin tetap glyphXMin; geser agar tepi kiri di (origin + lsb)
  const items: { tx: number; cur: boolean; path: string }[] = [];
  const bounds: number[] = [];
  let cx = 0;
  const add = (cur: boolean) => {
    bounds.push(cx);
    if (cur) { items.push({ path: curPath, tx: cx + lsb - glyphXMin, cur: true }); cx += adv; }
    else if (refGlyph) { items.push({ path: refGlyph.path, tx: cx, cur: false }); cx += refGlyph.advance; }
  };
  add(false); add(true); add(true); add(false); bounds.push(cx);
  const totalW = cx || 1;
  const top = ascender, H = top - descender, pad = H * 0.06;
  const sw = H * 0.0035;
  return (
    <svg viewBox={`${-pad} ${-pad} ${totalW + 2 * pad} ${H + 2 * pad}`} preserveAspectRatio="xMidYMid meet"
      style={{ width: "100%", height: "100%", display: "block" }}>
      <g transform={`matrix(1 0 0 -1 0 ${top})`}>
        <line x1={-pad} y1={0} x2={totalW + pad} y2={0} stroke="var(--border)" strokeWidth={sw} />
        {bounds.map((bx, i) => <line key={i} x1={bx} y1={descender} x2={bx} y2={ascender} stroke="var(--border)" strokeWidth={sw * 0.7} opacity={0.5} />)}
        {items.map((it, i) => (
          <g key={i} transform={`translate(${it.tx} 0)`}>
            <path d={it.path} fillRule="nonzero" fill={it.cur ? "var(--accent)" : "var(--glyph)"} opacity={it.cur ? 1 : 0.5} />
            {it.cur && curComps.map((c, ci) => (
              <path key={ci} d={c.basePath} transform={`matrix(${c.transform.join(" ")})`} fillRule="nonzero" fill="var(--accent)" />
            ))}
          </g>
        ))}
      </g>
    </svg>
  );
}

// Kanvas pasangan kerning: [left][right], geser glyph kanan = atur kern (live), lepas = commit.
type KernCell = { path: string; comps: GlyphComponent[]; advance: number; isCurrent: boolean };
function KerningCanvas({ left, right, kern, tracking = 0, editValue, onEdit, onCommit, ascender, descender, line = "var(--border)" }: {
  left: KernCell | null; right: KernCell | null; kern: number; tracking?: number;
  editValue: number; onEdit: (v: number) => void; onCommit: (v: number) => void; ascender: number; descender: number;
  line?: string; // warna garis bantu (ikut palet kanvas terang/gelap)
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ sx: number; k0: number; last: number } | null>(null);
  if (!left || !right) return <div className="h-full grid place-items-center text-faint text-sm">Pilih glyph partner untuk kerning…</div>;
  const rightX = left.advance + kern + tracking; // gap = advance + kern pasangan + tracking global
  const top = ascender, H = top - descender;
  // FRAME TETAP (tak bergantung kern) → skala konstan saat seret, glyph mengikuti kursor 1:1
  const pad = H * 0.45;
  const x0 = -pad, w = left.advance + right.advance + 2 * pad;
  const sw = H * 0.003;
  const down = (e: React.PointerEvent) => { e.stopPropagation(); svgRef.current!.setPointerCapture(e.pointerId); drag.current = { sx: e.clientX, k0: editValue, last: editValue }; };
  const move = (e: React.PointerEvent) => { const dd = drag.current; if (!dd) return; const m = svgRef.current!.getScreenCTM(); if (!m || !m.a) return; const nk = Math.round(dd.k0 + (e.clientX - dd.sx) / m.a); dd.last = nk; onEdit(nk); };
  const up = () => { const dd = drag.current; if (dd) { drag.current = null; onCommit(dd.last); } }; // commit nilai terakhir tepat (tanpa race)
  const cell = (c: KernCell, x: number) => (
    <g transform={`translate(${x} 0)`}>
      <path d={c.path} fillRule="nonzero" fill={c.isCurrent ? "var(--accent)" : "var(--glyph)"} />
      {c.comps.map((cc, i) => <path key={i} d={cc.basePath} transform={`matrix(${cc.transform.join(" ")})`} fillRule="nonzero" fill={c.isCurrent ? "var(--accent)" : "var(--glyph)"} />)}
    </g>
  );
  return (
    <svg ref={svgRef} viewBox={`${x0} ${-pad} ${w} ${H + 2 * pad}`} preserveAspectRatio="xMidYMid meet"
      style={{ width: "100%", height: "100%", display: "block", touchAction: "none" }}
      onPointerMove={move} onPointerUp={up} onPointerLeave={up}>
      <g transform={`matrix(1 0 0 -1 0 ${top})`}>
        <line x1={x0} y1={0} x2={x0 + w} y2={0} stroke={line} strokeWidth={sw} />
        <line x1={left.advance} y1={descender} x2={left.advance} y2={ascender} stroke={line} strokeWidth={sw * 0.8} strokeDasharray={`${H * 0.02} ${H * 0.015}`} opacity={0.6} />
        <line x1={rightX} y1={descender} x2={rightX} y2={ascender} stroke="var(--good)" strokeWidth={sw * 0.8} opacity={0.7} />
        {cell(left, 0)}
        {/* glyph kanan: seret untuk atur kern (rect transparan + path dalam satu grup) */}
        <g transform={`translate(${rightX} 0)`} style={{ cursor: "ew-resize" }} onPointerDown={down}>
          <rect x={-pad * 0.4} y={descender} width={right.advance + pad * 0.8} height={H} fill="transparent" />
          <path d={right.path} fillRule="nonzero" fill={right.isCurrent ? "var(--accent)" : "var(--glyph)"} />
          {right.comps.map((cc, i) => <path key={i} d={cc.basePath} transform={`matrix(${cc.transform.join(" ")})`} fillRule="nonzero" fill={right.isCurrent ? "var(--accent)" : "var(--glyph)"} />)}
        </g>
      </g>
      <text x={left.advance + (kern + tracking) / 2} y={H * 0.1} textAnchor="middle" fill="var(--good)" fontSize={H * 0.05} fontWeight={600}>{editValue > 0 ? `+${editValue}` : editValue}</text>
    </svg>
  );
}

// Proofing teks: render string sebagai deret glyph (cmap → nama), advance + kerning, multi-baris.
// X-Ray (outline/rangka), node/handle, dan atur-kerning (seret glyph) — ala Illustrator/Affinity.
function TextProof({ text, charToName, glyphs, kerns, kernOn, upm, ascender, descender, fontSize, loading, tracking = 0, onTextChange, bg = "#fff",
  xray = false, showNodes = false, kernEdit = false, onKernLive, onKernCommit,
  showGrid = false, gMinor = "#dde2eb", gMajor = "#b9c2d0", snapStep = 10, onOutlineLive, onOutlineCommit,
  zoom = 1, onZoom, interact }: {
  text: string; charToName: Record<string, string>;
  glyphs: Record<string, GlyphRender>;
  kerns: Record<string, number>; kernOn: boolean; upm: number; ascender: number; descender: number; fontSize: number; loading: boolean; tracking?: number;
  onTextChange: (t: string) => void;
  bg?: string; // latar kanvas (ikut palet terang/gelap)
  xray?: boolean; showNodes?: boolean; kernEdit?: boolean;
  onKernLive?: (l: string, r: string, v: number) => void;   // seret → geser live (cache)
  onKernCommit?: (l: string, r: string, v: number) => void; // lepas → tulis backend
  showGrid?: boolean; gMinor?: string; gMajor?: string; snapStep?: number;
  onOutlineLive?: (nm: string, contours: ContourPoint[][]) => void;   // seret node → live
  onOutlineCommit?: (nm: string, contours: ContourPoint[][]) => void; // lepas → tulis backend
  zoom?: number; onZoom?: (factor: number) => void;                    // zoom kanvas (⌘/Ctrl+scroll)
  interact?: React.MutableRefObject<boolean>;                          // true selama seret (jangan timpa cache)
}) {
  // HOOKS harus di atas (sebelum early-return) → urutan hook konsisten
  const svgRef = useRef<SVGSVGElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  // drag-kern state (HOOK → harus sebelum early-return agar urutan hook konsisten)
  const kdrag = useRef<{ sx: number; base: number; l: string; r: string; last: number } | null>(null);
  const [selCells, setSelCells] = useState<Set<string>>(new Set()); // karakter terpilih ("li:ci") utk X-Ray/node
  const ndrag = useRef<{ name: string; ci: number; pi: number; ox: number; oy: number; sx: number; sy: number; work: ContourPoint[][] } | null>(null);
  // ukuran area kanvas (content-box) → SVG dibesarkan agar grid mengisi SELURUH kanvas, bukan cuma konten
  const [box, setBox] = useState({ w: 0, h: 0 });
  const boxCleanup = useRef<(() => void) | undefined>(undefined);
  const onZoomRef = useRef(onZoom); onZoomRef.current = onZoom; // listener wheel selalu pakai handler terbaru
  const boxCb = useCallback((el: HTMLDivElement | null) => {
    boxCleanup.current?.(); boxCleanup.current = undefined;
    boxRef.current = el;
    if (el) {
      const ro = new ResizeObserver((ents) => { const cr = ents[0].contentRect; setBox({ w: cr.width, h: cr.height }); });
      ro.observe(el);
      // ⌘/Ctrl + scroll = zoom kanvas (non-pasif agar bisa cegah zoom browser); scroll biasa tetap scroll
      const wheel = (e: WheelEvent) => {
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); onZoomRef.current?.(Math.exp(-e.deltaY * 0.0015)); }
      };
      el.addEventListener("wheel", wheel, { passive: false });
      boxCleanup.current = () => { ro.disconnect(); el.removeEventListener("wheel", wheel); };
    }
  }, []);
  const cc = Math.max(0, Math.min(caret, text.length)); // caret ter-clamp
  if (loading && !Object.keys(glyphs).length) return <div className="h-full grid place-items-center text-faint text-sm" style={{ background: bg }}>Memuat glyph…</div>;

  const lines = text.split("\n");
  const lineH = (ascender - descender) * 1.28, capH = ascender * 0.7;
  let maxW = 0;
  // charX[k] = offset-x SEBELUM karakter ke-k (utk posisi & penempatan kursor); panjang = line.length+1
  const rendered = lines.map((line, li) => {
    let x = 0; let prev: string | null = null;
    const cells: { x: number; name?: string; box?: boolean; advance: number; prevName?: string }[] = [];
    const charX: number[] = [];
    for (let k = 0; k < line.length; k++) {
      charX.push(x);
      const ch = line[k];
      const nm = charToName[ch];
      if (!nm) { if (ch === " " || ch === "\t") { x += upm * (ch === "\t" ? 1.2 : 0.32); } else { const aw = upm * 0.45; cells.push({ x, box: true, advance: aw }); x += aw; } prev = null; continue; }
      const data = glyphs[nm]; const aw = data ? data.advance : upm * 0.5;
      if (kernOn && prev && data && kerns[`${prev} ${nm}`]) x += kerns[`${prev} ${nm}`];
      cells.push({ x, name: nm, advance: aw, prevName: prev ?? undefined }); x += aw + tracking; prev = nm; // tracking global per glyph
    }
    charX.push(x);
    maxW = Math.max(maxW, x);
    return { cells, charX, baseline: ascender + li * lineH };
  });
  const totalW = Math.max(maxW, upm), totalH = ascender + (lines.length - 1) * lineH + (-descender) + lineH * 0.12;
  const fs = fontSize * zoom; // ukuran efektif = slider × zoom kanvas
  const px = (u: number) => (u / upm) * fs;
  // Ukuran SVG = maksimum(konten, area kanvas) → grid & latar mengisi seluruh kanvas walau teks pendek.
  const pxPer = fs / upm;                             // px per unit glyph
  const svgWpx = Math.max(px(totalW), box.w), svgHpx = Math.max(px(totalH), box.h);
  const vbW = pxPer > 0 ? svgWpx / pxPer : totalW;    // lebar/tinggi viewBox dalam unit
  const vbH = pxPer > 0 ? svgHpx / pxPer : totalH;

  // pemetaan indeks-datar ⇄ (baris, kolom)
  const lineStart: number[] = []; { let acc = 0; for (let i = 0; i < lines.length; i++) { lineStart.push(acc); acc += lines[i].length + 1; } }
  let cli = 0; while (cli + 1 < lines.length && cc >= lineStart[cli + 1]) cli++;
  const ccol = cc - lineStart[cli];
  const caretX = rendered[cli]?.charX[ccol] ?? 0;
  const caretBase = rendered[cli]?.baseline ?? ascender;

  const edit = (t: string, nc: number) => { onTextChange(t); setCaret(Math.max(0, Math.min(t.length, nc))); };
  function onKey(e: React.KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // biarkan shortcut global (mis. paste ditangani onPaste)
    const t = text, c = cc;
    if (e.key === "Backspace") { e.preventDefault(); if (c > 0) edit(t.slice(0, c - 1) + t.slice(c), c - 1); return; }
    if (e.key === "Delete") { e.preventDefault(); if (c < t.length) edit(t.slice(0, c) + t.slice(c + 1), c); return; }
    if (e.key === "Enter") { e.preventDefault(); edit(t.slice(0, c) + "\n" + t.slice(c), c + 1); return; }
    if (e.key === "ArrowLeft") { e.preventDefault(); setCaret(Math.max(0, c - 1)); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); setCaret(Math.min(t.length, c + 1)); return; }
    if (e.key === "Home") { e.preventDefault(); setCaret(lineStart[cli]); return; }
    if (e.key === "End") { e.preventDefault(); setCaret(lineStart[cli] + lines[cli].length); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); if (cli > 0) setCaret(lineStart[cli - 1] + Math.min(ccol, lines[cli - 1].length)); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); if (cli < lines.length - 1) setCaret(lineStart[cli + 1] + Math.min(ccol, lines[cli + 1].length)); return; }
    if (e.key.length === 1) { e.preventDefault(); edit(t.slice(0, c) + e.key + t.slice(c), c + 1); return; }
  }
  function onPaste(e: React.ClipboardEvent) { const s = e.clipboardData.getData("text"); if (!s) return; e.preventDefault(); edit(text.slice(0, cc) + s + text.slice(cc), cc + s.length); }
  function placeCaret(e: React.PointerEvent) {
    if ((xray || showNodes) && !kernEdit && selCells.size) setSelCells(new Set()); // klik area kosong → lepas seleksi
    const svg = svgRef.current; if (!svg) return;
    const r = svg.getBoundingClientRect();
    const ux = (e.clientX - r.left) * (vbW / r.width), uy = (e.clientY - r.top) * (vbH / r.height);
    let li = Math.round((uy - ascender) / lineH); li = Math.max(0, Math.min(lines.length - 1, li));
    const cx = rendered[li].charX; let best = 0, bd = Infinity;
    for (let k = 0; k < cx.length; k++) { const dd = Math.abs(cx[k] - ux); if (dd < bd) { bd = dd; best = k; } }
    setCaret(lineStart[li] + best); boxRef.current?.focus();
  }
  // drag-kern (mode "Atur kern"): seret glyph → ubah kern dgn glyph sebelumnya. 1px layar = fontSize/upm unit.
  function startKern(l: string, r: string, e: React.PointerEvent) {
    e.stopPropagation(); svgRef.current?.setPointerCapture(e.pointerId);
    const base = kerns[`${l} ${r}`] ?? 0;
    kdrag.current = { sx: e.clientX, base, l, r, last: base };
    if (interact) interact.current = true;
  }
  function moveKern(e: React.PointerEvent) {
    const k = kdrag.current; if (!k) return;
    const m = svgRef.current?.getScreenCTM(); if (!m || !m.a) return;
    const nv = Math.round(k.base + (e.clientX - k.sx) / m.a);
    if (nv !== k.last) { k.last = nv; onKernLive?.(k.l, k.r, nv); }
  }
  function upKern() { if (interact) interact.current = false; const k = kdrag.current; if (!k) return; kdrag.current = null; onKernCommit?.(k.l, k.r, k.last); }

  // ukuran outline/node dlm UNIT glyph → konstan di layar (dibagi skala efektif fs/upm)
  const xsw = (1.2 * upm) / fs;      // stroke X-Ray
  const nodeSz = (3.6 * upm) / fs;   // sisi kotak on-curve
  const handleR = (2.3 * upm) / fs;  // radius bulatan off-curve
  const hsw = (0.9 * upm) / fs;      // stroke garis handle

  // pilih karakter (X-Ray/node hanya utk yg dipilih; Shift = tambah/kurangi). Bukan langsung semua.
  function selectCell(key: string, e: React.PointerEvent) {
    e.stopPropagation();
    setSelCells((prev) => {
      if (e.shiftKey) { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; }
      return new Set([key]);
    });
  }
  // edit node/handle glyph terpilih (seret). Y dibalik (grup scale(1,-1)). Live → commit (setOutline).
  function startNode(nm: string, ci: number, pi: number, e: React.PointerEvent) {
    e.stopPropagation(); svgRef.current?.setPointerCapture(e.pointerId);
    const src = glyphs[nm]?.outline; if (!src) return;
    const work = src.map((c) => c.map((p) => ({ ...p })));
    const p = work[ci]?.[pi]; if (!p) return;
    ndrag.current = { name: nm, ci, pi, ox: p.x, oy: p.y, sx: e.clientX, sy: e.clientY, work };
    if (interact) interact.current = true;
  }
  function moveNode(e: React.PointerEvent) {
    const nd = ndrag.current; if (!nd) return;
    const m = svgRef.current?.getScreenCTM(); if (!m || !m.a || !m.d) return;
    nd.work[nd.ci][nd.pi] = { ...nd.work[nd.ci][nd.pi],
      x: Math.round(nd.ox + (e.clientX - nd.sx) / m.a), y: Math.round(nd.oy - (e.clientY - nd.sy) / m.d) };
    onOutlineLive?.(nd.name, nd.work);
  }
  function upNode() { if (interact) interact.current = false; const nd = ndrag.current; if (!nd) return; ndrag.current = null; onOutlineCommit?.(nd.name, nd.work); }
  // marker node/handle satu glyph (draggable) — dipakai hanya utk cell terpilih
  function nodeMarkers(nm: string, outline: ContourPoint[][]): React.ReactNode[] {
    const els: React.ReactNode[] = [];
    outline.forEach((c, ci) => {
      const n = c.length;
      c.forEach((p, pi) => {
        if (p.type !== "offcurve") return;
        const prev = c[(pi - 1 + n) % n], next = c[(pi + 1) % n];
        if (prev.type !== "offcurve") els.push(<line key={`hl${ci}-${pi}a`} x1={prev.x} y1={prev.y} x2={p.x} y2={p.y} stroke="#8b93a3" strokeWidth={hsw} />);
        if (next.type !== "offcurve") els.push(<line key={`hl${ci}-${pi}b`} x1={next.x} y1={next.y} x2={p.x} y2={p.y} stroke="#8b93a3" strokeWidth={hsw} />);
      });
      c.forEach((p, pi) => {
        els.push(<circle key={`hit${ci}-${pi}`} cx={p.x} cy={p.y} r={nodeSz * 1.5} fill="transparent" style={{ cursor: "grab" }} onPointerDown={(e) => startNode(nm, ci, pi, e)} />);
        if (p.type === "offcurve") els.push(<circle key={`o${ci}-${pi}`} cx={p.x} cy={p.y} r={handleR} fill="#8b93a3" style={{ pointerEvents: "none" }} />);
        else els.push(<rect key={`nn${ci}-${pi}`} x={p.x - nodeSz / 2} y={p.y - nodeSz / 2} width={nodeSz} height={nodeSz} fill="var(--accent)" style={{ pointerEvents: "none" }} />);
      });
    });
    return els;
  }

  // grid kanvas teks (adaptif) — hanya bila showGrid aktif; melintasi SELURUH viewBox (isi kanvas)
  const gridEls: React.ReactNode[] = [];
  if (showGrid) {
    let gs = Math.max(1, snapStep);
    while (gs * pxPer < 8) gs *= /^2/.test(String(gs)) ? 2.5 : 2;
    const gmaj = gs * 5, gw = pxPer > 0 ? 0.8 / pxPer : 1;
    for (let x = 0; x <= vbW; x += gs) gridEls.push(<line key={`gx${x}`} x1={x} y1={0} x2={x} y2={vbH} stroke={x % gmaj === 0 ? gMajor : gMinor} strokeWidth={gw} />);
    for (let y = 0; y <= vbH; y += gs) gridEls.push(<line key={`gy${y}`} x1={0} y1={y} x2={vbW} y2={y} stroke={y % gmaj === 0 ? gMajor : gMinor} strokeWidth={gw} />);
  }

  return (
    <div ref={boxCb} tabIndex={0} onKeyDown={onKey} onPaste={onPaste}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      className="h-full overflow-auto py-5 pr-6 pl-16 outline-none relative" style={{ background: bg, cursor: "text" }}>
      {!text && (
        <div className="absolute left-16 top-5 text-faint text-sm pointer-events-none select-none">
          Klik di sini lalu ketik langsung — atau gunakan kolom di bawah.
        </div>
      )}
      {text && (xray || showNodes) && !kernEdit && selCells.size === 0 && (
        <div className="absolute right-4 top-3 text-faint text-[11px] pointer-events-none select-none px-2 py-1 rounded"
          style={{ background: "var(--bg-2)", border: "1px solid var(--border)" }}>
          Klik karakter untuk pilih (Shift = beberapa)
        </div>
      )}
      <svg ref={svgRef} width={svgWpx} height={svgHpx} viewBox={`0 0 ${vbW} ${vbH}`} style={{ display: "block" }}
        onPointerDown={placeCaret}
        onPointerMove={(e) => { moveKern(e); moveNode(e); }}
        onPointerUp={() => { upKern(); upNode(); }}
        onPointerLeave={() => { upKern(); upNode(); }}>
        {showGrid && gridEls}
        {rendered.map((ln, li) => ln.cells.map((c, ci) => {
          if (c.box) return <rect key={`${li}-${ci}`} x={c.x + upm * 0.05} y={ln.baseline - capH} width={Math.max(1, c.advance - upm * 0.1)} height={capH} rx={upm * 0.02} fill="none" stroke="var(--faint)" strokeWidth={upm * 0.012} />;
          const data = c.name ? glyphs[c.name] : null;
          if (!data) return null;
          const showX = xray && selCells.has(`${li}:${ci}`); // X-Ray HANYA utk karakter terpilih
          const gfill = showX ? "none" : "var(--glyph)";
          const gstroke = showX ? "var(--glyph)" : "none";
          return (
            <g key={`${li}-${ci}`} transform={`translate(${c.x} ${ln.baseline}) scale(1 -1)`}>
              <path d={data.path} fillRule="nonzero" fill={gfill} stroke={gstroke} strokeWidth={showX ? xsw : 0} />
              {data.components.map((k2, k) => { const bp = glyphs[k2.base]?.path; return bp ? <path key={k} d={bp} transform={`matrix(${k2.transform.join(" ")})`} fillRule="nonzero" fill={gfill} stroke={gstroke} strokeWidth={showX ? xsw : 0} /> : null; })}
            </g>
          );
        }))}
        {/* seleksi karakter (X-Ray/Node ON, bukan mode Atur-kern) — klik glyph utk pilih; Shift = multi */}
        {(xray || showNodes) && !kernEdit && rendered.map((ln, li) => ln.cells.map((c, ci) => c.name ? (
          <rect key={`s${li}-${ci}`} x={c.x} y={ln.baseline - ascender} width={c.advance} height={ascender - descender}
            fill={selCells.has(`${li}:${ci}`) ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent"}
            style={{ cursor: "pointer" }} onPointerDown={(e) => selectCell(`${li}:${ci}`, e)} />
        ) : null))}
        {/* node/handle draggable — HANYA karakter terpilih (tak semua sekaligus) */}
        {showNodes && rendered.map((ln, li) => ln.cells.map((c, ci) => {
          const data = c.name ? glyphs[c.name] : null;
          if (!data || !data.outline || !selCells.has(`${li}:${ci}`)) return null;
          return <g key={`nd${li}-${ci}`} transform={`translate(${c.x} ${ln.baseline}) scale(1 -1)`}>{nodeMarkers(c.name!, data.outline)}</g>;
        }))}
        {/* mode "Atur kern": rect transparan tiap glyph yg punya glyph sebelumnya → seret mendatar utk kern */}
        {kernEdit && rendered.map((ln, li) => ln.cells.map((c, ci) => (c.name && c.prevName) ? (
          <rect key={`k${li}-${ci}`} x={c.x} y={ln.baseline - ascender} width={c.advance} height={ascender - descender}
            fill="transparent" style={{ cursor: "ew-resize" }} onPointerDown={(e) => startKern(c.prevName!, c.name!, e)} />
        ) : null))}
        {/* kursor teks (kedip) saat kanvas fokus */}
        {focused && <line x1={caretX} y1={caretBase - ascender} x2={caretX} y2={caretBase - descender}
          stroke="var(--accent)" strokeWidth={upm * 0.016} className="animate-pulse" />}
      </svg>
    </div>
  );
}

// Toggle chip untuk kontrol mode Text (X-Ray / Node / Atur kern)
function ProofToggle({ on, onClick, icon: Icon, label, title }: { on: boolean; onClick: () => void; icon: any; label: string; title: string }) {
  return (
    <button onClick={onClick} title={title}
      className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition shrink-0"
      style={{ background: on ? "var(--accent)" : "var(--bg-2)", color: on ? "#fff" : "var(--muted)", border: "1px solid var(--border)" }}>
      <Icon className="size-3.5" /> {label}
    </button>
  );
}

function MetricBar({ x, desc, asc, color, w, onDown, active }: any) {
  return (
    <g style={{ cursor: active ? "ew-resize" : "default" }} onPointerDown={active ? onDown : undefined}>
      <line x1={x} y1={desc} x2={x} y2={asc} stroke={color} strokeWidth={w * 0.003} opacity={active ? 1 : 0.5} />
      {active && <rect x={x - w * 0.018} y={desc} width={w * 0.036} height={asc - desc} fill="transparent" />}
    </g>
  );
}

// Tombol tool di panel kiri (ikon + tooltip). Titik abu = mode belum aktif (kerangka).
function ToolBtn({ active, onClick, icon: Icon, label, hint, ready }: any) {
  return (
    <button onClick={onClick} title={`${label} — ${hint}`}
      className="grid place-items-center size-9 rounded-lg relative transition"
      style={{ background: active ? "var(--accent)" : "transparent", color: active ? "#fff" : "var(--muted)" }}>
      <Icon className="size-[18px]" />
      {!ready && <span className="absolute top-1 right-1 size-1.5 rounded-full" style={{ background: "var(--muted)" }} />}
    </button>
  );
}

// input angka kecil utk transform (putar derajat / skala persen) — terapkan saat Enter/blur
function TransformNum({ label, onApply, placeholder }: { label: string; onApply: (v: number) => void; placeholder: string }) {
  const [v, setV] = useState("");
  const apply = () => { const n = Number(v); if (v.trim() !== "" && !Number.isNaN(n)) { onApply(n); setV(""); } };
  return (
    <label className="flex items-center gap-1 pl-1" title={`${label} (Enter)`}>
      <span className="label !text-[10px]">{label}</span>
      <input className="field tabular-nums !w-14 !py-1 !px-1.5 text-xs" type="number" value={v} placeholder={placeholder}
        onChange={(e) => setV(e.target.value)} onBlur={apply}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
    </label>
  );
}

function ModeBtn({ active, onClick, icon, children }: any) {
  return (
    <button onClick={onClick} className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition"
      style={{ background: active ? "var(--accent)" : "transparent", color: active ? "#fff" : "var(--muted)" }}>
      {icon}{children}
    </button>
  );
}

function Num({ label, value, color, onCommit, compact, disabled, title, resetOnCommit }: { label: string; value: number; color: string; onCommit: (v: number) => void; compact?: boolean; disabled?: boolean; title?: string; resetOnCommit?: boolean }) {
  const [v, setV] = useState(String(value));
  const focused = useRef(false);
  // JANGAN sinkron prop→input selagi field difokus/diketik: refetch/recompile latar bisa mengubah
  // `value` di tengah ketikan → input "balik ke nilai awal". Sinkron HANYA saat tak difokus.
  useEffect(() => { if (!focused.current) setV(String(value)); }, [value]);
  return (
    <label className="flex flex-col gap-1" title={title}>
      <span className="label" style={{ color }}>{label}</span>
      <input className={`field tabular-nums ${compact ? "!w-16" : "!w-24"}`} type="number" value={v} disabled={disabled}
        style={disabled ? { opacity: 0.5 } : undefined}
        onFocus={() => { focused.current = true; }}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          focused.current = false;
          if (disabled) return;
          // commit HANYA bila nilai berubah — blur biasa (klik pindah field / buka dropdown) tak
          // menulis apa pun; dulu selalu commit → nilai pasangan LAMA bisa tertulis ke pasangan baru.
          const n = Math.round(Number(v) || 0);
          if (n !== Math.round(value)) {
            onCommit(n);
            if (resetOnCommit) setV(String(value)); // field delta (Base ±) balik ke 0 → blur berikut tak commit ulang
          }
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
    </label>
  );
}
