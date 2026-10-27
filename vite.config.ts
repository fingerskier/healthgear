/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages serves the site from /<repo>/; override with BASE_PATH for forks or custom domains.
const base = process.env.BASE_PATH ?? '/healthgear/'

// Production-only CSP: the dev server needs inline scripts for React refresh.
// connect-src is the allowlist of everywhere data can go; keep it tight, the app holds OAuth secrets.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  'frame-src https://accounts.google.com/gsi/',
  "connect-src 'self' https://wbsapi.withings.net https://*.workers.dev https://health.googleapis.com https://sheets.googleapis.com https://accounts.google.com/gsi/",
  "img-src 'self' data:",
  "form-action 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'healthgear-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
  }
}

export default defineConfig({
  base,
  plugins: [
    react(),
    contentSecurityPolicy(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'healthgear',
        short_name: 'healthgear',
        description: 'Read Bluetooth health devices, keep the data locally, sync it where you want.',
        theme_color: '#0f766e',
        background_color: '#0b1214',
        display: 'standalone',
        start_url: base,
        scope: base,
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        navigateFallback: 'index.html',
        // OAuth callbacks land on the app URL with query params; never serve them a stale shell
        // for cross-origin API traffic.
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
