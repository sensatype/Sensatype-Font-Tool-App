import { createContext, useContext, useEffect, useState } from "react";
import { X, RotateCcw, Keyboard } from "lucide-react";
import {
  COMMANDS, bindingOf, isOverridden, setBinding, resetBinding, resetAll,
  comboFromEvent, isValidCombo, formatCombo, conflictFor, useKeymapVersion, type Command,
} from "../keymap";

// Konteks: buka dialog Pengaturan dari mana saja (tombol gigi TopBar/Beranda). Provider juga
// memasang pintasan global ⌘/Ctrl+, → buka Pengaturan (seperti app native).
const Ctx = createContext<{ open: () => void }>({ open: () => {} });
export const useSettings = () => useContext(Ctx);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") { e.preventDefault(); setOpen(true); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <Ctx.Provider value={{ open: () => setOpen(true) }}>
      {children}
      {open && <SettingsDialog onClose={() => setOpen(false)} />}
    </Ctx.Provider>
  );
}

type Pending = { combo: string; conflict: Command } | { error: string } | null;

function SettingsDialog({ onClose }: { onClose: () => void }) {
  useKeymapVersion(); // render ulang saat binding berubah
  const [tab] = useState<"shortcuts">("shortcuts");
  const [capId, setCapId] = useState<string | null>(null); // command yang sedang di-rebind
  const [pending, setPending] = useState<Pending>(null);

  // Esc menutup dialog (saat TIDAK sedang menangkap tombol).
  useEffect(() => {
    if (capId) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [capId, onClose]);

  // Mode tangkap: baca kombinasi berikutnya (capture-phase → cegah handler editor/dialog lain).
  useEffect(() => {
    if (!capId) return;
    const id = capId; // narrowed → string
    function onKey(e: KeyboardEvent) {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setCapId(null); setPending(null); return; }
      if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return; // tunggu tombol utama
      const combo = comboFromEvent(e);
      if (!isValidCombo(combo)) { setPending({ error: "Perlu ⌘/Ctrl atau tombol khusus (mis. Delete)." }); return; }
      const conflict = conflictFor(combo, id);
      if (conflict) { setPending({ combo, conflict }); return; } // tunggu konfirmasi "Timpa"
      setBinding(id, combo); setCapId(null); setPending(null);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capId]);

  function overwrite(id: string, combo: string, conflict: Command) {
    setBinding(id, combo);        // binding baru utk yg sedang diubah
    setBinding(conflict.id, "");  // kosongkan yg lama (bisa di-rebind nanti)
    setCapId(null); setPending(null);
  }

  const cats = [...new Set(COMMANDS.map((c) => c.category))];

  return (
    // Tanpa peredup latar (sesuai preferensi): overlay transparan penangkap-klik + panel bershadow.
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" onMouseDown={onClose}>
      <div className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-2xl shadow-2xl overflow-hidden"
        style={{ background: "var(--panel)", border: "1px solid var(--border)" }}
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 py-3.5 border-b" style={{ borderColor: "var(--border)" }}>
          <span className="font-semibold">Pengaturan</span>
          <button className="btn !p-1.5 ml-auto" onClick={onClose} title="Tutup (Esc)"><X className="size-4" /></button>
        </div>
        <div className="flex min-h-0 flex-1">
          {/* rel tab kiri — satu tab kini; disiapkan utk kategori lain nanti */}
          <div className="w-40 shrink-0 p-2 border-r" style={{ borderColor: "var(--border)", background: "var(--bg-2)" }}>
            <button className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium"
              style={{ background: tab === "shortcuts" ? "var(--accent)" : "transparent", color: tab === "shortcuts" ? "#fff" : "var(--muted)" }}>
              <Keyboard className="size-4" /> Pintasan
            </button>
          </div>

          <div className="flex-1 min-w-0 overflow-auto p-4">
            <p className="text-muted text-xs mb-3">
              Klik <b>Ubah</b> lalu tekan kombinasi baru. <b>Mod</b> = ⌘ (macOS) / Ctrl (Windows) — satu
              pintasan berlaku di kedua OS. Panah untuk menggeser & Shift/Alt saat menyeret tak bisa diubah.
            </p>
            {cats.map((cat) => (
              <div key={cat} className="mb-4">
                <div className="label mb-1.5">{cat}</div>
                <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
                  {COMMANDS.filter((c) => c.category === cat).map((c, i) => {
                    const capturing = capId === c.id;
                    const binding = bindingOf(c.id);
                    return (
                      <div key={c.id} className="flex items-center gap-3 px-3 py-2"
                        style={{ borderTop: i ? "1px solid var(--border)" : undefined, background: capturing ? "var(--bg-2)" : undefined }}>
                        <span className="text-sm flex-1 min-w-0 truncate">{c.label}</span>
                        {isOverridden(c.id) && !capturing && (
                          <button className="btn !p-1" title="Kembalikan ke default" onClick={() => resetBinding(c.id)}>
                            <RotateCcw className="size-3.5" />
                          </button>
                        )}
                        {capturing ? (
                          <span className="text-xs px-2.5 py-1 rounded-md font-mono tabular-nums"
                            style={{ background: "var(--accent)", color: "#fff", minWidth: 96, textAlign: "center" }}>
                            Tekan…
                          </span>
                        ) : (
                          <button className="btn !py-1 !px-2.5 font-mono tabular-nums" style={{ minWidth: 96 }}
                            onClick={() => { setPending(null); setCapId(c.id); }} title="Ubah pintasan">
                            {formatCombo(binding)}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {/* status tangkap: error / konfirmasi bentrok */}
            {pending && "error" in pending && (
              <div className="text-xs px-3 py-2 rounded-lg" style={{ background: "color-mix(in srgb, var(--bad) 15%, transparent)", color: "var(--bad)" }}>
                {pending.error} <span className="text-muted">— coba lagi atau Esc untuk batal.</span>
              </div>
            )}
            {pending && "conflict" in pending && capId && (
              <div className="text-xs px-3 py-2.5 rounded-lg flex items-center gap-2 flex-wrap"
                style={{ background: "color-mix(in srgb, var(--warn) 15%, transparent)", color: "var(--warn)" }}>
                <span><b>{formatCombo(pending.combo)}</b> sudah dipakai <b>{pending.conflict.label}</b>.</span>
                <div className="ml-auto flex gap-1.5">
                  <button className="btn !py-1 !px-2.5" onClick={() => { setCapId(null); setPending(null); }}>Batal</button>
                  <button className="btn btn-accent !py-1 !px-2.5" onClick={() => overwrite(capId, pending.combo, pending.conflict)}>
                    Timpa (kosongkan {pending.conflict.label})
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center px-5 py-3 border-t" style={{ borderColor: "var(--border)" }}>
          <button className="btn" onClick={resetAll} title="Kembalikan semua pintasan ke default">
            <RotateCcw className="size-4" /> Reset semua ke default
          </button>
          <button className="btn btn-accent ml-auto" onClick={onClose}>Selesai</button>
        </div>
      </div>
    </div>
  );
}
