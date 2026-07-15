import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { AuthGate } from "./components/AuthGate";
import { ErrorBoundary } from "./components/ErrorBoundary";

// macOS: beri kelas is-mac → CSS menyisakan ruang utk tombol lampu-lalu-lintas di header
// (bilah judul OS disembunyikan). Windows/Linux: kontrol jendela di kanan, tak perlu padding.
if (window.sensatype?.platform === "darwin") document.documentElement.classList.add("is-mac");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthGate>
        <App />
      </AuthGate>
    </ErrorBoundary>
  </StrictMode>,
);
