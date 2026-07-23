import { useState } from "react";
import { DownloadSimple, ArrowsClockwise, ArrowCounterClockwise, FolderOpen, CircleNotch, Eraser, Gear } from "@phosphor-icons/react";
import { api } from "../api";
import { can } from "../auth";
import { AccountChip } from "./AccountChip";
import { useSettings } from "./Settings";
import logo from "../assets/logo.svg";
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
  onUndoRespace,
  onHome,
  onClearKern,
}: {
  project: ProjectState;
  busy: boolean;
  setBusy: (b: boolean) => void;
  syncing?: boolean;
  onRespace: (preset: string) => void;
  onUndoRespace: () => Promise<void> | void;
  onHome: () => void;
  onClearKern: () => Promise<void> | void;
}) {
  const [exporting, setExporting] = useState(false);
  const settings = useSettings();
  const [clearing, setClearing] = useState(false);

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
      className="app-drag titlebar-pad flex items-center gap-4 px-4 h-13 border-b shrink-0"
      style={{ borderColor: "var(--border)", background: "var(--bg-2)", height: 52 }}
    >
      <div className="flex items-center gap-2.5">
        <img src={logo} alt="Sensatype" draggable={false} className="size-7 rounded-lg shrink-0" />
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
            <CircleNotch className="size-3 animate-spin" /> sinkron preview…
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
        <button className="btn" disabled={busy || clearing}
          title="Nolkan SEMUA nilai kerning (kelas kern/grup bentuk tetap ada → bisa diisi ulang lewat Smart → Auto-kern semua). Berlaku permanen ke seluruh font."
          onClick={async () => { if (clearing) return; setClearing(true); try { await onClearKern(); } finally { setClearing(false); } }}>
          {clearing ? <CircleNotch className="size-4 animate-spin" /> : <Eraser className="size-4" />}
          Restart Kern
        </button>
        <button className="btn" disabled={busy} onClick={() => onRespace(project.preset ?? "display-serif")}
          title="Bangun ulang font dari SVG: spasi & seed kerning dihitung ulang dengan preset aktif. Pasangan kern yang Anda tetapkan sendiri dipertahankan; cadangan dibuat otomatis sehingga bisa dibatalkan.">
          {busy ? <CircleNotch className="size-4 animate-spin" /> : <ArrowsClockwise className="size-4" />}
          Re-seed
        </button>
        {/* Muncul HANYA selama cadangan Re-seed masih ada → jalan pulang yang terlihat, bukan
            janji di kotak dialog yang sudah keburu ditutup. */}
        {project.backup && (
          <button className="btn" disabled={busy} onClick={() => onUndoRespace()}
            style={{ color: "#e8a13a" }}
            title={`Kembalikan font ke kondisi sebelum Re-seed terakhir (${new Date(project.backup.at).toLocaleString("id-ID")}). Cadangan hanya satu langkah.`}>
            <ArrowCounterClockwise className="size-4" />
            Batalkan Re-seed
          </button>
        )}
        <button className="btn" onClick={onHome} title="Kembali ke daftar project">
          <FolderOpen className="size-4" /> Projects
        </button>
        {/* Export terbuka utk semua akun ber-access_font_tool (backend: require_access).
            Klik → dialog "Simpan sebagai" (Finder/File Explorer) untuk memilih lokasi. */}
        {can.export() && (
          <button className="btn btn-accent" onClick={handleExport} disabled={exporting}
            title="Export font — pilih lokasi penyimpanan">
            {exporting ? <CircleNotch className="size-4 animate-spin" /> : <DownloadSimple className="size-4" />} Export
          </button>
        )}
        <button className="btn !p-1.5" onClick={settings.open} title="Pengaturan (⌘/Ctrl+,)">
          <Gear className="size-4" />
        </button>
        <div className="h-5 w-px" style={{ background: "var(--border-2)" }} />
        <AccountChip />
      </div>
    </header>
  );
}
