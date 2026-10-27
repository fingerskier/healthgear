import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { completeWithingsLogin } from './state/withings'

// Before rendering: a Withings authorization code in the URL expires within ~30 s.
void completeWithingsLogin()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
