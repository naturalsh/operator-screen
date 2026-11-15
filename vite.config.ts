import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The commit and the build time, shown in the Layers panel and written to version.json (to tell an old page). */
const commit = (() => { try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'dev'; } })();
const VERSION = { commit, built: new Date().toISOString().slice(0, 16) + 'Z' };

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(VERSION) },
  plugins: [
    react(),
    // version.json next to the page: fetched from the network after loading, never from the offline package.
    {
      name: 'ns-version-file',
      writeBundle(options) {
        const dir = options.dir ?? resolve(__dirname, 'dist');
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, 'version.json'), JSON.stringify(VERSION) + '\n');
      },
    },
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
        globPatterns: ['**/*.{js,css,html,json,geojson,pbf,png,svg,ico,txt,woff,woff2,bin,gz}'],
        globIgnores: ['version.json'],
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
