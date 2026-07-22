import { useEffect, useRef, useState } from "react";
import { FolderOpen, Plus, Trash, CircleNotch, Pencil, Gear } from "@phosphor-icons/react";
import { api, type ProjectSummary } from "../api";
import { AccountChip } from "./AccountChip";
import { useSettings } from "./Settings";
import logo from "../assets/logo.svg";

function rel(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "baru saja";
  const m = Math.floor(s / 60); if (m < 60) return `${m} mnt lalu`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} jam lalu`;
  const d = Math.floor(h / 24); if (d < 30) return `${d} hari lalu`;
  return new Date(ts).toLocaleDateString();
}

// Muat webfont pratinjau SATU project sbg @font-face ber-nama unik → kartunya tampil dalam huruf
// project itu sendiri (ini alat desain font; kartu generik membuang informasi paling berguna).
// Project yang belum pernah dikompilasi tak punya preview.woff2 → 404 itu NORMAL, bukan error:
// kartu jatuh ke huruf UI. Family dilepas saat unmount agar tak menumpuk di document.fonts.
function useProjectFont(id: string, version: number): string | null {
  const [family, setFamily] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let added: FontFace | null = null;
    const fam = `SensaProj-${id}-${version}`;
    new FontFace(fam, `url(${api.projectPreviewUrl(id, version)})`)
      .load()
      .then((f) => {
        if (!alive) return;
        document.fonts.add(f);
        added = f;
        setFamily(fam);
      })
      .catch(() => { /* belum ada preview → biarkan fallback huruf UI */ });
    return () => {
      alive = false;
      if (added) document.fonts.delete(added);
    };
  }, [id, version]);
  return family;
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

// Kartu project: SPESIMEN huruf project sbg elemen utama, metadata di bawahnya.
function ProjectCard({ p, canDelete, busy, onOpen, onRename, onDelete }: {
  p: ProjectSummary; canDelete: boolean; busy: boolean;
  onOpen: () => void; onRename: () => void; onDelete: () => void;
}) {
  const fam = useProjectFont(p.id, p.updatedAt);
  // Huruf project bila sudah ada preview; kalau belum, huruf UI (kartu tetap terbaca, tak "rusak").
  const specimen = fam ? { fontFamily: `"${fam}"` } : undefined;
  return (
    <div
      onClick={onOpen}
      className="group relative rounded-2xl border overflow-hidden cursor-pointer transition-all duration-150
                 hover:-translate-y-0.5"
      style={{ borderColor: "var(--border)", background: "var(--bg-2)" }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
    >
      {/* Spesimen — tinggi tetap agar grid rata walau nama/metadata beda panjang. */}
      <div className="relative grid place-items-center overflow-hidden"
           style={{ height: 132, background: "var(--panel)" }}>
        <div className="text-center leading-none select-none px-3" style={specimen}>
          <div style={{ fontSize: 46, color: "var(--glyph)", lineHeight: 1 }}>Aa</div>
          <div className="mt-2 truncate" style={{ fontSize: 12, color: "var(--faint)", letterSpacing: "0.04em" }}>
            ABCabc0123
          </div>
        </div>
        {!fam && (
          <span className="absolute bottom-2 right-2.5 text-[10px]" style={{ color: "var(--faint)" }}>
            pratinjau belum ada
          </span>
        )}
        {canDelete && (
          <div className="absolute top-2 right-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100
                          transition-opacity rounded-lg p-0.5"
               style={{ background: "color-mix(in srgb, var(--bg-2) 82%, transparent)" }}>
            <button title="Ganti nama project" disabled={busy} className="text-faint hover:text-[var(--accent)] p-1"
                    onClick={(e) => { e.stopPropagation(); onRename(); }}>
              <Pencil className="size-4" />
            </button>
            <button title="Hapus project" disabled={busy} className="text-faint hover:text-red-500 p-1"
                    onClick={(e) => { e.stopPropagation(); onDelete(); }}>
              {busy ? <CircleNotch className="size-4 animate-spin" /> : <Trash className="size-4" />}
            </button>
          </div>
        )}
      </div>
      <div className="p-3.5 border-t" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-center gap-2">
          <div className="font-medium truncate flex-1">{p.family}</div>
          {p.active && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-md shrink-0 font-medium"
                  style={{ background: "color-mix(in srgb, var(--accent) 18%, transparent)", color: "var(--accent)" }}>
              aktif
            </span>
          )}
        </div>
        <div className="text-xs text-faint truncate mt-1">
          {p.style ?? "—"} · {p.glyphCount ?? 0} glyph · {rel(p.updatedAt)}
        </div>
      </div>
    </div>
  );
}

// Beranda setelah login: koleksi project yang telah dikerjakan (fitur #1). Klik kartu → buka editor.
export function ProjectsHub({ onOpen, onCreate, canDelete }: {
  onOpen: (id: string) => void;
  onCreate: () => void;
  canDelete: boolean; // punya access_font_tool → boleh hapus & ganti nama (kini semua akun yg bisa masuk)
}) {
  const settings = useSettings();
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
      {/* bilah judul OS disembunyikan → strip atas (fixed) menjaga jendela bisa diseret; tinggi 30px
          < padding p-8, jadi tak menutupi baris header (di y≈32). Tombol lampu-lalu-lintas macOS di sini. */}
      <div className="app-drag fixed top-0 left-0 right-0 z-10" style={{ height: 30 }} />
      <div className="max-w-5xl mx-auto px-8 pt-10 pb-12">
        <div className="flex items-start gap-3 mb-8">
          <img src={logo} alt="Sensatype" draggable={false} className="size-9 rounded-xl shrink-0 mt-0.5" />
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold leading-tight">Project Anda</h1>
            <p className="text-sm text-faint mt-0.5">
              {items === null ? "Memuat…"
                : items.length === 0 ? "Belum ada project"
                : `${items.length} project · klik kartu untuk membuka editor`}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-3 shrink-0">
            <button className="btn btn-accent" onClick={onCreate}>
              <Plus className="size-4" /> Project baru
            </button>
            <button className="btn !p-1.5" onClick={settings.open} title="Pengaturan (⌘/Ctrl+,)">
              <Gear className="size-4" />
            </button>
            {/* Akun (profil + nama) bisa diakses di luar project juga → ganti akun dari mana saja. */}
            <div className="h-5 w-px" style={{ background: "var(--border-2)" }} />
            <AccountChip />
          </div>
        </div>

        {err && <p className="text-red-500 text-sm mb-4">{err}</p>}

        {items === null ? (
          <div className="grid place-items-center py-24 text-muted"><CircleNotch className="size-6 animate-spin" /></div>
        ) : items.length === 0 ? (
          // Kosong: kartu ber-garis putus sbg ajakan, bukan sekadar teks di tengah layar.
          <button onClick={onCreate}
                  className="w-full rounded-2xl grid place-items-center gap-3 py-20 transition-colors"
                  style={{ border: "1px dashed var(--border-2)", background: "var(--bg-2)" }}>
            <FolderOpen className="size-9" style={{ color: "var(--faint)" }} />
            <div className="text-center">
              <div className="font-medium">Belum ada project</div>
              <p className="text-sm text-faint mt-1">Impor specimen SVG/PDF untuk memulai font pertama Anda.</p>
            </div>
            <span className="btn btn-accent mt-1"><Plus className="size-4" /> Project baru</span>
          </button>
        ) : (
          <div className="grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
            {items.map((p) => (
              <ProjectCard
                key={p.id}
                p={p}
                canDelete={canDelete}
                busy={busyId === p.id}
                onOpen={() => onOpen(p.id)}
                onRename={() => setRenaming(p)}
                onDelete={() => setConfirmDel(p)}
              />
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
              <Trash className="size-4" /> Hapus
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
