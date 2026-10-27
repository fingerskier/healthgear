import { useState, type FormEvent } from 'react'
import { addReadings } from '../db'
import type { Metric, ReadingKind, Values } from '../model'
import { useUnits } from '../state/settings'
import { toast } from '../state/toast'
import { fromDisplay, unitLabel } from '../units'

const FIELDS: Record<ReadingKind, { metric: Metric; label: string; required?: boolean; step: string }[]> = {
  body: [
    { metric: 'weight', label: 'Weight', required: true, step: '0.1' },
    { metric: 'bodyFat', label: 'Body fat', step: '0.1' },
  ],
  bloodPressure: [
    { metric: 'systolic', label: 'Systolic', required: true, step: '1' },
    { metric: 'diastolic', label: 'Diastolic', required: true, step: '1' },
    { metric: 'heartRate', label: 'Pulse', step: '1' },
  ],
  heartRate: [{ metric: 'heartRate', label: 'Heart rate', required: true, step: '1' }],
  spo2: [
    { metric: 'spo2', label: 'SpO₂', required: true, step: '1' },
    { metric: 'heartRate', label: 'Pulse', step: '1' },
  ],
  temperature: [{ metric: 'temperature', label: 'Temperature', required: true, step: '0.1' }],
  glucose: [{ metric: 'glucose', label: 'Glucose', required: true, step: '0.1' }],
}

const KINDS: { kind: ReadingKind; label: string }[] = [
  { kind: 'body', label: 'Weight' },
  { kind: 'bloodPressure', label: 'Blood pressure' },
  { kind: 'heartRate', label: 'Heart rate' },
  { kind: 'spo2', label: 'SpO₂' },
  { kind: 'temperature', label: 'Temperature' },
  { kind: 'glucose', label: 'Glucose' },
]

function localInputValue(d: Date) {
  const off = d.getTimezoneOffset() * 60_000
  return new Date(d.getTime() - off).toISOString().slice(0, 16)
}

export function ManualEntry({ onDone }: { onDone: () => void }) {
  const [units] = useUnits()
  const [kind, setKind] = useState<ReadingKind>('body')
  const [when, setWhen] = useState(() => localInputValue(new Date()))
  const [raw, setRaw] = useState<Record<string, string>>({})

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const values: Values = {}
    for (const f of FIELDS[kind]) {
      const s = raw[`${kind}.${f.metric}`]
      if (s === undefined || s === '') continue
      const n = Number(s)
      if (!Number.isFinite(n)) return toast(`${f.label} is not a number`, 'error')
      values[f.metric] = fromDisplay(f.metric, n, units)
    }
    const takenAt = new Date(when).getTime()
    if (!Number.isFinite(takenAt)) return toast('Pick a date and time', 'error')
    const saved = await addReadings([{ kind, takenAt, deviceTime: true, values, source: 'manual' }])
    toast(saved.length ? 'Reading added' : 'Already have that reading')
    setRaw({})
    onDone()
  }

  return (
    <form className="card form" onSubmit={(e) => void submit(e)}>
      <h2>Add a reading</h2>
      <div className="segmented" role="radiogroup" aria-label="Reading type">
        {KINDS.map((k) => (
          <button type="button" key={k.kind} role="radio" aria-checked={kind === k.kind} className={kind === k.kind ? 'on' : ''} onClick={() => setKind(k.kind)}>
            {k.label}
          </button>
        ))}
      </div>
      <div className="fields">
        {FIELDS[kind].map((f) => (
          <label key={f.metric}>
            <span>
              {f.label} <span className="muted">({unitLabel(f.metric, units)})</span>
            </span>
            <input
              type="number"
              inputMode="decimal"
              step={f.step}
              required={f.required}
              value={raw[`${kind}.${f.metric}`] ?? ''}
              onChange={(e) => setRaw((r) => ({ ...r, [`${kind}.${f.metric}`]: e.target.value }))}
            />
          </label>
        ))}
        <label>
          <span>When</span>
          <input type="datetime-local" required value={when} onChange={(e) => setWhen(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <button className="primary" type="submit">
          Save
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}
