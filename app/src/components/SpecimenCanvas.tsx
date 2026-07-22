import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MagnifyingGlassPlus, MagnifyingGlassMinus, CornersOut } from "@phosphor-icons/react";
import type { GuideMode, StagedGuide, StagingState } from "../types";

const MIN_Z = 0.25, MAX_Z = 10; // 25%–1000%
const SNAP_PX = 7;              // jarak tarik magnet (piksel layar)

/**
 * Kelompokkan nilai tepi (bbox) jadi klaster ber-toleransi. Lebar tiap klaster dibatasi `tol`
 * (dibandingkan ke ANGGOTA PERTAMA, bukan berantai) agar tak melar.
 *
 * INTI TIPOGRAFI: klaster TERBESAR = huruf beralas/berpuncak RATA (H I E x n m) = baseline/cap SEJATI.
 * Huruf bulat & lancip (o e c s v w A) punya OVERSHOOT ~1–1.5% — sengaja menonjol melewati garis agar
 * tampak sejajar optis — sehingga jatuh ke klaster kecil terpisah. Karena itu snap HARUS memilih
 * klaster paling ramai, BUKAN tepi terekstrem/terdekat; kalau tidak, baseline mendarat di overshoot 'o'
 * dan metrik vertikal SELURUH font meleset.
 */
function clusterEdges(vals: number[], tol: number): { y: number; count: number }[] {
  if (!vals.length) return [];
  const s = [...vals].sort((a, b) => a - b);
  const out: { y: number; count: number }[] = [];
  let grp: number[] = [s[0]];
  const finish = (g: number[]) => out.push({ y: Math.round(g[Math.floor(g.length / 2)]), count: g.length }); // median
  for (let i = 1; i < s.length; i++) {
    if (s[i] - grp[0] <= tol) grp.push(s[i]);
    else { finish(grp); grp = [s[i]]; }
  }
  finish(grp);
  return out;
}

/**
 * Kanvas specimen (viewport TETAP, konten di-transform → GPU/composited, mulus).
 * Zoom: pinch / Ctrl/⌘+scroll ke kursor (maks 1000%) · pan: scroll dua jari · tombol +/−/reset.
 * Seleksi glyph: klik = pilih · Shift-klik = tambah/kurang · seret area kosong = marquee (+badge jumlah)
 *   · klik area kosong = batal pilih · seret glyph terpilih = PINDAH · panah = geser (Shift=5×).
 * Garis baseline/cap: seret = SEMUA garis se-tipe bergerak bareng · Shift-klik = pilih spesifik (lalu seret = itu saja)
 *   · Alt-seret = salin · Delete = hapus. (garis mengontrol normalisasi vertikal saat commit).
 */
