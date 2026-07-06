import { api } from "./api";

export const PREVIEW_FAMILY = "SensaPreview";

let current: FontFace | null = null;
let gen = 0; // generasi muatan → muatan yang disusul muatan lebih baru DIBUANG (anti font basi menang)

/** (Re)load the compiled preview font under a stable family name. */
export async function loadPreviewFont(version?: number): Promise<void> {
  const my = ++gen;
  try {
    const face = new FontFace(PREVIEW_FAMILY, `url(${api.previewUrl(version)})`);
    await face.load();                       // font BENAR-BENAR siap sebelum dipasang
    // dua muatan beruntun bisa selesai TERBALIK (yang lama selesai terakhir → thumbnail grid
    // render pakai font basi = "kadang tidak ter-render dengan baik"). Hanya generasi terakhir dipasang.
    if (my !== gen) return;
    document.fonts.add(face);                // tambah BARU dulu → tak ada jeda "tanpa font" (cegah kedip/blank)
    const old = current;
    current = face;
    if (old && old !== face) document.fonts.delete(old); // baru buang yang lama, setelah yang baru terpasang
  } catch (e) {
    console.warn("preview font load failed", e);
  }
}
