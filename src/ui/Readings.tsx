import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { db, deleteReadings } from '../db'
import { METRICS, type Metric, type Reading, type ReadingKind } from '../model'
import { useUnits } from '../state/settings'
import { display, type UnitPrefs } from '../units'
import { TrashIcon, PlusIcon } from './icons'
import { ManualEntry } from './ManualEntry'
import { TrendChart, type Series } from './TrendChart'

const RANGES = [
  { key: '7d', label: '7 days', ms: 7 * 86_400_000 },
  { key: '30d', label: '30 days', ms: 30 * 86_400_000 },
  { key: '90d', label: '90 days', ms: 90 * 86_400_000 },
  { key: 'all', label: 'All', ms: Infinity },
] as const

const KIND_LABEL: Record<ReadingKind, string> = {
  body: 'Body',
  bloodPressure: 'Blood pressure',
  heartRate: 'Heart rate',
  spo2: 'Blood oxygen',
  temperature: 'Temperature',
  glucose: 'Glucose',
}

export function Readings() {
  const [units] = useUnits()
  const [range, setRange] = useState<(typeof RANGES)[number]['key']>('30d')
  const [adding, setAdding] = useState(false)
  // Read the clock once per mount: keeps render pure and the slice stable while you look at it.
  const [now] = useState(() => Date.now())
  const ms = RANGES.find((r) => r.key === range)!.ms
  const since = ms === Infinity ? 0 : now - ms

  const readings = useLiveQuery(() => db.readings.where('takenAt').aboveOrEqual(since).reverse().sortBy('takenAt'), [since])
  const syncs = useLiveQuery(() => db.syncs.toArray(), [])
  const syncedBy = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const s of syncs ?? []) m.set(s.readingId, [...(m.get(s.readingId) ?? []), s.sink])
    return m
  }, [syncs])

  if (!readings) return null

  return (
    <div className="stack">
      <div className="row between wrap">
        <div className="segmented" role="radiogroup" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r.key} role="radio" aria-checked={range === r.key} className={range === r.key ? 'on' : ''} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
        <button className="primary" onClick={() => setAdding((a) => !a)}>
          <PlusIcon /> Add reading
        </button>
      </div>

      {adding && <ManualEntry onDone={() => setAdding(false)} />}

      {readings.length === 0 ? (
        <section className="card empty">
          <h2>No readings yet</h2>
          <p className="muted">Connect a device, run a demo device, import from Withings, or add a reading by hand.</p>
        </section>
      ) : (
        <>
          <StatTiles readings={readings} units={units} />
          <Charts readings={readings} units={units} />
          <History readings={readings} units={units} syncedBy={syncedBy} />
        </>
      )}
    </div>
  )
}

const TILES: { metric: Metric; kind: ReadingKind; label: string }[] = [
  { metric: 'weight', kind: 'body', label: 'Weight' },
  { metric: 'bodyFat', kind: 'body', label: 'Body fat' },
  { metric: 'systolic', kind: 'bloodPressure', label: 'Blood pressure' },
  { metric: 'heartRate', kind: 'heartRate', label: 'Heart rate' },
  { metric: 'spo2', kind: 'spo2', label: 'SpO₂' },
  { metric: 'temperature', kind: 'temperature', label: 'Temperature' },
  { metric: 'glucose', kind: 'glucose', label: 'Glucose' },
]

function StatTiles({ readings, units }: { readings: Reading[]; units: UnitPrefs }) {
  const tiles = TILES.flatMap((t) => {
    const latest = readings.find((r) => r.kind === t.kind && r.values[t.metric] !== undefined)
    if (!latest) return []
    const v = display(t.metric, latest.values[t.metric]!, units)
    const value =
      t.metric === 'systolic' && latest.values.diastolic !== undefined
        ? `${v.text}/${display('diastolic', latest.values.diastolic, units).text}`
        : v.text
    return [{ ...t, value, unit: v.unit, at: latest.takenAt }]
  })
  return (
    <div className="tiles">
      {tiles.map((t) => (
        <div key={t.label} className="tile">
          <div className="tile-label">{t.label}</div>
          <div className="tile-value">
            {t.value} <span className="tile-unit">{t.unit}</span>
          </div>
          <div className="tile-meta">{relative(t.at)}</div>
        </div>
      ))}
    </div>
  )
}

