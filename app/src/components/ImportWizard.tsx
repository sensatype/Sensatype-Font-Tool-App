import { useEffect, useMemo, useRef, useState } from "react";
import { Upload, Loader2, Trash2, Combine, Scissors, Eye, ArrowRight, ArrowLeft, Wand2, Eraser, Undo2, Redo2, Type } from "lucide-react";
import { api } from "../api";
import { SpecimenCanvas } from "./SpecimenCanvas";
import type { ProjectState, StagedShape, StagingState } from "../types";

type Step = "upload" | "clean" | "map";

export function ImportWizard({ onImported }: { onImported: (s: ProjectState) => void }) {
  const [step, setStep] = useState<Step>("upload");
  const [staging, setStaging] = useState<StagingState | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [tokens, setTokens] = useState<Record<number, string>>({});
  const [family, setFamily] = useState("Yoruna");
  const [style, setStyle] = useState("Regular");
  const [preset, setPreset] = useState("display-serif");
  const [altStr, setAltStr] = useState("");   // alternate (pisah koma) → disisipkan di urutan auto-fill
  const [ligStr, setLigStr] = useState("");   // ligature  (pisah koma)
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState<{ pct: number; phase: string } | null>(null); // progres commit
  const [drag, setDrag] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const kept = useMemo(() => (staging?.shapes ?? []).filter((s) => !s.excluded), [staging]);

  // resume: jika ada staging tersimpan (belum di-commit), lanjut ke langkah Bersihkan
  useEffect(() => {
    api.getStaging().then((st) => {
      if (st.shapes.length) { setStaging(st); setStep("clean"); }
    }).catch(() => {});
  }, []);

  async function doStage(file: File) {
    setErr(null); setBusy(true);
    try {
      const st = await api.stageImport(file);
      setStaging(st); setSel(new Set()); setStep("clean");
    } catch (e: any) { setErr(String(e.message ?? e)); }
    finally { setBusy(false); }
  }
  async function op(o: string, ids: number[]) {
    setBusy(true);
    try { setStaging(await api.stagingOp(o, ids)); setSel(new Set()); }
    finally { setBusy(false); }
  }
  async function commitGuides(guides: { y: number; type: string; linked?: boolean }[]) {
    setStaging(await api.setGuides(guides));
  }
  async function moveShapes(ids: number[], dx: number, dy: number) {
    if (!ids.length || (!dx && !dy)) return;
    setStaging(await api.stagingMove(ids, dx, dy));
  }
  async function undo() { setSel(new Set()); setStaging(await api.stagingUndo()); }
  async function redo() { setSel(new Set()); setStaging(await api.stagingRedo()); }
  useEffect(() => {
    if (step !== "clean") return;
    function onKey(e: KeyboardEvent) {
      // sedang mengetik (mis. kolom Alt & Liga) → jangan bajak ⌘Z teks jadi undo staging
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        (e.shiftKey ? redo() : undo());
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault(); redo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // eslint-disable-line
  function addGuide(type: "baseline" | "cap") {
    if (!staging) return;
    const midY = staging.viewBox[1] + staging.viewBox[3] / 2;
    commitGuides([...staging.guides.map((g) => ({ y: g.y, type: g.type, linked: g.linked })), { y: midY, type, linked: true }]);
  }
  // "Y, A, a, a" → ["Y.ss01","A.ss01","a.ss01","a.ss02"] (nama eksplisit dgn '.' dibiarkan)
  function parseAlts(str: string): string[] {
    const c: Record<string, number> = {};
    return str.split(",").map((s) => s.trim()).filter(Boolean).map((tok) => {
      if (tok.includes(".")) return tok;
      c[tok] = (c[tok] ?? 0) + 1;
      return `${tok}.ss${String(c[tok]).padStart(2, "0")}`;
    });
  }
  // "RU, ffi, fl" → ["R_U","f_f_i","f_l"] (yg sudah ada '_' dibiarkan)
  function parseLigs(str: string): string[] {
    return str.split(",").map((s) => s.trim()).filter(Boolean).map((tok) =>
      tok.includes("_") ? tok : [...tok].join("_"));
  }
  function autoFill() {
    const auto = [...(staging?.autoTokens ?? [])];
    const altLiga = [...parseAlts(altStr), ...parseLigs(ligStr)];
    // isi slot KOSONG (tengah: setelah simbol, sebelum 58 multilingual) dgn alternate lalu ligature
    let k = 0;
    for (let i = 0; i < auto.length && k < altLiga.length; i++) {
      if (auto[i] === "") auto[i] = altLiga[k++];
    }
    const t: Record<number, string> = {};
    kept.forEach((s, i) => (t[s.id] = auto[i] ?? ""));
    setTokens(t);
  }
  function clearTokens() { setTokens({}); }

  async function commit() {
    setBusy(true); setErr(null); setProg({ pct: 0, phase: "Menyiapkan…" });
    let stop = false;
    // poll progres backend selama commit berjalan (commit & poll dilayani thread berbeda)
    (async () => {
      while (!stop) {
        try {
          const p = await api.importProgress();
          if (p.active || p.pct > 0) setProg({ pct: p.pct, phase: p.phase });
        } catch { /* abaikan error poll sesaat */ }
        await new Promise((r) => setTimeout(r, 300));
      }
    })();
    try {
      const arr = kept.map((s) => tokens[s.id] ?? "");
      const res = await api.commitImport({ tokens: arr, family, style, preset });
      stop = true; setProg({ pct: 100, phase: "Selesai" });
      onImported(res);
    } catch (e: any) {
      stop = true; setProg(null); setBusy(false); setErr(String(e.message ?? e));
    }
  }

  // ---------- UPLOAD ----------
  if (step === "upload") {
    return (
      <div className="h-full overflow-auto grid place-items-center p-8">
        <div className="w-full max-w-xl">
          <div className="flex items-center gap-3 mb-1">
            <div className="size-9 rounded-xl bg-accent grid place-items-center text-white font-bold">S</div>
            <h1 className="text-2xl font-semibold tracking-tight">Sensatype Font Tool</h1>
          </div>
          <p className="text-muted mb-6">Impor specimen SVG → urai per glyph (urutan baca) → bersihkan → petakan → font.</p>
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files[0]) doStage(e.dataTransfer.files[0]); }}
            onClick={() => !busy && fileRef.current?.click()}
            className="card grid place-items-center text-center cursor-pointer"
            style={{ borderStyle: "dashed", borderColor: drag ? "var(--accent)" : "var(--border-2)",
              background: drag ? "color-mix(in srgb, var(--accent) 10%, var(--panel))" : "var(--panel)", padding: "52px 24px" }}
          >
            {busy ? <div className="flex flex-col items-center gap-3 text-muted"><Loader2 className="size-8 animate-spin" /><span>Mengurai specimen…</span></div>
              : <div className="flex flex-col items-center gap-3"><Upload className="size-10 text-accent" />
                  <div className="font-medium text-base">Jatuhkan 1 SVG / PDF specimen</div>
                  <div className="text-muted text-xs">SVG atau PDF vektor · semua glyph ditampilkan dulu untuk dibersihkan & dipetakan</div>
                  <div className="btn btn-accent mt-2">Pilih file</div></div>}
            <input ref={fileRef} type="file" accept=".svg,.pdf,image/svg+xml,application/pdf" hidden onChange={(e) => e.target.files?.[0] && doStage(e.target.files[0])} />
          </div>
          {err && <div className="mt-4 text-bad text-sm whitespace-pre-wrap">{err}</div>}
        </div>
      </div>
    );
  }

  // ---------- CLEAN ----------
  if (step === "clean") {
    return (
      <div className="h-full flex flex-col">
        <WizardBar step={2}
          left={<>
            <AltLigMenu alt={altStr} setAlt={setAltStr} lig={ligStr} setLig={setLigStr} />
            <button className="btn" onClick={() => setStep("upload")}><ArrowLeft className="size-4" />Ulang</button>
          </>}
          right={<button className="btn btn-accent" onClick={() => { autoFill(); setStep("map"); }}>Lanjut: petakan <ArrowRight className="size-4" /></button>}
          title="Bersihkan" sub={`${kept.length} glyph akan diimpor · ${staging?.shapes.length ?? 0} objek terdeteksi`} />
        <div className="px-4 py-2 border-b flex items-center gap-2 flex-wrap" style={{ borderColor: "var(--border)", background: "var(--bg-2)" }}>
          <span className="text-xs text-muted mr-1">{sel.size} dipilih</span>
          <button className="btn !py-1.5" disabled={!sel.size} onClick={() => op("exclude", [...sel])}><Trash2 className="size-4" />Buang</button>
          <button className="btn !py-1.5" disabled={!sel.size} onClick={() => op("include", [...sel])}><Eye className="size-4" />Pulihkan</button>
          <button className="btn !py-1.5" disabled={sel.size < 2} onClick={() => op("merge", [...sel])}><Combine className="size-4" />Gabung</button>
          <button className="btn !py-1.5" disabled={!sel.size} onClick={() => op("split", [...sel])}><Scissors className="size-4" />Pisah</button>
          <div className="h-5 w-px mx-1" style={{ background: "var(--border-2)" }} />
          <button className="btn !py-1.5" onClick={() => addGuide("baseline")}><span style={{ color: "#ff5b6e" }}>―</span> Baseline</button>
          <button className="btn !py-1.5" onClick={() => addGuide("cap")}><span style={{ color: "#5b9cff" }}>―</span> Cap</button>
          <div className="h-5 w-px mx-1" style={{ background: "var(--border-2)" }} />
          <button className="btn !py-1.5" disabled={!staging?.canUndo} onClick={undo} title="Undo (⌘Z)"><Undo2 className="size-4" /></button>
          <button className="btn !py-1.5" disabled={!staging?.canRedo} onClick={redo} title="Redo (⌘⇧Z)"><Redo2 className="size-4" /></button>
          <span className="text-faint text-[11px] ml-auto"><b>Seret glyph</b>=pindah · <b>panah</b>=geser · seret kosong=pilih area · seret garis=semua se-tipe · ⌘Z undo</span>
        </div>
        {staging && (
          <SpecimenCanvas
            staging={staging}
            sel={sel}
            setSel={setSel}
            onGuides={commitGuides}
            onMoveShapes={moveShapes}
          />
        )}
        {err && <div className="px-4 py-2 text-bad text-sm">{err}</div>}
      </div>
    );
  }

  // ---------- MAP ----------
  return (
    <div className="h-full flex flex-col relative">
      <WizardBar step={3}
        left={<button className="btn" onClick={() => setStep("clean")}><ArrowLeft className="size-4" />Bersihkan</button>}
        right={<button className="btn btn-accent" disabled={busy} onClick={commit}>{busy ? <Loader2 className="size-4 animate-spin" /> : null}Import {kept.length} glyph</button>}
        title="Petakan glyph" sub="Token ke-i → glyph ke-i (urutan baca). Alt/liga tulis nama: Y.ss01, R_U, f_i" />
      <div className="px-4 py-2.5 border-b flex items-center gap-3 flex-wrap" style={{ borderColor: "var(--border)", background: "var(--bg-2)" }}>
        <button className="btn !py-1.5" onClick={autoFill}><Wand2 className="size-4" />Otomatis (A–Z a–z 0–9 …)</button>
        <button className="btn !py-1.5" onClick={clearTokens}><Eraser className="size-4" />Kosongkan (manual)</button>
        {/* Alt & Liga juga tersedia saat pemetaan → isi altStr/ligStr lalu klik "Otomatis" utk menyisipkan */}
        <AltLigMenu alt={altStr} setAlt={setAltStr} lig={ligStr} setLig={setLigStr} />
        <div className="flex items-center gap-2 ml-auto">
          <input className="field !w-32 !py-1.5" value={family} onChange={(e) => setFamily(e.target.value)} placeholder="Family" />
          <input className="field !w-24 !py-1.5" value={style} onChange={(e) => setStyle(e.target.value)} placeholder="Style" />
          <select className="field !w-auto !py-1.5" value={preset} onChange={(e) => setPreset(e.target.value)}>
            {["display-serif", "text-serif", "text-sans", "display-sans"].map((p) => <option key={p}>{p}</option>)}
          </select>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-3">
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))" }}>
          {kept.map((s, i) => (
            <div key={s.id} className="card p-1.5 flex flex-col gap-1" style={{ borderColor: tokens[s.id] ? "var(--accent)" : "var(--border)" }}>
              <div className="grid place-items-center rounded" style={{ background: "var(--canvas)", height: 56 }}>
                <Thumb d={s.d} bbox={s.bbox} size={48} />
              </div>
              <div className="flex items-center gap-1">
                <span className="text-faint text-[9px] w-4 tabular-nums">{i + 1}</span>
                <input className="field !px-1.5 !py-1 text-center text-xs" value={tokens[s.id] ?? ""}
                  onChange={(e) => setTokens((t) => ({ ...t, [s.id]: e.target.value }))} placeholder="—" />
              </div>
            </div>
          ))}
        </div>
      </div>
      {err && <div className="px-4 py-2 text-bad text-sm whitespace-pre-wrap">{err}</div>}
      {prog && <CommitOverlay pct={prog.pct} phase={prog.phase} count={kept.length} />}
    </div>
  );
}

