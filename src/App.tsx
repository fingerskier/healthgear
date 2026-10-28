import { useEffect, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { dismiss, useToasts } from './state/toast'
import { Devices } from './ui/Devices'
import { Readings } from './ui/Readings'
import { Settings } from './ui/Settings'
import { Sync } from './ui/Sync'

const TABS = [
  { key: 'devices', label: 'Devices' },
  { key: 'readings', label: 'Readings' },
  { key: 'sync', label: 'Sync' },
  { key: 'settings', label: 'Settings' },
] as const

type Tab = (typeof TABS)[number]['key']

function tabFromHash(): Tab {
  const h = location.hash.replace('#', '')
  return (TABS.find((t) => t.key === h)?.key ?? 'devices') as Tab
}

export default function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash)
  useEffect(() => {
    const on = () => setTab(tabFromHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#devices">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width="24" height="24" />
          healthgear
        </a>
        <nav aria-label="Sections">
          {TABS.map((t) => (
            <a key={t.key} href={`#${t.key}`} aria-current={tab === t.key ? 'page' : undefined}>
              {t.label}
            </a>
          ))}
        </nav>
      </header>
      <main>
        {tab === 'devices' && <Devices />}
        {tab === 'readings' && <Readings />}
        {tab === 'sync' && <Sync />}
        {tab === 'settings' && <Settings />}
      </main>
      <UpdatePrompt />
      <Toasts />
    </div>
  )
}

function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW()
  if (!needRefresh) return null
  return (
    <div className="toast update" role="status">
      A new version is available.
      <button className="primary" onClick={() => void updateServiceWorker(true)}>
        Reload
      </button>
      <button className="ghost" onClick={() => setNeedRefresh(false)}>
        Later
      </button>
    </div>
  )
}

function Toasts() {
  const toasts = useToasts()
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  )
}
