// Canonical data model. Every adapter (BLE profile, cloud import, manual entry) converts into
// these units; every sink (export, platform push) converts out of them. Never store device units.

export const METRICS = {
  weight: { label: 'Weight', unit: 'kg', digits: 2 },
  bmi: { label: 'BMI', unit: 'kg/m²', digits: 1 },
  height: { label: 'Height', unit: 'm', digits: 3 },
  bodyFat: { label: 'Body fat', unit: '%', digits: 1 },
  fatMass: { label: 'Fat mass', unit: 'kg', digits: 2 },
  leanMass: { label: 'Lean mass', unit: 'kg', digits: 2 },
  muscleMass: { label: 'Muscle mass', unit: 'kg', digits: 2 },
  boneMass: { label: 'Bone mass', unit: 'kg', digits: 2 },
  bodyWater: { label: 'Body water', unit: 'kg', digits: 2 },
  basalMetabolism: { label: 'Basal metabolism', unit: 'kJ', digits: 0 },
  impedance: { label: 'Impedance', unit: 'Ω', digits: 1 },
  systolic: { label: 'Systolic', unit: 'mmHg', digits: 0 },
  diastolic: { label: 'Diastolic', unit: 'mmHg', digits: 0 },
  meanArterial: { label: 'Mean arterial', unit: 'mmHg', digits: 0 },
  heartRate: { label: 'Heart rate', unit: 'bpm', digits: 0 },
  rrInterval: { label: 'RR interval', unit: 'ms', digits: 0 },
  spo2: { label: 'SpO₂', unit: '%', digits: 0 },
  perfusionIndex: { label: 'Perfusion index', unit: '%', digits: 1 },
  temperature: { label: 'Temperature', unit: '°C', digits: 2 },
  glucose: { label: 'Glucose', unit: 'mmol/L', digits: 1 },
} as const

export type Metric = keyof typeof METRICS
export type Values = Partial<Record<Metric, number>>

export type ReadingKind = 'body' | 'bloodPressure' | 'heartRate' | 'spo2' | 'temperature' | 'glucose'

export type SourceKind = 'ble' | 'withings' | 'manual' | 'demo' | 'import'

export interface Reading {
  id: string
  kind: ReadingKind
  /** epoch ms when the measurement was taken (device clock if it sent one, else receipt time) */
  takenAt: number
  /** true when takenAt came from the device rather than our clock */
  deviceTime: boolean
  values: Values
  source: SourceKind
  /** human-facing device label, e.g. "A&D UA-651BLE" */
  device?: string
  /** stable per-source identity of the measurement, used to drop duplicates on re-sync */
  dedupeKey: string
  /** multi-user devices (scales, cuffs) report a user slot */
  deviceUser?: number
  /** free-form flags from the device (e.g. "irregular pulse", "cuff loose") */
  notes?: string[]
  createdAt: number
}

export type NewReading = Omit<Reading, 'id' | 'createdAt' | 'dedupeKey'> & { dedupeKey?: string }

const KIND_METRICS: Record<ReadingKind, Metric[]> = {
  body: ['weight', 'bmi', 'height', 'bodyFat', 'fatMass', 'leanMass', 'muscleMass', 'boneMass', 'bodyWater', 'basalMetabolism', 'impedance'],
  bloodPressure: ['systolic', 'diastolic', 'meanArterial', 'heartRate'],
  heartRate: ['heartRate', 'rrInterval'],
  spo2: ['spo2', 'heartRate', 'perfusionIndex'],
  temperature: ['temperature'],
  glucose: ['glucose'],
}

export function metricsFor(kind: ReadingKind): Metric[] {
  return KIND_METRICS[kind]
}

/** Drop NaN/Infinity (IEEE-11073 special values) and anything not belonging to the kind. */
export function cleanValues(kind: ReadingKind, values: Values): Values {
  const allowed = new Set(KIND_METRICS[kind])
  const out: Values = {}
  for (const [k, v] of Object.entries(values) as [Metric, number | undefined][]) {
    if (v !== undefined && Number.isFinite(v) && allowed.has(k)) out[k] = v
  }
  return out
}

/**
 * Two readings of the same kind, from the same source, taken in the same second with the same
 * values are the same measurement. Devices re-send stored records on every connect; Withings
 * re-returns history on every fetch. Rounding to the second absorbs clock-format jitter.
 */
export function dedupeKeyFor(r: Pick<Reading, 'kind' | 'source' | 'takenAt' | 'values'> & { deviceUser?: number }): string {
  const vals = Object.keys(r.values)
    .sort()
    .map((k) => `${k}=${r.values[k as Metric]}`)
    .join(',')
  return `${r.source}|${r.kind}|${Math.floor(r.takenAt / 1000)}|${r.deviceUser ?? ''}|${vals}`
}

export function formatValue(metric: Metric, value: number): string {
  return value.toFixed(METRICS[metric].digits)
}

export const KG_PER_LB = 0.45359237
export const MMHG_PER_KPA = 7.50061683
export const MGDL_PER_MMOLL = 18.0156
