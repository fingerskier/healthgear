import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState, type ChangeEvent } from 'react'
import { db, unsynced } from '../db'
import { download, toCsv, toJson } from '../export'
import { importFile } from '../import'
import { gisReady, googleHealthEligible, loadGis, sheetUrl } from '../sinks/google'
import { pushGoogleHealth, pushGoogleSheet, saveGoogleClientId, useGoogle, type GoogleState } from '../state/google'
import { toast } from '../state/toast'
import { disconnectWithings, saveWithingsConfig, startWithingsLogin, syncWithings, useWithings, type WithingsState } from '../state/withings'
import { HOSTED_WITHINGS, redirectUri } from '../sources/withings'
import { AppleHealth } from './AppleHealth'
import { DownloadIcon, UploadIcon } from './icons'

export function Sync() {
  return (
    <div className="stack">
      <Withings />
      <Google />
      <AppleHealth />
      <Files />
    </div>
  )
}

function Withings() {
  const w = useWithings()
  if (!w) return null
  // keyed so the form re-initializes if the stored config changes underneath it
  return <WithingsCard key={JSON.stringify(w.config ?? {})} w={w} />
}

function WithingsCard({ w }: { w: WithingsState }) {
  const [clientId, setClientId] = useState(w.config?.brokerUrl ? '' : (w.config?.clientId ?? ''))
  const [secret, setSecret] = useState(w.config?.clientSecret ?? '')
  const [busy, setBusy] = useState(false)

  const connected = !!w.tokens
  const own = { clientId: clientId.trim(), clientSecret: secret.trim() }
  const ownReady = !!(own.clientId && own.clientSecret)

  const sync = async (full: boolean) => {
    setBusy(true)
    await syncWithings(full)
    setBusy(false)
  }

  return (
    <section className="card">
      <h2>Withings</h2>
      <p className="muted">
        Withings scales and cuffs only talk to the Withings app (proprietary, encrypted Bluetooth). Take readings with
        the Withings app as usual, then import them here from the Withings cloud.
      </p>
      {connected ? (
        <>
          <p>
            Connected. {w.lastSync ? `Last import ${new Date(w.lastSync).toLocaleString()}.` : 'Not imported yet.'}
          </p>
          <div className="row wrap">
            <button className="primary" disabled={busy} onClick={() => void sync(false)}>
              Import new readings
            </button>
            <button disabled={busy} onClick={() => void sync(true)}>
              Re-import everything
            </button>
            <button className="ghost" onClick={() => void disconnectWithings()}>
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <>
          {HOSTED_WITHINGS && (
            <div className="row wrap">
              <button className="primary" onClick={() => void startWithingsLogin(HOSTED_WITHINGS!)}>
                Connect Withings
              </button>
              <button onClick={() => void startWithingsLogin(HOSTED_WITHINGS!, true)}>Try the Withings demo account</button>
            </div>
          )}
          <details open={!HOSTED_WITHINGS}>
            <summary>{HOSTED_WITHINGS ? 'Or use your own Withings developer app' : 'Set up (one time, about 5 minutes)'}</summary>
            <ol className="prose">
              <li>
                Sign in at <a href="https://developer.withings.com/dashboard/" target="_blank" rel="noreferrer">developer.withings.com</a> and
                create an application: <em>Withings public cloud</em> → <em>Public API integration</em>, environment <em>Development</em>.
              </li>
              <li>
                Set the callback URL to exactly <code>{redirectUri()}</code>
              </li>
              <li>Copy the Client ID and Secret into the fields below.</li>
            </ol>
            <p className="fine">Your secret stays in this browser and is only sent to Withings.</p>
            <div className="fields">
              <label>
                <span>Client ID</span>
                <input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} />
              </label>
              <label>
                <span>Client secret</span>
                <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
              </label>
            </div>
            <div className="row wrap">
              <button className={HOSTED_WITHINGS ? '' : 'primary'} disabled={!ownReady} onClick={() => void startWithingsLogin(own)}>
                Connect with my app
              </button>
              <button disabled={!ownReady} onClick={() => void startWithingsLogin(own, true)}>
                Try the Withings demo account
              </button>
              <button className="ghost" disabled={!own.clientId} onClick={() => void saveWithingsConfig(own).then(() => toast('Saved'))}>
                Save
              </button>
            </div>
          </details>
          <p className="fine">
            Withings accounts created after 12 Oct 2026 need a Withings+ membership before Withings will share data with
            apps like this one. No API access? Import the Withings data export under Files below.
          </p>
        </>
      )}
    </section>
  )
}

function Google() {
  const g = useGoogle()
  if (!g) return null
  return <GoogleCard key={g.clientId ?? ''} g={g} />
}

