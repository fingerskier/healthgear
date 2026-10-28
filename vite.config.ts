/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages serves the site from /<repo>/; override with BASE_PATH for forks or custom domains.
const base = process.env.BASE_PATH ?? '/healthgear/'

// Production-only CSP: the dev server needs inline scripts for React refresh.
// connect-src is the allowlist of everywhere data can go; keep it tight, the app holds OAuth
// secrets. A Withings token broker is allowed only if its exact origin is set at build time.
function csp(brokerOrigin: string | null) {
  return [
    "default-src 'self'",
    "script-src 'self' https://accounts.google.com/gsi/client",
    "style-src 'self' https://accounts.google.com/gsi/style",
    'frame-src https://accounts.google.com/gsi/',
    [
      "connect-src 'self'",
      'https://wbsapi.withings.net',
      'https://health.googleapis.com',
      'https://sheets.googleapis.com',
      'https://oauth2.googleapis.com',
      'https://accounts.google.com/gsi/',
      brokerOrigin,
    ]
      .filter(Boolean)
      .join(' '),
    "img-src 'self' data:",
    "worker-src 'self'",
    "manifest-src 'self'",
    "form-action 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ')
}

function contentSecurityPolicy(policy: string): Plugin {
  return {
    name: 'healthgear-csp',
    apply: 'build',
    // Right after <meta charset>: a meta CSP only governs what follows it, and charset must stay
    // within the first 1024 bytes.
    transformIndexHtml: {
      order: 'post',
      handler: (html) => html.replace(/(<meta charset="[^"]*"\s*\/?>)/i, `$1\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`),
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const broker = env.VITE_WITHINGS_BROKER_URL ? new URL(env.VITE_WITHINGS_BROKER_URL).origin : null
  return {
    base,
    plugins: [
      react(),
      contentSecurityPolicy(csp(broker)),
      VitePWA({
        registerType: 'prompt',
        manifest: {
          id: base,
          name: 'healthgear',
          short_name: 'healthgear',
          description: 'Read Bluetooth health devices, keep the data locally, sync it where you want.',
          theme_color: '#0f766e',
          background_color: '#0b1214',
          display: 'standalone',
          start_url: base,
          scope: base,
          icons: [
            { src: 'pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // app shell only; API and token responses must never land in Cache Storage
          globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
          navigateFallback: 'index.html',
        },
      }),
    ],
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  }
})