function Charts({ readings, units }: { readings: Reading[]; units: UnitPrefs }) {
  const series = (metric: Metric, color: string, label = METRICS[metric].label): Series => ({
    key: metric,
    label,
    color,
    points: readings
      .filter((r) => r.values[metric] !== undefined)
      .map((r) => ({ t: r.takenAt, v: display(metric, r.values[metric]!, units).value })),
  })
  const charts: { title: string; unit: string; series: Series[]; digits: number }[] = []
  const weight = series('weight', 'var(--series-1)')
  if (weight.points.length > 1) charts.push({ title: 'Weight', unit: display('weight', 0, units).unit, series: [weight], digits: 1 })
  const sys = series('systolic', 'var(--series-1)')
  const dia = series('diastolic', 'var(--series-2)')
  if (sys.points.length > 1) charts.push({ title: 'Blood pressure', unit: 'mmHg', series: [sys, dia], digits: 0 })
  const bodyFat = series('bodyFat', 'var(--series-1)')
  if (bodyFat.points.length > 1) charts.push({ title: 'Body fat', unit: '%', series: [bodyFat], digits: 1 })
  const temp = series('temperature', 'var(--series-1)')
  if (temp.points.length > 1) charts.push({ title: 'Temperature', unit: display('temperature', 0, units).unit, series: [temp], digits: 1 })
  const glucose = series('glucose', 'var(--series-1)')
  if (glucose.points.length > 1) charts.push({ title: 'Glucose', unit: display('glucose', 0, units).unit, series: [glucose], digits: units.glucose === 'mg/dL' ? 0 : 1 })
  if (charts.length === 0) return null
  return (
    <section className="card charts">
      {charts.map((c) => (
        <TrendChart key={c.title} title={c.title} unit={c.unit} series={c.series} format={(v) => v.toFixed(c.digits)} />
      ))}
    </section>
  )
}

const SUMMARY: Record<ReadingKind, Metric[]> = {
  body: ['weight', 'bodyFat', 'muscleMass', 'bodyWater', 'bmi'],
  bloodPressure: ['systolic', 'diastolic', 'heartRate'],
  heartRate: ['heartRate'],
  spo2: ['spo2', 'heartRate'],
  temperature: ['temperature'],
  glucose: ['glucose'],
}

const PREFIX: Partial<Record<Metric, string>> = { muscleMass: 'muscle ', bodyWater: 'water ', bodyFat: 'fat ' }

function summarize(r: Reading, units: UnitPrefs): string {
  if (r.kind === 'bloodPressure') {
    const { systolic, diastolic, heartRate } = r.values
    return [
      systolic !== undefined && diastolic !== undefined ? `${Math.round(systolic)}/${Math.round(diastolic)} mmHg` : '',
      heartRate !== undefined ? `${Math.round(heartRate)} bpm` : '',
    ]
      .filter(Boolean)
      .join(' · ')
  }
  return SUMMARY[r.kind]
    .filter((m) => r.values[m] !== undefined)
    .map((m) => {
      const d = display(m, r.values[m]!, units)
      return m === 'bmi' ? `BMI ${d.text}` : `${PREFIX[m] ?? ''}${d.text} ${d.unit}`
    })
    .join(' · ')
}

function History({ readings, units, syncedBy }: { readings: Reading[]; units: UnitPrefs; syncedBy: Map<string, string[]> }) {
  const [limit, setLimit] = useState(50)
  return (
    <section className="card">
      <h2>History</h2>
      <table className="history">
        <thead>
          <tr>
            <th>When</th>
            <th>Type</th>
            <th>Values</th>
            <th>Source</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {readings.slice(0, limit).map((r) => (
            <tr key={r.id}>
              <td className="nowrap" title={r.deviceTime ? 'device clock' : 'time received'}>
                {new Date(r.takenAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
              </td>
              <td>{KIND_LABEL[r.kind]}</td>
              <td>
                {summarize(r, units)}
                {r.notes?.length ? <div className="small muted">{r.notes.join(', ')}</div> : null}
              </td>
              <td className="small">
                {r.device ?? r.source}
                {(syncedBy.get(r.id) ?? []).map((s) => (
                  <span key={s} className="chip tiny" title={`sent to ${s}`}>
                    {s}
                  </span>
                ))}
              </td>
              <td>
                <button className="ghost" aria-label="Delete reading" onClick={() => void deleteReading(r.id)}>
                  <TrashIcon />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {readings.length > limit && (
        <button className="ghost" onClick={() => setLimit((l) => l + 100)}>
          Show more ({readings.length - limit} hidden)
        </button>
      )}
    </section>
  )
}

const deleteReading = (id: string) => deleteReadings([id])

function relative(t: number) {
  const s = (Date.now() - t) / 1000
  if (s < 90) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  if (s < 86_400 * 14) return `${Math.round(s / 86_400)} days ago`
  return new Date(t).toLocaleDateString()
}