function GoogleCard({ g }: { g: GoogleState }) {
  const [clientId, setClientId] = useState(g.clientId ?? '')
  const [ready, setReady] = useState(gisReady)
  const [busy, setBusy] = useState<'health' | 'sheet' | null>(null)
  const run = (which: 'health' | 'sheet', push: (id: string) => Promise<void>) => {
    // push() must start inside the click (consent popup); only the bookkeeping waits
    const done = push(g.clientId!)
    setBusy(which)
    void done.finally(() => setBusy(null))
  }
  const counts = useLiveQuery(async () => ({
    health: (await unsynced('googleHealth')).filter(googleHealthEligible).length,
    sheets: (await unsynced('googleSheets')).length,
  }))

  useEffect(() => {
    // Load sign-in ahead of the click: the consent popup must open inside the click itself.
    if (!g.clientId || ready) return
    let live = true
    loadGis().then(
      () => live && setReady(true),
      () => live && toast('Could not load Google sign-in. Check your connection and reopen this tab.', 'error'),
    )
    return () => {
      live = false
    }
  }, [g.clientId, ready])

  return (
    <section className="card">
      <h2>Google</h2>
      <p className="muted">
        <strong>Google Health</strong> accepts weight, body fat and height. It has no blood-pressure type, and Google
        Fit, which did, is closed to new apps and shuts down at the end of 2026. So a <strong>Google Sheet</strong> in
        your Drive can also receive every reading, blood pressure included.
      </p>
      <details>
        <summary>Set up (one time, about 10 minutes)</summary>
        <ol className="prose">
          <li>
            In <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">Google Cloud Console</a>, create a project and enable
            the <em>Google Health API</em> and <em>Google Sheets API</em>.
          </li>
          <li>
            Google Auth Platform → Audience: <em>External</em>, status <em>Testing</em>, add your Google account as a test user. Data access: add the
            scopes <code>googlehealth.health_metrics_and_measurements.writeonly</code> and <code>drive.file</code>.
          </li>
          <li>
            Clients → create an OAuth client of type <em>Web application</em>. Authorized JavaScript origin: <code>{location.origin}</code> (no path).
          </li>
          <li>Paste the client ID below.</li>
        </ol>
        <p className="fine">
          Tokens last an hour and are never stored, so sending is always a button press. Google will warn that the app
          is unverified; that's your own project.
        </p>
      </details>
      <div className="fields">
        <label>
          <span>OAuth client ID</span>
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="….apps.googleusercontent.com" spellCheck={false} />
        </label>
      </div>
      <div className="row wrap">
        {clientId.trim() !== (g.clientId ?? '') && (
          <button onClick={() => void saveGoogleClientId(clientId).then(() => toast('Saved'))} disabled={!clientId.trim()}>
            Save client ID
          </button>
        )}
        <button className="primary" disabled={!g.clientId || !ready || busy !== null} onClick={() => run('health', pushGoogleHealth)}>
          <UploadIcon /> Send to Google Health ({counts?.health ?? 0})
        </button>
        <button disabled={!g.clientId || !ready || busy !== null} onClick={() => run('sheet', pushGoogleSheet)}>
          <UploadIcon /> Add to Google Sheet ({counts?.sheets ?? 0})
        </button>
      </div>
      {g.sheetId && (
        <p className="small">
          <a href={sheetUrl(g.sheetId)} target="_blank" rel="noreferrer">
            Open your healthgear sheet
          </a>
        </p>
      )}
    </section>
  )
}

function Files() {
  const exportAll = async (fmt: 'csv' | 'json') => {
    const readings = await db.readings.orderBy('takenAt').toArray()
    const stamp = new Date().toISOString().slice(0, 10)
    if (fmt === 'csv') download(`healthgear-${stamp}.csv`, toCsv(readings), 'text/csv')
    else download(`healthgear-${stamp}.json`, toJson(readings), 'application/json')
  }

  const onImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const { added, parsed, format } = await importFile(file)
      toast(`${format}: ${parsed} readings found, ${added} new`)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  return (
    <section className="card">
      <h2>Files</h2>
      <p className="muted">
        Export everything for a spreadsheet, a doctor, or a backup. Import takes healthgear exports and the Withings
        account data export (<code>weight.csv</code>, <code>bp.csv</code>).
      </p>
      <div className="row wrap">
        <button onClick={() => void exportAll('csv')}>
          <DownloadIcon /> CSV
        </button>
        <button onClick={() => void exportAll('json')}>
          <DownloadIcon /> JSON
        </button>
        <label className="button">
          <UploadIcon /> Import file
          <input type="file" accept=".csv,.json,text/csv,application/json" hidden onChange={(e) => void onImport(e)} />
        </label>
      </div>
    </section>
  )
}
