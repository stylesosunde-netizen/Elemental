import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifestFilename: 'manifest.json',
      includeAssets: [
        'favicon.svg',
        'pwa-icon.svg',
        'pwa-icon-192.png',
        'pwa-icon-512.png',
        'apple-touch-icon.png',
        'apple-splash-iphone.png',
        'apple-splash-iphone-large.png',
        'apple-splash-ipad.png',
        'apple-splash-ipad-large.png',
      ],
      manifest: {
        name: 'Elemental Planner',
        short_name: 'Elemental',
        description: 'A focused planner for tasks, ideas, and commitments.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#171817',
        theme_color: '#171817',
        icons: [
          {
            src: '/pwa-icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/pwa-icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        navigateFallback: '/index.html',
        globPatterns: ['**/*.{html,js,css,svg,png,ico,woff,woff2,ttf,otf}'],
        runtimeCaching: [
          {
            urlPattern: /\.(?:js|css|svg|png|ico|woff2?|ttf|otf)(?:\?.*)?$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'elemental-static-assets',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
    }),
  ],
})
