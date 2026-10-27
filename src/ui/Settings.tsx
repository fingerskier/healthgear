import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { db, deleteReadings } from '../db'
import { useUnits } from '../state/settings'
import { toast } from '../state/toast'
import type { UnitPrefs } from '../units'

const OPTIONS: { key: keyof UnitPrefs; label: string; choices: { value: string; label: string }[] }[] = [
  { key: 'mass', label: 'Weight', choices: [{ value: 'kg', label: 'kg' }, { value: 'lb', label: 'lb' }, { value: 'st', label: 'stone' }] },
  { key: 'temperature', label: 'Temperature', choices: [{ value: 'C', label: '°C' }, { value: 'F', label: '°F' }] },
  { key: 'glucose', label: 'Glucose', choices: [{ value: 'mmol/L', label: 'mmol/L' }, { value: 'mg/dL', label: 'mg/dL' }] },
  { key: 'length', label: 'Height', choices: [{ value: 'm', label: 'm' }, { value: 'in', label: 'in' }] },
]

export function Settings() {
  const [units, setUnits] = useUnits()
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const counts = useLiveQuery(async () => ({
    total: await db.readings.count(),
    demo: await db.readings.where('source').equals('demo').count(),
  }))

  useEffect(() => {
    void navigator.storage?.persisted?.().then(setPersisted)
  }, [])

  const persist = async () => {
    const ok = (await navigator.storage?.persist?.()) ?? false
    setPersisted(ok)
    toast(ok ? 'Storage is now persistent' : 'The browser declined. Installing the app usually helps.', ok ? 'info' : 'error')
  }

  const purgeDemo = async () => {
    const ids = await db.readings.where('source').equals('demo').primaryKeys()
    await deleteReadings(ids, db, false) // demo data is regenerated, nothing to remember
    toast(`Deleted ${ids.length} demo readings`)
  }

  const purgeAll = async () => {
    if (!confirm('Delete every reading, sync record and setting stored in this browser? This cannot be undone.')) return
    await db.delete()
    location.reload()
  }

  return (
    <div className="stack">
      <section className="card">
        <h2>Units</h2>
        <p className="muted">Readings are stored in metric; this only changes how they're shown and entered.</p>
        <div className="fields">
          {OPTIONS.map((o) => (
            <label key={o.key}>
              <span>{o.label}</span>
              <select value={units[o.key]} onChange={(e) => void setUnits({ ...units, [o.key]: e.target.value })}>
                {o.choices.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Your data</h2>
        <p className="muted">
          Everything lives in this browser's storage (IndexedDB) on this device. Nothing is sent anywhere unless you
          use a sync option. Clearing site data, or browser cleanup of an un-persisted site, deletes it, so export
          regularly.
        </p>
        <p>
          {counts?.total ?? 0} readings stored{counts?.demo ? `, ${counts.demo} of them demo` : ''}. Storage is{' '}
          <strong>{persisted === null ? 'unknown' : persisted ? 'persistent' : 'best-effort'}</strong>.
        </p>
        <div className="row wrap">
          {persisted === false && <button onClick={() => void persist()}>Make storage persistent</button>}
          {!!counts?.demo && <button onClick={() => void purgeDemo()}>Delete demo readings</button>}
          <button className="danger" onClick={() => void purgeAll()}>
            Delete everything
          </button>
        </div>
      </section>

      <section className="card prose">
        <h2>About</h2>
        <p>
          healthgear is free software (Apache-2.0). Source, issues and device-support requests:{' '}
          <a href="https://github.com/fingerskier/healthgear">github.com/fingerskier/healthgear</a>.
        </p>
        <p className="fine">Not a medical device. Readings are shown as reported by your hardware; talk to a clinician about what they mean.</p>
      </section>
    </div>
  )
}
