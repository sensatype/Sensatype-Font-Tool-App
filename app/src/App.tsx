import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { loadPreviewFont } from "./font";
import type { Glyph, ProjectState } from "./types";
import { ImportWizard } from "./components/ImportWizard";
import { TopBar } from "./components/TopBar";
import { GlyphGrid } from "./components/GlyphGrid";
import { GlyphEditor } from "./components/GlyphEditor";
import { PreviewBar } from "./components/PreviewBar";
import { SidePanels } from "./components/SidePanels";
import { ProjectsHub } from "./components/ProjectsHub";
import { useAuth } from "./components/AuthGate";
import { ADMIN_ROLES } from "./auth";

export function App() {
  const { role } = useAuth();
  const [view, setView] = useState<"hub" | "editor">("hub"); // beranda koleksi project → editor
  const [project, setProject] = useState<ProjectState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [fontV, setFontV] = useState(0);
  const [editV, setEditV] = useState(0); // versi edit glyph (naik SEGERA tiap commit; utk preview kerning)
  const [axisVal, setAxisVal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // lebar panel kiri/kanan bisa diatur (seret tepi) + disimpan di localStorage
  const [leftW, setLeftW] = useState(() => Number(localStorage.getItem("ge.leftW")) || 288);
  const [rightW, setRightW] = useState(() => Number(localStorage.getItem("ge.rightW")) || 320);
  useEffect(() => { localStorage.setItem("ge.leftW", String(leftW)); }, [leftW]);
  useEffect(() => { localStorage.setItem("ge.rightW", String(rightW)); }, [rightW]);

  const bumpFont = useCallback(async (version?: number) => {
    await loadPreviewFont(version ?? Date.now());
    setFontV((v) => v + 1);
  }, []);

  // SEMUA edit (kern, node, spasi, komponen, metrik) = tulis CEPAT (recompile=false, ~0.3s) →
  // UI live dari vektor/optimistik. Recompile webfont (grid/PreviewBar) berat (~2.3s) & mengunci
  // backend (@_locked) → dijalankan SEKALI via debounce saat benar-benar diam, tak pernah beradu
  // dgn tulisan aktif (dulu tiap commit compile penuh → CPU berat + antrean commit macet).
  const recompileTimer = useRef<number | null>(null);
  const [syncing, setSyncing] = useState(false); // preview webfont sedang menyusul (indikator TopBar)
  const scheduleRecompile = useCallback(() => {
    setSyncing(true);
    if (recompileTimer.current) clearTimeout(recompileTimer.current);
    recompileTimer.current = window.setTimeout(async () => {
      recompileTimer.current = null;
      try { await api.recompilePreview(); } catch { /* abaikan */ }
      await bumpFont();
      if (recompileTimer.current == null) setSyncing(false); // tak ada jadwal baru → selesai
    }, 1600);
  }, [bumpFont]);
  const bumpKern = useCallback(() => {
    setEditV((v) => v + 1);
    scheduleRecompile();
  }, [scheduleRecompile]);

  // apply a full project state: set, reload font, reset axis to default
  const applyState = useCallback(async (st: ProjectState, keepSel = true) => {
    setProject(st);
    if (!st.empty) {
      setEditV((v) => v + 1); // respace/VF/import/open ubah SEMUA glyph → paksa editor (cache Text & kern) menyegarkan
      await bumpFont(st.version);
      setAxisVal(st.axis ? st.axis.default : null);
      if (!keepSel) setSelected(st.glyphs?.find((g) => g.unicode)?.name ?? null);
      else setSelected((sel) => sel ?? st.glyphs?.find((g) => g.unicode)?.name ?? null);
    }
  }, [bumpFont]);

  // Buka project dari beranda → aktifkan di backend, muat, masuk editor.
  const openProject = useCallback(async (id: string) => {
    setBusy(true);
    try {
      await applyState(await api.openProject(id), false);
      setView("editor");
    } finally {
      setBusy(false);
    }
  }, [applyState]);

  // Project baru → buat+aktifkan (kosong) → editor menampilkan ImportWizard untuk mengisinya.
  const createProject = useCallback(async () => {
    setBusy(true);
    try {
      const { state } = await api.createProject({ family: "Untitled", style: "Regular" });
      setSelected(null);
      await applyState(state, false);
      setView("editor");
    } finally {
      setBusy(false);
    }
  }, [applyState]);

  const patchGlyph = useCallback((g: Glyph) => {
    setProject((p) =>
      p && p.glyphs ? { ...p, glyphs: p.glyphs.map((x) => (x.name === g.name ? g : x)) } : p,
    );
  }, []);

  const varSettings = useMemo(() => {
    if (project?.variable && project.axis && axisVal != null)
      return `"${project.axis.tag}" ${axisVal}`;
    return undefined;
  }, [project?.variable, project?.axis, axisVal]);

  // tracking global (em) — optimistik + persist; tak perlu recompile (preview live via CSS/SVG)
  const onTracking = useCallback((v: number) => {
    setProject((p) => (p ? { ...p, tracking: v } : p));
    api.setTracking(v).catch(() => {});
  }, []);

  // peta karakter → nama glyph (untuk mode Text: ketik/tempel teks)
  const charToName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const g of project?.glyphs ?? []) if (g.char) m[g.char] = g.name;
    return m;
  }, [project?.glyphs]);
  // daftar nama glyph STABIL (memo) → datalist di editor tak dibangun ulang & effect tak refire tiap render
  const glyphNames = useMemo(() => project?.glyphs?.map((g) => g.name) ?? [], [project?.glyphs]);

  if (view === "hub")
    return <ProjectsHub onOpen={openProject} onCreate={createProject}
                        canDelete={!!role && ADMIN_ROLES.includes(role)} />;
  if (!project) return <div className="h-full grid place-items-center text-muted">Memuat…</div>;
  if (project.empty) return <ImportWizard onImported={(st) => applyState(st, false)} onHome={() => setView("hub")} />;

  return (
    <div className="h-full flex flex-col">
      <TopBar
        project={project}
        busy={busy}
        setBusy={setBusy}
        syncing={syncing}
        onRespace={async (preset) => {
          setBusy(true);
          try {
            await applyState(await api.respace(preset));
          } finally {
            setBusy(false);
          }
        }}
        onHome={() => setView("hub")}
      />
      <div className="flex-1 min-h-0 flex">
        <GlyphGrid
          glyphs={project.glyphs ?? []}
          selected={selected}
          onSelect={setSelected}
          fontV={fontV}
          varSettings={varSettings}
          width={leftW}
        />
        <ResizeHandle dir={1} width={leftW} setWidth={setLeftW} min={200} max={560} />
        <div className="flex-1 min-w-0 flex flex-col">
          <GlyphEditor
            key={selected ?? "none"}
            name={selected}
            glyphNames={glyphNames}
            charToName={charToName}
            fontV={editV}
            tracking={project.tracking ?? 0}
            onTracking={onTracking}
            onKern={bumpKern}
            onChanged={(g) => {
              setEditV((v) => v + 1); // bump SEGERA → preview kerning/panel re-fetch path (tak tunggu recompile)
              patchGlyph(g);
              scheduleRecompile();    // webfont (grid/PreviewBar) menyusul sekali saat diam
            }}
          />
          <PreviewBar fontV={fontV} varSettings={varSettings} tracking={project.tracking ?? 0} />
        </div>
        <ResizeHandle dir={-1} width={rightW} setWidth={setRightW} min={240} max={620} />
        <SidePanels
          project={project}
          selected={selected}
          axisVal={axisVal}
          setAxisVal={setAxisVal}
          busy={busy}
          setBusy={setBusy}
          onProject={(st) => applyState(st)}
          onMeta={(st) => setProject(st)}
          fontV={editV}
          tracking={project.tracking ?? 0}
          width={rightW}
        />
      </div>
    </div>
  );
}

