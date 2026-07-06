import { Component, type ReactNode } from "react";

// Pengaman global: bila komponen mana pun melempar saat render, tampilkan pesan + tombol
// muat ulang — BUKAN layar kosong. (Dulu satu crash komponen mem-blank seluruh aplikasi.)
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error("[UI crash]", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          height: "100%", display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", gap: 12, padding: 24, textAlign: "center",
          background: "#14171d", color: "#e6e8ec",
        }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Terjadi kesalahan pada tampilan</div>
          <div style={{ fontSize: 13, color: "#8b93a1", maxWidth: 460, whiteSpace: "pre-wrap" }}>
            {String(this.state.error?.message || this.state.error)}
          </div>
          <button onClick={() => location.reload()} style={{
            marginTop: 8, padding: "8px 16px", borderRadius: 8, border: "1px solid #2a2f3a",
            background: "#4f8cff", color: "#fff", cursor: "pointer", fontSize: 13,
          }}>
            Muat ulang
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
