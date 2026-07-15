import { useEffect, useRef, useState } from "react";
import { FolderOpen, Plus, Trash2, Loader2, Type, Pencil } from "lucide-react";
import { api, type ProjectSummary } from "../api";
import { AccountChip } from "./AccountChip";

function rel(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "baru saja";
  const m = Math.floor(s / 60); if (m < 60) return `${m} mnt lalu`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} jam lalu`;
  const d = Math.floor(h / 24); if (d < 30) return `${d} hari lalu`;
  return new Date(ts).toLocaleDateString();
}

// Modal ringan TANPA scrim/peredup — backdrop transparan (area di luar TIDAK berubah warna, hanya
// menangkap klik utk menutup). Pemisahan visual dari kartu: bayangan + border, bukan menggelapkan
// latar. Esc = tutup. Konten di-stop-propagate agar klik di dalam tak ikut menutup.
function Modal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" style={{ background: "transparent" }}
         onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl p-5"
           style={{ background: "var(--panel)", border: "1px solid var(--border)",
                    boxShadow: "0 12px 40px rgba(0,0,0,0.45)" }}
           onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

// Beranda setelah login: koleksi project yang telah dikerjakan (fitur #1). Klik kartu → buka editor.
export function ProjectsHub({ onOpen, onCreate, canDelete }: {
  onOpen: (id: string) => void;
  onCreate: () => void;
  canDelete: boolean; // admin/atasan → boleh hapus & ganti nama
}) {
  const [items, setItems] = useState<ProjectSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<ProjectSummary | null>(null);
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.projects().then((r) => setItems(r.projects)).catch((e) => setErr(String(e?.message || e)));
  }, []);

  useEffect(() => { if (renaming) { setRenameVal(renaming.family); setTimeout(() => renameRef.current?.select(), 0); } }, [renaming]);

  const doDelete = async () => {
    const p = confirmDel; if (!p) return;
    setConfirmDel(null); setBusyId(p.id); setErr(null);
    try {
      setItems((await api.deleteProject(p.id)).projects);
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setBusyId(null);
    }
  };

  const doRename = async () => {
    const p = renaming; const name = renameVal.trim();
    if (!p || !name || name === p.family) { setRenaming(null); return; }
    setRenaming(null); setBusyId(p.id); setErr(null);
    try {
      setItems((await api.renameProject(p.id, name)).projects);
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-5xl mx-auto p-8">
        <div className="flex items-center gap-3 mb-6">
          <h1 className="text-xl font-semibold">Project Anda</h1>
          {items && <span className="text-muted text-sm">{items.length} project</span>}
          <div className="ml-auto flex items-center gap-3">
            <button className="btn btn-accent" onClick={onCreate}>
              <Plus className="size-4" /> Project baru
            </button>
            {/* Akun (profil + nama) bisa diakses di luar project juga → ganti akun dari mana saja. */}
            <div className="h-5 w-px" style={{ background: "var(--border-2)" }} />
            <AccountChip />
          </div>
        </div>

        {err && <p className="text-red-500 text-sm mb-4">{err}</p>}

        {items === null ? (
          <div className="grid place-items-center py-24 text-muted"><Loader2 className="size-6 animate-spin" /></div>
        ) : items.length === 0 ? (
          <div className="grid place-items-center py-24 text-center gap-3">
            <FolderOpen className="size-10 text-faint" />
            <p className="text-muted">Belum ada project. Mulai dengan membuat yang baru.</p>
            <button className="btn btn-accent" onClick={onCreate}><Plus className="size-4" /> Project baru</button>
          </div>
        ) : (
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
            {items.map((p) => (
              <div
                key={p.id}
                onClick={() => onOpen(p.id)}
                className="group rounded-xl border p-4 cursor-pointer transition-colors hover:border-[var(--accent)]"
                style={{ borderColor: "var(--border)", background: "var(--bg-2)" }}
              >
                <div className="flex items-start gap-2.5">
                  <div className="size-9 rounded-lg grid place-items-center shrink-0"
                       style={{ background: "color-mix(in srgb, var(--accent) 16%, transparent)", color: "var(--accent)" }}>
                    <Type className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{p.family}</div>
                    <div className="text-muted text-xs truncate">
                      {p.style ?? "—"}{p.active ? " · aktif" : ""}
                    </div>
                  </div>
                  {canDelete && (
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        title="Ganti nama project"
                        onClick={(e) => { e.stopPropagation(); setRenaming(p); }}
                        disabled={busyId === p.id}
                        className="text-faint hover:text-[var(--accent)] p-1"
                      >
                        <Pencil className="size-4" />
                      </button>
                      <button
                        title="Hapus project"
                        onClick={(e) => { e.stopPropagation(); setConfirmDel(p); }}
                        disabled={busyId === p.id}
                        className="text-faint hover:text-red-500 p-1"
                      >
                        {busyId === p.id ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                      </button>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs text-faint mt-3">
                  <span>{p.glyphCount ?? 0} glyph</span>
                  <span>·</span>
                  <span>{rel(p.updatedAt)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Konfirmasi hapus — modal dalam-app (tanpa peredup latar). */}
      {confirmDel && (
        <Modal onClose={() => setConfirmDel(null)}>
          <div className="font-semibold mb-1">Hapus project?</div>
          <p className="text-muted text-sm mb-4">
            <span className="text-[var(--glyph)] font-medium">{confirmDel.family}</span> akan dihapus permanen.
            Tindakan ini tidak bisa dibatalkan.
          </p>
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={() => setConfirmDel(null)}>Batal</button>
            <button className="btn" style={{ background: "#dc2626", color: "#fff", borderColor: "#dc2626" }}
                    onClick={doDelete}>
              <Trash2 className="size-4" /> Hapus
            </button>
          </div>
        </Modal>
      )}

      {/* Ganti nama project. */}
      {renaming && (
        <Modal onClose={() => setRenaming(null)}>
          <div className="font-semibold mb-3">Ganti nama project</div>
          <input
            ref={renameRef}
            className="field w-full !py-2 mb-4"
            value={renameVal}
            onChange={(e) => setRenameVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") doRename(); }}
            placeholder="Nama project"
            maxLength={80}
          />
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={() => setRenaming(null)}>Batal</button>
            <button className="btn btn-accent" disabled={!renameVal.trim()} onClick={doRename}>Simpan</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
