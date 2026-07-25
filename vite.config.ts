import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  // maplibre-gl v6 ships its own worker; let it resolve normally instead of
  // through Vite's dep pre-bundler (which mis-handles the worker entry).
  optimizeDeps: { exclude: ['maplibre-gl'] },
  server: {
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
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Pocket Planet — travel guide & map',
        short_name: 'Pocket Planet',
        description:
          'A Lonely Planet-style travel guide and map for anywhere in the world, with the best places ranked by category.',
        theme_color: '#e4572e',
        background_color: '#f7f5f2',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
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
