import { useState } from "react";
import { Download, RefreshCw, FolderOpen, Loader2, LogOut } from "lucide-react";
import { api } from "../api";
import { can } from "../auth";
import { useAuth } from "./AuthGate";
import type { ProjectState } from "../types";

// window.showSaveFilePicker (File System Access API) — ada di Chromium/Electron pada konteks aman (localhost).
type SaveWin = Window & {
  showSaveFilePicker?: (opts: {
    suggestedName?: string;
    types?: { description?: string; accept: Record<string, string[]> }[];
  }) => Promise<{ createWritable: () => Promise<{ write: (d: Blob) => Promise<void>; close: () => Promise<void> }> }>;
};

export function TopBar({
  project,
  busy,
  setBusy,
  syncing = false,
  onRespace,
  onHome,
}: {
  project: ProjectState;
  busy: boolean;
  setBusy: (b: boolean) => void;
  syncing?: boolean;
  onRespace: (preset: string) => void;
  onHome: () => void;
}) {
  const { role, logout } = useAuth();
  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    if (exporting) return;
    const w = window as SaveWin;
    const suggested = `${(project.family || "Font").replace(/\s+/g, "")}-${(project.style || "Regular").replace(/\s+/g, "")}.zip`;
    // PENTING: buka dialog "Simpan sebagai" DULU (selagi gesture klik masih aktif), baru fetch+tulis.
    let handle: Awaited<ReturnType<NonNullable<SaveWin["showSaveFilePicker"]>>> | null = null;
    if (w.showSaveFilePicker) {
      try {
        handle = await w.showSaveFilePicker({
          suggestedName: suggested,
          types: [{ description: "Arsip font (ZIP)", accept: { "application/zip": [".zip"] } }],
        });
      } catch (e) {
        if ((e as DOMException)?.name === "AbortError") return; // user batal → diam
        throw e;
      }
    }
    setExporting(true);
    try {
      const { blob, filename } = await api.exportBlob();
      if (handle) { // File System Access API → tulis ke lokasi pilihan user
        const ws = await handle.createWritable();
        await ws.write(blob);
        await ws.close();
      } else { // fallback (Safari/Firefox) → unduh biasa ke folder Unduhan
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      alert("Export gagal: " + ((e as Error).message || e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <header
      className="flex items-center gap-4 px-4 h-13 border-b shrink-0"
      style={{ borderColor: "var(--border)", background: "var(--bg-2)", height: 52 }}
    >
      <div className="flex items-center gap-2.5">
        <div className="size-7 rounded-lg bg-accent grid place-items-center text-white font-bold text-sm">S</div>
        <span className="font-semibold tracking-tight">Sensatype</span>
      </div>
      <div className="h-5 w-px" style={{ background: "var(--border-2)" }} />
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="font-medium truncate">{project.family}</span>
        <span className="text-muted text-xs">{project.style}</span>
        <span className="text-faint text-xs">· {project.glyphs?.length ?? 0} glyph</span>
        {/* preview webfont (grid/bar bawah) sedang di-compile menyusul edit — bukan macet */}
        {syncing && (
          <span className="text-faint text-[11px] flex items-center gap-1 whitespace-nowrap" title="Preview grid & bar bawah sedang diperbarui — editor tetap live">
            <Loader2 className="size-3 animate-spin" /> sinkron preview…
          </span>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-muted">
          Preset
          <select
            className="field !py-1.5 !w-auto"
            value={project.preset ?? ""}
            disabled={busy}
            onChange={(e) => onRespace(e.target.value)}
          >
            {(project.presets ?? []).map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <button className="btn" disabled={busy} onClick={() => onRespace(project.preset ?? "display-serif")}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          Re-seed
        </button>
        <button className="btn" onClick={onHome} title="Kembali ke daftar project">
          <FolderOpen className="size-4" /> Projects
        </button>
        {/* Export hanya untuk admin/atasan (gerbang role — backend juga menolak 403).
            Klik → dialog "Simpan sebagai" (Finder/File Explorer) untuk memilih lokasi. */}
        {can.export(role) && (
          <button className="btn btn-accent" onClick={handleExport} disabled={exporting}
            title="Export font — pilih lokasi penyimpanan">
            {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} Export
          </button>
        )}
        <div className="h-5 w-px" style={{ background: "var(--border-2)" }} />
        <span className="text-xs text-muted capitalize" title="Peran akun Sensatype">{role ?? "—"}</span>
        <button className="btn !px-2" onClick={() => logout()} title="Keluar">
          <LogOut className="size-4" />
        </button>
      </div>
    </header>
  );
}
