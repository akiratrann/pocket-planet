import { copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// The marketing page (landing/index.html) is standalone, self-contained HTML —
// inline CSS/JS, no imports — so it needs no bundling. Copy it into the build as
// landing.html; the server serves it at `/` while the SPA lives at `/app`.
function copyLandingPage() {
  return {
    name: 'copy-landing-page',
    closeBundle() {
      copyFileSync(
        fileURLToPath(new URL('./landing/index.html', import.meta.url)),
        fileURLToPath(new URL('./dist/landing.html', import.meta.url)),
      )
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // maplibre-gl v6 ships its own worker; let it resolve normally instead of
  // through Vite's dep pre-bundler (which mis-handles the worker entry).
  optimizeDeps: { exclude: ['maplibre-gl'] },
  server: {
    // Bind to all interfaces so you can open the app on your phone (same Wi-Fi).
    host: true,
    proxy: {
      // Forward API calls to the backend "brain" during development.
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  plugins: [
    react(),
    copyLandingPage(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Pocket Planet — travel guide & map',
        short_name: 'Pocket Planet',
        description:
          'A travel guide and map for anywhere in the world, with the best places ranked by category.',
        theme_color: '#e4572e',
        background_color: '#f7f5f2',
        display: 'standalone',
        orientation: 'portrait',
        // The app lives at /app; `/` is the marketing page. Installing the PWA
        // must open the app, not the landing page.
        start_url: '/app',
        scope: '/',
        icons: [
          {
            src: 'favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: 'favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Navigations fall back to the app shell so client-side routes work
        // offline — but NOT for `/` (the landing page, which the server owns)
        // or `/api`. Without the denylist the service worker would serve the
        // cached app shell at `/` and returning visitors would never see the
        // marketing page again.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/$/],
        // Workbox otherwise maps `/` onto the precached index.html (its
        // `directoryIndex` default), which matches BEFORE navigateFallback and
        // would serve the app shell at `/` — hiding the landing page from
        // anyone who has already loaded the app once. `/` is the server's.
        directoryIndex: null,
        // Cache map tiles and Wikivoyage/Commons responses for offline-ish use.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/[abc]\.basemaps\.cartocdn\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: /^https:\/\/en\.wikivoyage\.org\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'wikivoyage-api',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
          {
            urlPattern: /^https:\/\/commons\.wikimedia\.org\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'commons-images',
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
})
