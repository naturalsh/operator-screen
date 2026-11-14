import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    // Offline: a service worker stores the page, the scenario data and the packaged basemap on the first visit,
    // so the screen opens and works without a network afterwards (a venue Wi-Fi that drops, a laptop on a
    // projector). Only in the built site (`npm run build` / `npm run preview`, GitHub Pages), not in `npm run dev`.
    VitePWA({
      // A new version waits until the operator taps "New version available, tap to reload": taking over a page
      // that is open would mix the old page with the new data (and reloading by itself would lose open work).
      registerType: 'prompt',
      injectRegister: false,
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,json,geojson,pbf,png,svg,ico,txt,woff,woff2}'],
        // street_access.geojson is about 9 MB.
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
        // Any page address (`?demo=1`, `?t=...`) opens the stored page.
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        // The page that installed the worker (first visit) is served by it at once, not only after the next load.
        clientsClaim: true,
      },
    }),
  ],
  // Served from the site root by default. Under a sub-path (GitHub Pages: /<repository name>/) set VITE_BASE;
  // the data files and the offline basemap are loaded relative to this base.
  base: process.env.VITE_BASE ?? '/',
  // host: true binds 0.0.0.0 so a browser on the Windows side of WSL (or another machine) can reach it.
  server: { port: 5173, host: true },
  preview: { port: 4173, host: true },
});