// Pemisah panel yang bisa diseret (vertikal). dir=1: seret kanan → panel KIRI melebar; dir=-1: panel KANAN.
function ResizeHandle({ dir, width, setWidth, min, max }: {
  dir: 1 | -1; width: number; setWidth: (w: number) => void; min: number; max: number;
}) {
  const start = useRef<{ x: number; w: number } | null>(null);
  return (
    <div
      role="separator"
      title="Seret untuk atur lebar panel"
      onPointerDown={(e) => { e.preventDefault(); (e.currentTarget as Element).setPointerCapture(e.pointerId); start.current = { x: e.clientX, w: width }; }}
      onPointerMove={(e) => { if (!start.current) return; const w = start.current.w + dir * (e.clientX - start.current.x); setWidth(Math.max(min, Math.min(max, Math.round(w)))); }}
      onPointerUp={(e) => { start.current = null; (e.currentTarget as Element).releasePointerCapture?.(e.pointerId); }}
      onDoubleClick={() => setWidth(dir === 1 ? 288 : 320)} // dobel-klik = reset lebar default
      className="w-1 shrink-0 cursor-col-resize self-stretch relative z-10 transition-colors hover:bg-[var(--accent)]"
      style={{ background: "var(--border)", touchAction: "none" }}
    >
      {/* area klik lebih lebar dari garisnya biar mudah ditangkap */}
      <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
    </div>
  );
}
