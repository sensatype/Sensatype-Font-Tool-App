import { useEffect, useState } from "react";
import { FolderOpen, Plus, Trash2, Loader2, Type, LogOut } from "lucide-react";
import { api, type ProjectSummary } from "../api";
import { useAuth } from "./AuthGate";

function rel(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "baru saja";
  const m = Math.floor(s / 60); if (m < 60) return `${m} mnt lalu`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} jam lalu`;
  const d = Math.floor(h / 24); if (d < 30) return `${d} hari lalu`;
  return new Date(ts).toLocaleDateString();
}

// Beranda setelah login: koleksi project yang telah dikerjakan (fitur #1). Klik kartu → buka editor.
export function ProjectsHub({ onOpen, onCreate, canDelete }: {
  onOpen: (id: string) => void;
  onCreate: () => void;
  canDelete: boolean;
}) {
  const { role, logout } = useAuth();
  const [items, setItems] = useState<ProjectSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    api.projects().then((r) => setItems(r.projects)).catch((e) => setErr(String(e?.message || e)));
  }, []);

  const del = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Hapus project "${id}"? Tindakan ini permanen.`)) return;
    setBusyId(id);
    try {
      setItems((await api.deleteProject(id)).projects);
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
          <div className="ml-auto flex items-center gap-2">
            <button className="btn btn-accent" onClick={onCreate}>
              <Plus className="size-4" /> Project baru
            </button>
            {/* Akun bisa diakses di luar project juga → ganti akun dari mana saja. */}
            <div className="h-5 w-px" style={{ background: "var(--border-2)" }} />
            <span className="text-xs text-muted capitalize" title="Akun Sensatype yang sedang masuk">{role ?? "—"}</span>
            <button className="btn" onClick={() => logout()} title="Keluar / ganti akun">
              <LogOut className="size-4" /> Ganti akun
            </button>
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
                    <button
                      title="Hapus project"
                      onClick={(e) => del(p.id, e)}
                      disabled={busyId === p.id}
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-faint hover:text-red-500 p-1 -m-1"
                    >
                      {busyId === p.id ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                    </button>
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
    </div>
  );
}
