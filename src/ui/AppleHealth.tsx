import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { markSynced, unsynced } from '../db'
import { DEFAULT_SHORTCUT_NAME, nextBatch } from '../sinks/apple'
import { useSetting } from '../state/settings'
import { toast } from '../state/toast'
import { CheckIcon, UploadIcon } from './icons'

interface AppleSettings {
  shortcutName: string
  skipWithings: boolean
}

export function AppleHealth() {
  const [settings, setSettings] = useSetting<AppleSettings>('apple', { shortcutName: DEFAULT_SHORTCUT_NAME, skipWithings: false })
  const all = useLiveQuery(() => unsynced('apple'), [])
  const [sent, setSent] = useState<string[] | null>(null)
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const pending = (all ?? []).filter((r) => !(settings.skipWithings && r.source === 'withings'))
  const batch = sent ? null : nextBatch(settings.shortcutName, pending)

  // Synchronous on purpose: iOS only opens other apps from inside the tap.
  const send = () => {
    if (!batch) return toast('Apple Health is up to date')
    setSent(batch.readings.map((r) => r.id))
    location.href = batch.url
  }

  const confirm = async () => {
    if (!sent) return
    await markSynced('apple', sent)
    toast(`Marked ${sent.length} readings as sent to Apple Health`)
    setSent(null)
  }

  return (
    <section className="card">
      <h2>Apple Health</h2>
      <p className="muted">
        Apple gives websites no way to write to Health. The bridge is a shortcut you build once in Apple's Shortcuts
        app: healthgear opens it with your new readings and it logs them to Health. iPhone or iPad only.
      </p>
      {!ios && <p className="fine">You're not on iOS right now; open this page on your iPhone to use it.</p>}
      {ios && (
        <p className="fine">
          Send from the same place you collected readings: Safari, Bluefy and the Home Screen app each keep separate
          storage. Use Files → export/import to move readings between them.
        </p>
      )}
      <details>
        <summary>Build the shortcut (one time, about 10 minutes)</summary>
        <ol className="prose">
          <li>
            In Shortcuts tap <strong>+</strong> and name the shortcut <code>{settings.shortcutName}</code> (or change the name below to match yours).
          </li>
          <li>
            Add <em>Get Dictionary from Input</em> (input: <em>Shortcut Input</em>).
          </li>
          <li>
            For each type you want, add this block. Start with <code>weight</code>:
            <ol type="a">
              <li>
                <em>Get Dictionary Value</em>: key <code>weight</code> in <em>Dictionary</em>.
              </li>
              <li>
                <em>Repeat with Each</em> item in <em>Dictionary Value</em>. Inside the repeat:
              </li>
              <li>
                <em>Get Dictionary Value</em> key <code>date</code> in <em>Repeat Item</em> → <em>Get Dates from Input</em>.
              </li>
              <li>
                <em>Get Dictionary Value</em> key <code>value</code> in <em>Repeat Item</em>.
              </li>
              <li>
                <em>Log Health Sample</em>: Type <em>Weight</em>, Value = that dictionary value, unit <em>kg</em>, Date = <em>Dates</em>.
              </li>
            </ol>
          </li>
          <li>
            Blood pressure: same block with key <code>bloodPressure</code>, but read <code>systolic</code> and <code>diastolic</code> and pick Type{' '}
            <em>Blood Pressure</em>; it has two value fields (mmHg).
          </li>
          <li>
            Other keys, with the Type and unit to pick in <em>Log Health Sample</em>: <code>bodyFat</code> Body Fat Percentage (%), <code>leanMass</code> Lean
            Body Mass (kg), <code>bmi</code> Body Mass Index, <code>height</code> Height (cm), <code>heartRate</code> Heart Rate (count/min),{' '}
            <code>spo2</code> Oxygen Saturation (%), <code>temperature</code> Body Temperature (°C), <code>glucose</code> Blood Glucose (mg/dL).
          </li>
          <li>Run it once from Shortcuts and allow Health access. Missing a type later? Health → profile → Privacy → Apps → Shortcuts.</li>
        </ol>
        <p className="fine">
          Payload: <code>{'{"v":1,"weight":[{"value":72.5,"date":"2026-10-27T07:45:00-05:00"}],"bloodPressure":[{"systolic":121,"diastolic":79,"date":"…"}],…}'}</code>.
          Every key is always present; empty lists just skip their block.
        </p>
      </details>
      <div className="fields">
        <label>
          <span>Shortcut name</span>
          <input value={settings.shortcutName} onChange={(e) => void setSettings({ ...settings, shortcutName: e.target.value })} spellCheck={false} />
        </label>
      </div>
      <label className="toggle small">
        <input type="checkbox" checked={settings.skipWithings} onChange={(e) => void setSettings({ ...settings, skipWithings: e.target.checked })} />
        Skip readings imported from Withings (if the Withings app already syncs to Health)
      </label>
      <div className="row wrap">
        <button className="primary" onClick={send} disabled={!batch || !settings.shortcutName.trim()}>
          <UploadIcon /> Send {batch?.readings.length ?? 0}
          {pending.length > (batch?.readings.length ?? 0) ? ` of ${pending.length}` : ''} to Apple Health
        </button>
        {sent && (
          <>
            <button onClick={() => void confirm()}>
              <CheckIcon /> It worked: mark as sent
            </button>
            <button className="ghost" onClick={() => setSent(null)}>
              It failed
            </button>
          </>
        )}
      </div>
      {sent && (
        <p className="fine">
          Mark them only once the shortcut finished without errors. Health can't detect duplicates, so a batch sent
          twice is logged twice.
        </p>
      )}
    </section>
  )
}