// Overlay progres saat membangun font (commit). Persentase nyata dari backend.
function CommitOverlay({ pct, phase, count }: { pct: number; phase: string; count: number }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div className="absolute inset-0 z-50 grid place-items-center" style={{ background: "color-mix(in srgb, var(--bg) 78%, transparent)", backdropFilter: "blur(2px)" }}>
      <div className="card p-6 w-[min(420px,90vw)] flex flex-col gap-3" style={{ boxShadow: "0 12px 40px rgba(0,0,0,.35)" }}>
        <div className="flex items-center gap-2">
          <Loader2 className="size-5 animate-spin text-accent" />
          <span className="font-semibold">Membangun font…</span>
          <span className="ml-auto tabular-nums text-lg font-semibold">{p}%</span>
        </div>
        <div className="h-2.5 rounded-full overflow-hidden" style={{ background: "var(--bg-2)" }}>
          <div className="h-full rounded-full transition-[width] duration-300 ease-out"
            style={{ width: `${p}%`, background: "var(--accent)" }} />
        </div>
        <div className="flex items-center justify-between text-xs text-muted">
          <span>{phase || "Memproses…"}</span>
          <span>{count} glyph</span>
        </div>
      </div>
    </div>
  );
}

// Menu input Alternate & Ligature (langkah 2). Nilai dipakai autoFill utk mengisi slot tengah urutan.
function AltLigMenu({ alt, setAlt, lig, setLig }: { alt: string; setAlt: (s: string) => void; lig: string; setLig: (s: string) => void }) {
  const [open, setOpen] = useState(false);
  const filled = alt.trim() || lig.trim();
  return (
    <div className="relative">
      <button className="btn" onClick={() => setOpen((o) => !o)} title="Masukkan glyph Alternate & Ligature">
        <Type className="size-4" /> Alt & Liga
        {filled && <span className="size-1.5 rounded-full bg-accent" />}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1.5 z-20 w-[22rem] rounded-xl p-3 flex flex-col gap-2.5 shadow-xl"
            style={{ background: "var(--panel)", border: "1px solid var(--border)" }}>
            <div>
              <div className="label mb-1">Alternate <span className="text-faint font-normal">· pisah dengan koma</span></div>
              <textarea className="field text-xs !py-1.5 w-full" rows={2} value={alt} onChange={(e) => setAlt(e.target.value)}
                placeholder="Y, A, D, M, N, B, O, g, a, a, e, o" />
            </div>
            <div>
              <div className="label mb-1">Ligature <span className="text-faint font-normal">· pisah dengan koma</span></div>
              <textarea className="field text-xs !py-1.5 w-full" rows={2} value={lig} onChange={(e) => setLig(e.target.value)}
                placeholder="RU, RE, RO, KU, ff, fi, ffi, fl, ffl" />
            </div>
            <p className="text-faint text-[11px] leading-relaxed">
              Disisipkan otomatis di urutan: <b>setelah simbol, sebelum multilingual</b>. Nama dibentuk:
              alternate → <code>Y.ss01</code> (huruf berulang naik .ss02…), ligature → <code>R_U</code>, <code>f_f_i</code>.
              Klik <b>Lanjut: petakan</b> atau <b>Otomatis</b> untuk menerapkan.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function WizardBar({ step, title, sub, left, right }: any) {
  return (
    <header className="flex items-center gap-4 px-4 border-b shrink-0" style={{ borderColor: "var(--border)", background: "var(--bg-2)", height: 56 }}>
      <div className="flex items-center gap-2.5">
        <div className="size-7 rounded-lg bg-accent grid place-items-center text-white font-bold text-sm">S</div>
        <div className="flex flex-col leading-tight">
          <span className="font-semibold text-sm">{title} <span className="text-faint font-normal">· langkah {step}/3</span></span>
          <span className="text-faint text-[11px]">{sub}</span>
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2">{left}{right}</div>
    </header>
  );
}

function ShapeGrid({ shapes, sel, setSel, busy }: { shapes: StagedShape[]; sel: Set<number>; setSel: (s: Set<number>) => void; busy: boolean }) {
  return (
    <div className="flex-1 overflow-auto p-3" style={{ opacity: busy ? 0.6 : 1 }}>
      <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(70px, 1fr))" }}>
        {shapes.map((s, i) => {
          const on = sel.has(s.id);
          return (
            <button key={s.id} onClick={() => { const n = new Set(sel); n.has(s.id) ? n.delete(s.id) : n.add(s.id); setSel(n); }}
              className="rounded-lg p-1 flex flex-col items-center relative transition"
              style={{ background: on ? "color-mix(in srgb, var(--accent) 22%, var(--panel))" : "var(--panel)",
                border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`, opacity: s.excluded ? 0.32 : 1 }}>
              <div className="grid place-items-center w-full" style={{ height: 50 }}>
                <Thumb d={s.d} bbox={s.bbox} size={42} />
              </div>
              <span className="text-faint text-[9px] tabular-nums">{i + 1}</span>
              {s.excluded && <span className="absolute inset-0 grid place-items-center text-bad text-xl">✕</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Thumb({ d, bbox, size }: { d: string; bbox: [number, number, number, number]; size: number }) {
  const [x0, y0, x1, y1] = bbox;
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const pad = Math.max(w, h) * 0.12;
  return (
    <svg viewBox={`${x0 - pad} ${y0 - pad} ${w + pad * 2} ${h + pad * 2}`}
      style={{ width: size, height: size }} preserveAspectRatio="xMidYMid meet">
      <path d={d} fill="var(--glyph)" fillRule="nonzero" />
    </svg>
  );
}
