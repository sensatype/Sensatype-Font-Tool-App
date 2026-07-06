// Jembatan yang diekspos preload Electron (app/electron/preload.cjs). Opsional — undefined di browser.
export {};

declare global {
  interface Window {
    sensatype?: {
      isElectron: boolean;
      openExternal: (url: string) => Promise<boolean>;
      focus?: () => Promise<boolean>;
    };
  }
}
