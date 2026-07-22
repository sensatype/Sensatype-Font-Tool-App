import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IconContext } from "@phosphor-icons/react";
import "./index.css";
import { App } from "./App";
import { AuthGate } from "./components/AuthGate";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SettingsProvider } from "./components/Settings";

// macOS: beri kelas is-mac → CSS menyisakan ruang utk tombol lampu-lalu-lintas di header
// (bilah judul OS disembunyikan). Windows/Linux: kontrol jendela di kanan, tak perlu padding.
if (window.sensatype?.platform === "darwin") document.documentElement.classList.add("is-mac");

// Bobot ikon global (Phosphor). Default Phosphor "regular" (~1,5px @24) lebih tipis dari lucide
// yang lama (stroke 2) → di toolbar padat ikon jadi pucat. "bold" (~2,25px) paling dekat dgn
// tampilan sebelumnya. Satu tempat: ubah di sini kalau mau lebih tipis/tebal.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <IconContext.Provider value={{ weight: "bold" }}>
      <ErrorBoundary>
        <SettingsProvider>
          <AuthGate>
            <App />
          </AuthGate>
        </SettingsProvider>
      </ErrorBoundary>
    </IconContext.Provider>
  </StrictMode>,
);
