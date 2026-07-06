import { useEffect, useRef, useState } from "react";
import { Upload, FileType2, Loader2 } from "lucide-react";
import { api } from "../api";
import type { ProjectState } from "../types";

const PRESETS = ["display-serif", "text-serif", "text-sans", "display-sans"];

export function ImportScreen({
  onImported,
  busy,
  setBusy,
}: {
  onImported: (s: ProjectState) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const [mode, setMode] = useState<"specimen" | "glyphs">("specimen");
  const [family, setFamily] = useState("Yoruna");
  const [style, setStyle] = useState("Regular");
  const [preset, setPreset] = useState("display-serif");
  const [layout, setLayout] = useState("yoruna-full");
  const [layouts, setLayouts] = useState<string[]>([]);
  const [drag, setDrag] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.layouts().then((r) => setLayouts(r.layouts)).catch(() => {});
  }, []);

  async function handleFiles(files: FileList) {
    setErr(null);
    setBusy(true);
    try {
      const form = new FormData();
      form.append("family", family);
      form.append("style", style);
      form.append("preset", preset);
      let st: ProjectState;
      if (mode === "specimen") {
        form.append("file", files[0]);
        if (layout) form.append("layout", layout);
        st = await api.importSpecimen(form);
      } else {
        Array.from(files).forEach((f) => form.append("files", f));
        st = await api.importGlyphs(form);
      }
      onImported(st);
    } catch (e: any) {
      setErr(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full overflow-auto grid place-items-center p-8">
      <div className="w-full max-w-2xl">
        <div className="flex items-center gap-3 mb-1">
          <div className="size-9 rounded-xl bg-accent grid place-items-center text-white font-bold">S</div>
          <h1 className="text-2xl font-semibold tracking-tight">Sensatype Font Tool</h1>
        </div>
        <p className="text-muted mb-7">SVG → OTF / TTF / WOFF / WOFF2 — satu pipeline, tanpa kerja dua kali.</p>

        <div className="card p-2 flex gap-1 mb-5 w-fit">
          {(["specimen", "glyphs"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className="px-4 py-2 rounded-lg font-medium transition"
              style={{
                background: mode === m ? "var(--accent)" : "transparent",
                color: mode === m ? "#fff" : "var(--muted)",
              }}
            >
              {m === "specimen" ? "Specimen grid" : "Glyph SVG (multi)"}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3 mb-5">
          <Field label="Family">
            <input className="field" value={family} onChange={(e) => setFamily(e.target.value)} />
          </Field>
          <Field label="Style">
            <input className="field" value={style} onChange={(e) => setStyle(e.target.value)} />
          </Field>
          <Field label="Preset spacing">
            <select className="field" value={preset} onChange={(e) => setPreset(e.target.value)}>
              {PRESETS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </Field>
          {mode === "specimen" && (
            <Field label="Layout specimen">
              <select className="field" value={layout} onChange={(e) => setLayout(e.target.value)}>
                <option value="">(deteksi: upper, lower)</option>
                {layouts.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </Field>
          )}
        </div>

        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
          }}
          onClick={() => !busy && fileRef.current?.click()}
          className="card grid place-items-center text-center cursor-pointer transition"
          style={{
            borderStyle: "dashed",
            borderColor: drag ? "var(--accent)" : "var(--border-2)",
            background: drag ? "color-mix(in srgb, var(--accent) 10%, var(--panel))" : "var(--panel)",
            padding: "48px 24px",
          }}
        >
          {busy ? (
            <div className="flex flex-col items-center gap-3 text-muted">
              <Loader2 className="size-8 animate-spin" />
              <span>Mengimpor & mengompilasi…</span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              {mode === "specimen" ? <FileType2 className="size-10 text-accent" /> : <Upload className="size-10 text-accent" />}
              <div className="font-medium text-base">
                {mode === "specimen" ? "Jatuhkan 1 SVG / PDF specimen di sini" : "Jatuhkan beberapa SVG glyph"}
              </div>
              <div className="text-muted text-xs">
                {mode === "specimen"
                  ? "Grid karakter (SVG atau PDF vektor) — dipecah otomatis sesuai layout"
                  : "Nama file → Unicode (A.svg, uni0041.svg, …)"}
              </div>
              <div className="btn btn-accent mt-2">Pilih file</div>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept={mode === "specimen" ? ".svg,.pdf,image/svg+xml,application/pdf" : ".svg,image/svg+xml"}
            multiple={mode === "glyphs"}
            hidden
            onChange={(e) => e.target.files && handleFiles(e.target.files)}
          />
        </div>

        {err && <div className="mt-4 text-bad text-sm whitespace-pre-wrap">{err}</div>}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}
