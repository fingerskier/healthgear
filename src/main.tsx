import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { completeWithingsLogin } from './state/withings'

// GitHub Pages can't send frame-ancestors / X-Frame-Options, and a framing page could delegate
// Bluetooth to us with allow="bluetooth". Refuse to run inside a frame.
if (window.top !== window.self) {
  document.body.textContent = 'healthgear cannot run inside a frame. Open it directly.'
  throw new Error('framed')
}

// Before rendering: a Withings authorization code in the URL expires within ~30 s.
void completeWithingsLogin()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
