import { useEffect, useRef, useState } from "react";
import { SignOut, CaretDown } from "@phosphor-icons/react";
import { useAuth } from "./AuthGate";

// Chip akun (avatar + nama + peran) dengan dropdown "Ganti akun". Dipakai di TopBar,
// ProjectsHub, dan ImportWizard → akun konsisten & bisa diakses di mana pun.
export function AccountChip() {
  const { name, role, email, avatarUrl, userId, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // PENTING: userId dari server bisa ANGKA (mis. 1) & name bisa null → paksa ke String,
  // kalau tidak `display.trim()` melempar "x.trim is not a function" → crash render → layar kosong.
  // Tanpa nama dari server, tampilkan "Akun #1" (bukan angka telanjang yang terlihat aneh).
  const idStr = userId == null ? "" : String(userId);
  const fallback = !idStr ? "Akun" : (/^\d+$/.test(idStr) ? `Akun #${idStr}` : idStr);
  const display = name ? String(name) : fallback;
  const initial = (display.trim()[0] || "?").toUpperCase();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-1.5 py-1 rounded-lg hover:bg-[var(--bg)] transition-colors"
        title="Akun"
      >
        <Avatar url={avatarUrl} initial={initial} />
        <div className="leading-tight text-left min-w-0">
          <div className="text-xs font-medium truncate max-w-[140px]">{display}</div>
          {role && <div className="text-[10px] text-faint capitalize">{role}</div>}
        </div>
        <CaretDown className="size-3.5 text-faint shrink-0" />
      </button>

      {open && (
        <div className="absolute right-0 mt-1 w-60 rounded-xl border shadow-lg z-50 p-1"
             style={{ background: "var(--bg-2)", borderColor: "var(--border)" }}>
          <div className="flex items-center gap-2.5 px-2.5 py-2">
            <Avatar url={avatarUrl} initial={initial} big />
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{display}</div>
              {email && <div className="text-[11px] text-faint truncate">{email}</div>}
              {role && <div className="text-[11px] text-muted capitalize">{role}</div>}
            </div>
          </div>
          <div className="h-px my-1" style={{ background: "var(--border)" }} />
          <button
            onClick={() => { setOpen(false); logout(); }}
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm hover:bg-[var(--bg)] transition-colors"
          >
            <SignOut className="size-4" /> Ganti akun
          </button>
        </div>
      )}
    </div>
  );
}

function Avatar({ url, initial, big }: { url?: string | null; initial: string; big?: boolean }) {
  const cls = big ? "size-9" : "size-7";
  if (url) return <img src={url} alt="" className={`${cls} rounded-full object-cover shrink-0`} referrerPolicy="no-referrer" />;
  return (
    <div className={`${cls} rounded-full grid place-items-center text-white font-semibold shrink-0 ${big ? "text-sm" : "text-xs"}`}
         style={{ background: "var(--accent)" }}>
      {initial}
    </div>
  );
}
