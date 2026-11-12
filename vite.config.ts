import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // host: true binds 0.0.0.0 so a browser on the Windows side of WSL (or another machine) can reach it.
  server: { port: 5173, host: true },
  preview: { port: 4173, host: true },
});
