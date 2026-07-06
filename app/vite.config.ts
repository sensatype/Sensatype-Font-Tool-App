import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,           // dengarkan semua interface → device lain di jaringan bisa akses (uji)
    port: 5173,
    allowedHosts: true,   // izinkan Host header apa pun (IP/Tailscale MagicDNS) — untuk dev/uji
    proxy: {
      // Browser hanya bicara ke Vite; Vite yang teruskan /api ke backend lokal Mac →
      // hanya port 5173 yang perlu diekspos, backend :8000 tetap localhost.
      "/api": "http://localhost:8000",
    },
  },
});
