import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves from /<repo>/, so the base must be overridable at build time.
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'favicon.svg',
        'apple-touch-icon.png',
        'icon-192.png',
        'icon-512.png',
        'maskable-192.png',
        'maskable-512.png',
      ],
      manifest: {
        name: 'Freo Stone Production',
        short_name: 'Freo Prod',
        description: 'Production, curing and shotblast tracking against MYOB stock and future jobs',
        start_url: '.',
        display: 'standalone',
        orientation: 'any',
        background_color: '#0d1117',
        theme_color: '#0d1117',
        // Sizes are not decoration here. Android and desktop Chrome will not
        // offer an install without a 192px and a 512px PNG, and the maskable pair
        // exists so a launcher that crops to a circle or squircle clips the
        // background rather than the pavers (see scripts/make-icons.py). iOS reads
        // the apple-touch-icon link in index.html and ignores this list.
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'apple-touch-icon.png', sizes: '180x180', type: 'image/png', purpose: 'any' },
        ],
      },
      workbox: {
        // The app is local-first: everything needed to render comes from the precache,
        // and MYOB/GitHub refreshes happen in the background when a connection exists.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: { port: 5173, host: true },
  build: { target: 'es2022', sourcemap: true, reportCompressedSize: false },
});