export function SpecimenCanvas({
  staging,
  sel,
  setSel,
  onGuides,
  onMoveShapes,
  snapOn,
  guideMode,
}: {
  staging: StagingState;
  sel: Set<number>;
  setSel: React.Dispatch<React.SetStateAction<Set<number>>>;
  onGuides: (guides: { y: number; type: string; linked?: boolean }[]) => void;
  onMoveShapes: (ids: number[], dx: number, dy: number) => void;
  snapOn: boolean; // magnet garis — tombolnya di toolbar wizard (samping "Pisah"), state di ImportWizard
  guideMode: GuideMode; // apa yang ikut bergerak saat garis diseret — tombolnya juga di toolbar wizard
}) {
  const [vx, vy, vw, vh] = staging.viewBox;
  const [guides, setGuides] = useState<StagedGuide[]>(staging.guides);
  const [selG, setSelG] = useState<Set<number>>(new Set());
  // VIEW berbasis viewBox: fx/fy = pusat (fraksi frame konten), zoom = skala. SVG ukuran TETAP (= layar)
  //  → konten diraster ulang secara vektor tiap level zoom (tajam, tak pecah); hanya jendela terlihat yang dirender.
  const [view, setView] = useState({ fx: 0.5, fy: 0.5, zoom: 1 });
  const [elem, setElem] = useState({ w: 800, h: 560 }); // ukuran piksel SVG (via ResizeObserver)
  const zoom = view.zoom;
  const [marquee, setMarquee] = useState<{ sx: number; sy: number; cx: number; cy: number; n: number } | null>(null);
  const [moveOff, setMoveOff] = useState<{ dx: number; dy: number; ids: Set<number> } | null>(null);
  const [snapHit, setSnapHit] = useState<{ y: number; count: number; type: string } | null>(null); // indikator saat menempel
  const svgRef = useRef<SVGSVGElement>(null);
  const contRef = useRef<HTMLDivElement>(null);
  const guideDrag = useRef<any>(null);
  const dragKind = useRef<null | "guide" | "marquee" | "moveShapes">(null);
  const mq = useRef<any>(null);
  const moveDrag = useRef<any>(null);
  const moveOffRef = useRef(moveOff); moveOffRef.current = moveOff;
  const guidesRef = useRef(guides); guidesRef.current = guides;
  const selGRef = useRef(selG); selGRef.current = selG;
  const snapOnRef = useRef(snapOn); snapOnRef.current = snapOn;
  // Klaster tepi bawah (utk baseline) & tepi atas (utk cap) dari bbox shape yang IKUT diimpor.
  // Toleransi klaster sengaja DI BAWAH besar overshoot (~1–1.5% tinggi glyph) supaya huruf beralas
  // rata dan huruf overshoot TIDAK menyatu jadi satu klaster.
  const edgeClusters = useMemo(() => {
    const shapes = staging.shapes.filter((s) => !s.excluded);
    if (!shapes.length) return { baseline: [], cap: [] };
    const hs = shapes.map((s) => s.bbox[3] - s.bbox[1]).sort((a, b) => a - b);
    const H = hs[Math.floor(hs.length / 2)] || 1;          // tinggi glyph median
    const tol = Math.max(1, H * 0.005);                    // 0.5% < overshoot → tetap terpisah
    return {
      baseline: clusterEdges(shapes.map((s) => s.bbox[3]), tol), // tepi BAWAH (y membesar ke bawah)
      cap: clusterEdges(shapes.map((s) => s.bbox[1]), tol),      // tepi ATAS
    };
  }, [staging.shapes]);
  const clustersRef = useRef(edgeClusters); clustersRef.current = edgeClusters;
  const selRef = useRef(sel); selRef.current = sel;
  const onMoveRef = useRef(onMoveShapes); onMoveRef.current = onMoveShapes;
  const viewRef = useRef(view); viewRef.current = view;
  const setView2 = (v: { fx: number; fy: number; zoom: number }) => { viewRef.current = v; setView(v); };
  const frameRef = useRef({ fx0: 0, fy0: 0, fw: 1, fh: 1 }); // frame konten penuh (utk wheel/zoom)
  // satuan geser via panah (proporsional konten)
  const nudge = Math.max(1, Math.round((vh) * 0.004));

  useEffect(() => setGuides(staging.guides), [staging.guides]);

  const clampZ = (z: number) => Math.min(MAX_Z, Math.max(MIN_Z, z));

  // zoom ke kursor (berbasis viewBox; aspek viewBox = aspek elemen → tanpa distorsi, tanpa pecah)
  function zoomAtCursor(factor: number, clientX: number, clientY: number) {
    const svg = svgRef.current; if (!svg) return;
    const r = svg.getBoundingClientRect();
    const { fx0, fy0, fw, fh } = frameRef.current; const v = viewRef.current;
    const aspect = r.width / r.height;
    const efx = (clientX - r.left) / r.width, efy = (clientY - r.top) / r.height;
    const fitW = Math.max(fw, fh * aspect);
    const vbW = fitW / v.zoom, vbH = vbW / aspect;
    const vbX = (fx0 + v.fx * fw) - vbW / 2, vbY = (fy0 + v.fy * fh) - vbH / 2;
    const Px = vbX + efx * vbW, Py = vbY + efy * vbH;        // titik konten di bawah kursor
    const nz = clampZ(v.zoom * factor);
    const vbW2 = fitW / nz, vbH2 = vbW2 / aspect;
    const ccx2 = (Px - efx * vbW2) + vbW2 / 2, ccy2 = (Py - efy * vbH2) + vbH2 / 2;
    setView2({ fx: (ccx2 - fx0) / fw, fy: (ccy2 - fy0) / fh, zoom: nz });
  }
  function panBy(dxPx: number, dyPx: number) {
    const svg = svgRef.current; if (!svg) return;
    const r = svg.getBoundingClientRect();
    const { fw, fh } = frameRef.current; const v = viewRef.current;
    const aspect = r.width / r.height;
    const vbW = Math.max(fw, fh * aspect) / v.zoom;
    const up = vbW / r.width;
    setView2({ fx: v.fx + (dxPx * up) / fw, fy: v.fy + (dyPx * up) / fh, zoom: v.zoom });
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
      const ro = new ResizeObserver(() => { const b = el.getBoundingClientRect(); if (b.width && b.height) setElem({ w: b.width, h: b.height }); });
      ro.observe(el);
      const b0 = el.getBoundingClientRect(); if (b0.width && b0.height) setElem({ w: b0.width, h: b0.height });
      cleanupCanvas.current = () => { el.removeEventListener("wheel", wheel); ro.disconnect(); };
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function zoomBtn(factor: number) { const r = svgRef.current!.getBoundingClientRect(); zoomAtCursor(factor, r.left + r.width / 2, r.top + r.height / 2); }
  function reset() { setView2({ fx: 0.5, fy: 0.5, zoom: 1 }); }

  // ---- keyboard: Delete hapus garis terpilih · panah geser glyph terpilih (Shift=5×) ----
  useEffect(() => {
    const ARROWS: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1], // SVG y ke-bawah
    };
    function onKey(e: KeyboardEvent) {
      // sedang mengetik di kolom input/textarea → jangan bajak (Backspace ≠ hapus garis, panah ≠ geser glyph)
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (selGRef.current.size && (e.key === "Delete" || e.key === "Backspace")) {
        const next = guidesRef.current.filter((g) => !selGRef.current.has(g.id));
        applyGuides(next); setSelG(new Set());
        emitGuides(next);
        return;
      }
      if (selRef.current.size && ARROWS[e.key]) {
        e.preventDefault();
        const n = nudge * (e.shiftKey ? 5 : 1);
        const [ux, uy] = ARROWS[e.key];
        onMoveRef.current([...selRef.current], ux * n, uy * n);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function applyGuides(next: StagedGuide[]) { guidesRef.current = next; setGuides(next); }
  const emitGuides = (list: StagedGuide[]) => onGuides(list.map((g) => ({ y: g.y, type: g.type, linked: g.linked })));
  // putus/sambung hubungan satu garis dari grup se-tipe
  function toggleLink(id: number) {
    const next = guidesRef.current.map((g) => g.id === id ? { ...g, linked: g.linked === false } : g);
    applyGuides(next); emitGuides(next);
  }
  // titik SVG → koordinat layar relatif kontainer (utk menaruh tombol melayang)
  function svgToScreen(X: number, Y: number) {
    const svg = svgRef.current, cont = contRef.current;
    const m = svg?.getScreenCTM(); if (!svg || !cont || !m) return null;
    const p = new DOMPoint(X, Y).matrixTransform(m);
    const r = cont.getBoundingClientRect();
    return { x: p.x - r.left, y: p.y - r.top };
  }
  const upp = () => { const m = svgRef.current?.getScreenCTM(); return m ? 1 / m.d : 1; };

  // Klaster tepi terbaik utk garis yang sedang diseret. URUTAN PRIORITAS: jumlah anggota (paling
  // ramai = alas/puncak RATA), BARU jarak. Sengaja BUKAN "yang terdekat" — kalau memilih terdekat,
  // baseline akan menempel ke overshoot huruf bulat yang kebetulan lebih dekat. Null = tak menempel.
  function snapGuideY(type: string, y: number): { y: number; count: number } | null {
    const cl = type === "cap" ? clustersRef.current.cap : clustersRef.current.baseline;
    const thr = SNAP_PX * upp();
    const near = cl.filter((c) => Math.abs(c.y - y) <= thr && c.count > 0);
    if (!near.length) return null;
    near.sort((a, b) => (b.count - a.count) || (Math.abs(a.y - y) - Math.abs(b.y - y)));
    return near[0];
  }

  // client px → koordinat SVG (memperhitungkan transform + viewBox)
  function toSvg(cx: number, cy: number) {
    const m = svgRef.current!.getScreenCTM()!.inverse();
    const p = new DOMPoint(cx, cy).matrixTransform(m);
    return { x: p.x, y: p.y };
  }
  function idsInRect(sx: number, sy: number, cx: number, cy: number): number[] {
    const a = toSvg(sx, sy), b = toSvg(cx, cy);
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    return staging.shapes
      .filter((s) => !(s.bbox[2] < x0 || s.bbox[0] > x1 || s.bbox[3] < y0 || s.bbox[1] > y1))
      .map((s) => s.id);
  }

  // ---------- garis (baseline/cap) ----------
  // Pasangan satu BARIS = cap + baseline terdekat DI BAWAHNYA (Y-down). Sengaja ditentukan dari
  // POSISI, bukan urutan array: itu persis cara commit memasangkannya (project.py — "baseline
  // terdekat ke dasar glyph, cap terdekat di atasnya"), jadi yang terlihat di kanvas dijamin sama
  // dgn yang dipakai saat impor — dan tetap benar setelah garis ditambah/dihapus/disalin.
  function pairIds(all: StagedGuide[], g: StagedGuide): number[] {
    const caps = all.filter((x) => x.type === "cap");
    const bases = all.filter((x) => x.type !== "cap");
    const near = (list: StagedGuide[], y: number) =>
      list.reduce((a, c) => (Math.abs(c.y - y) < Math.abs(a.y - y) ? c : a));
    if (g.type === "cap") {
      if (!bases.length) return [g.id];
      const below = bases.filter((b) => b.y >= g.y);
      return [g.id, near(below.length ? below : bases, g.y).id];
    }
    if (!caps.length) return [g.id];
    const above = caps.filter((c) => c.y <= g.y);
    return [near(above.length ? above : caps, g.y).id, g.id];
  }

  function onGuideDown(g: StagedGuide, e: React.PointerEvent) {
    e.stopPropagation();
    dragKind.current = "guide";
    try { contRef.current?.setPointerCapture(e.pointerId); } catch { /* sintetis */ }
    if (e.shiftKey) {
      const ns = new Set(selGRef.current); ns.has(g.id) ? ns.delete(g.id) : ns.add(g.id);
      setSelG(ns); selGRef.current = ns; guideDrag.current = null; return;
    }
    // SET yang digerakkan (prioritas):
    //  - pilihan EKSPLISIT >1 garis (Shift-multiselect) → pilihan itu
    //    (klik tunggal hanya menyorot utk tombol putus; TIDAK memutus grup gerak)
    //  - garis ber-tanda LEPAS (linked=false) → garis itu saja (pengecualian per-garis,
    //    menang atas mode toolbar supaya penandaan manual tak diam-diam diabaikan)
    //  - selain itu ikut MODE toolbar: se-warna / pasangan (satu baris) / lepas
    let ids = (selGRef.current.size > 1 && selGRef.current.has(g.id))
      ? [...selGRef.current]
      : (g.linked === false || guideMode === "single" ? [g.id]
        : guideMode === "pair" ? pairIds(guidesRef.current, g)
        : guidesRef.current.filter((x) => x.type === g.type && x.linked !== false).map((x) => x.id));
    if (e.altKey) {
      let nid = Math.max(0, ...guidesRef.current.map((x) => x.id)) + 1;
      const copies = ids.map((id) => { const s = guidesRef.current.find((x) => x.id === id)!; return { id: nid++, y: s.y, type: s.type, linked: s.linked }; });
      applyGuides([...guidesRef.current, ...copies]);
      ids = copies.map((c) => c.id);
    }
    const ns = new Set(ids); setSelG(ns); selGRef.current = ns; // sorot yang digerakkan
    const startYs: Record<number, number> = {};
    for (const id of ids) startYs[id] = guidesRef.current.find((x) => x.id === id)!.y;
    // commit hanya bila benar-benar berubah (geser) / salinan (alt). clickedId utk pilih-1 saat klik
    guideDrag.current = { ids, startYs, cy: e.clientY, moved: false, commit: e.altKey, clickedId: g.id };
  }

  // ---------- pointer di kanvas (marquee glyph / klik kosong) ----------
  function onCanvasDown(e: React.PointerEvent) {
    if (dragKind.current) return; // garis sedang aktif
    try { contRef.current?.setPointerCapture(e.pointerId); } catch { /* sintetis */ }
    const hitEl = (e.target as Element).closest?.("[data-shape-id]") as HTMLElement | null;
    const hitId = hitEl ? Number(hitEl.dataset.shapeId) : null;
    // seret glyph yang SUDAH terpilih → PINDAH seleksi; selain itu → marquee (pilih area)
    if (hitId != null && sel.has(hitId) && !e.shiftKey) {
      dragKind.current = "moveShapes";
      moveDrag.current = { sx: e.clientX, sy: e.clientY, ids: [...sel], moved: false };
      return;
    }
    dragKind.current = "marquee";
    mq.current = { sx: e.clientX, sy: e.clientY, hit: hitId, shift: e.shiftKey, base: new Set(sel), moved: false };
  }

  function onMove(e: React.PointerEvent) {
    if (dragKind.current === "guide") {
      const d = guideDrag.current; if (!d) return;
      let dy = (e.clientY - d.cy) * upp();
      if (Math.abs(dy) > 0.5) d.moved = true;
      // MAGNET: hitung tempelan utk garis yang BENAR-BENAR diseret (clickedId), lalu terapkan
      // delta yang SAMA ke seluruh garis segrup → jarak antar-garis se-tipe tetap utuh.
      // Tahan ⌘/Ctrl = matikan magnet sementara (Alt sudah dipakai utk salin, Shift utk multi-pilih).
      let hit: { y: number; count: number } | null = null;
      const g0 = guidesRef.current.find((x) => x.id === d.clickedId);
      if (snapOnRef.current && !(e.metaKey || e.ctrlKey) && g0) {
        const yCur = d.startYs[d.clickedId] + dy;
        hit = snapGuideY(g0.type, yCur);
        if (hit) dy += hit.y - yCur; // dorong delta agar garis mendarat TEPAT di klaster
      }
      setSnapHit(hit && g0 ? { y: hit.y, count: hit.count, type: g0.type } : null);
      applyGuides(guidesRef.current.map((g) => d.ids.includes(g.id) ? { ...g, y: Math.round(d.startYs[g.id] + dy) } : g));
      return;
    }
    if (dragKind.current === "moveShapes") {
      const m = moveDrag.current; if (!m) return;
      if (!m.moved && Math.hypot(e.clientX - m.sx, e.clientY - m.sy) < 3) return;
      m.moved = true;
      const a = toSvg(m.sx, m.sy), b = toSvg(e.clientX, e.clientY);
      let dx = b.x - a.x, dy = b.y - a.y;
      if (e.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; } // kunci ke sumbu (H/V)
      setMoveOff({ dx, dy, ids: new Set(m.ids) }); // pratinjau live (transform)
      return;
    }
    if (dragKind.current === "marquee") {
      const m = mq.current; if (!m) return;
      if (!m.moved && Math.hypot(e.clientX - m.sx, e.clientY - m.sy) < 4) return;
      m.moved = true;
      const ids = idsInRect(m.sx, m.sy, e.clientX, e.clientY);
      const next = m.shift ? new Set<number>([...m.base, ...ids]) : new Set<number>(ids);
      setSel(next);
      setMarquee({ sx: m.sx, sy: m.sy, cx: e.clientX, cy: e.clientY, n: next.size });
    }
  }

  function onUp() {
    if (dragKind.current === "guide") {
      dragKind.current = null;
      setSnapHit(null);                       // indikator magnet hilang saat seret selesai
      const d = guideDrag.current; guideDrag.current = null;
      if (!d) return;
      if (d.moved || d.commit) emitGuides(guidesRef.current);
      else { const ns = new Set([d.clickedId]); setSelG(ns); selGRef.current = ns; } // klik tanpa geser → pilih 1 garis (tampilkan opsi putus)
      return;
    }
    if (dragKind.current === "moveShapes") {
      const m = moveDrag.current; dragKind.current = null; moveDrag.current = null;
      const off = moveOffRef.current; setMoveOff(null);
      if (m && m.moved && off && (off.dx || off.dy)) onMoveShapes(m.ids, off.dx, off.dy); // commit ke backend
      return;
    }
    if (dragKind.current === "marquee") {
      const m = mq.current; dragKind.current = null; mq.current = null; setMarquee(null);
      if (!m) return;
      if (!m.moved) {
        // klik (bukan seret)
        if (m.hit != null) {
          if (m.shift) setSel((s) => { const n = new Set(s); n.has(m.hit) ? n.delete(m.hit) : n.add(m.hit); return n; });
          else setSel(new Set([m.hit]));
        } else {
          setSel(new Set()); setSelG(new Set()); // klik kosong → batal semua
        }
      }
    }
  }

  const padY = vh * 0.06;
  // frame konten penuh → jendela viewBox (aspek = elemen, tanpa distorsi). SVG ukuran tetap → raster konstan & tajam.
  const fx0 = vx, fy0 = vy - padY, fw = vw, fh = vh + 2 * padY;
  frameRef.current = { fx0, fy0, fw, fh };
  const aspect = elem.w / elem.h;
  const fitW = Math.max(fw, fh * aspect);
  const vbW = fitW / zoom, vbH = vbW / aspect;
  const vbX = (fx0 + view.fx * fw) - vbW / 2, vbY = (fy0 + view.fy * fh) - vbH / 2;
  const u = vbW / (elem.w || 1);              // satuan konten / piksel layar → garis & teks tetap konsisten tiap zoom
  const stroke = 1.3 * u, labelSize = 12 * u;
  const cr = contRef.current?.getBoundingClientRect();
  // garis tunggal terpilih → tombol Putus/Sambung melayang di dekatnya
  const linkSel = selG.size === 1 ? guides.find((g) => selG.has(g.id)) : null;
  const linkPos = linkSel ? svgToScreen(vbX + vbW / 2, linkSel.y) : null;

  return (
    <div ref={contRef} className="flex-1 relative overflow-hidden"
      style={{ background: "var(--canvas)", touchAction: "none" }}
      onPointerDown={onCanvasDown} onPointerMove={onMove} onPointerUp={onUp}>
      <svg ref={svgCb} viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`} preserveAspectRatio="none"
        style={{ width: "100%", height: "100%", display: "block", background: "var(--bg-2)" }}>
        {staging.shapes.map((s) => {
          const on = sel.has(s.id);
          const off = moveOff && moveOff.ids.has(s.id) ? `translate(${moveOff.dx} ${moveOff.dy})` : undefined;
          return (
            <g key={s.id} data-shape-id={s.id} transform={off} style={{ cursor: on ? "move" : "pointer" }}>
              <path d={s.d} fill={on ? "var(--accent)" : "var(--glyph)"} fillRule="nonzero" opacity={s.excluded ? 0.18 : 1} />
              <rect x={s.bbox[0]} y={s.bbox[1]} width={Math.max(1, s.bbox[2] - s.bbox[0])}
                height={Math.max(1, s.bbox[3] - s.bbox[1])} fill="transparent" />
            </g>
          );
        })}
        {guides.map((g) => {
          const color = g.type === "cap" ? "#5b9cff" : "#ff5b6e";
          const seld = selG.has(g.id);
          return (
            <g key={g.id} style={{ cursor: "ns-resize" }} onPointerDown={(e) => onGuideDown(g, e)}>
              <line x1={vbX} y1={g.y} x2={vbX + vbW} y2={g.y} stroke={color}
                strokeWidth={seld ? stroke * 2.2 : stroke} opacity={seld ? 1 : 0.75}
                strokeDasharray={seld ? `${stroke * 5} ${stroke * 3}` : undefined} />
              <rect x={vbX} y={g.y - 7 * u} width={vbW} height={14 * u} fill="transparent" />
              <text x={vbX + 8 * u} y={g.y - 5 * u} fill={color} fontSize={labelSize}>
                {g.type === "cap" ? "cap" : "base"}{g.linked === false ? " ⊘ lepas" : ""}
              </text>
            </g>
          );
        })}
        {/* Indikator magnet: garis hijau tepat di klaster tepi dominan + JUMLAH glyph yang sejajar
            di situ → Anda melihat DASAR penempelannya, bukan sekadar "tiba-tiba nempel". */}
        {snapHit && (
          <g pointerEvents="none">
            <line x1={vbX} y1={snapHit.y} x2={vbX + vbW} y2={snapHit.y}
              stroke="#3ddc84" strokeWidth={stroke * 2.4} opacity={0.95} />
            <text x={vbX + 8 * u} y={snapHit.y + 16 * u} fill="#3ddc84" fontSize={labelSize} fontWeight="600">
              {snapHit.count} glyph sejajar · {snapHit.type === "cap" ? "puncak rata" : "alas rata"}
            </text>
          </g>
        )}
      </svg>

      {/* kotak marquee + badge jumlah (koordinat layar) */}
      {marquee && cr && (
        <>
          <div className="absolute pointer-events-none rounded-sm" style={{
            left: Math.min(marquee.sx, marquee.cx) - cr.left, top: Math.min(marquee.sy, marquee.cy) - cr.top,
            width: Math.abs(marquee.cx - marquee.sx), height: Math.abs(marquee.cy - marquee.sy),
            border: "1px solid var(--accent)", background: "color-mix(in srgb, var(--accent) 16%, transparent)",
          }} />
          <div className="absolute pointer-events-none text-xs px-1.5 py-0.5 rounded shadow"
            style={{ left: marquee.cx - cr.left + 10, top: marquee.cy - cr.top + 10, background: "var(--accent)", color: "#fff" }}>
            {marquee.n} objek
          </div>
        </>
      )}

      {/* tombol Putus/Sambung untuk garis tunggal terpilih */}
      {linkSel && linkPos && (
        <button
          className="absolute z-10 text-xs px-2 py-1 rounded-md shadow-lg flex items-center gap-1 whitespace-nowrap"
          style={{ left: linkPos.x, top: linkPos.y - 34, transform: "translateX(-50%)",
            background: "var(--panel)", border: "1px solid var(--border)", color: "var(--glyph)" }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => toggleLink(linkSel.id)}
          title={linkSel.linked === false ? "Hubungkan kembali ke grup se-tipe" : "Putuskan dari grup se-tipe (gerak sendiri)"}>
          <span style={{ color: linkSel.type === "cap" ? "#5b9cff" : "#ff5b6e" }}>{linkSel.linked === false ? "⛓" : "⛓✕"}</span>
          {linkSel.linked === false ? "Sambungkan" : "Putuskan hubungan"}
        </button>
      )}

      <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg p-1"
        style={{ background: "var(--panel)", border: "1px solid var(--border)" }}>
        <button className="btn !p-1.5" onClick={() => zoomBtn(0.8)} title="Zoom out"><MagnifyingGlassMinus className="size-4" /></button>
        <span className="text-xs text-muted tabular-nums w-12 text-center">{Math.round(zoom * 100)}%</span>
        <button className="btn !p-1.5" onClick={() => zoomBtn(1.25)} title="Zoom in"><MagnifyingGlassPlus className="size-4" /></button>
        <button className="btn !p-1.5" onClick={reset} title="Reset (100%)"><CornersOut className="size-4" /></button>
      </div>
    </div>
  );
}
