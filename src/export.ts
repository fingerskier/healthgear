// File exports: the escape hatch that works with every platform, including ones without APIs.

import { METRICS, type Metric, type Reading } from './model'

export const CSV_COLUMNS: { metric: Metric; header: string }[] = [
  { metric: 'weight', header: 'weight_kg' },
  { metric: 'bmi', header: 'bmi' },
  { metric: 'height', header: 'height_m' },
  { metric: 'bodyFat', header: 'body_fat_pct' },
  { metric: 'fatMass', header: 'fat_mass_kg' },
  { metric: 'leanMass', header: 'lean_mass_kg' },
  { metric: 'muscleMass', header: 'muscle_mass_kg' },
  { metric: 'boneMass', header: 'bone_mass_kg' },
  { metric: 'bodyWater', header: 'body_water_kg' },
  { metric: 'basalMetabolism', header: 'basal_metabolism_kj' },
  { metric: 'impedance', header: 'impedance_ohm' },
  { metric: 'systolic', header: 'systolic_mmhg' },
  { metric: 'diastolic', header: 'diastolic_mmhg' },
  { metric: 'meanArterial', header: 'mean_arterial_mmhg' },
  { metric: 'heartRate', header: 'heart_rate_bpm' },
  { metric: 'rrInterval', header: 'rr_interval_ms' },
  { metric: 'spo2', header: 'spo2_pct' },
  { metric: 'perfusionIndex', header: 'perfusion_index_pct' },
  { metric: 'temperature', header: 'temperature_c' },
  { metric: 'glucose', header: 'glucose_mmol_l' },
]

function csvCell(v: string) {
  return /[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v
}

export const CSV_HEADER = ['timestamp', 'kind', 'source', 'device', 'device_user', ...CSV_COLUMNS.map((c) => c.header), 'notes']

export function toCsvRow(r: Reading): string[] {
  return [
    new Date(r.takenAt).toISOString(),
    r.kind,
    r.source,
    r.device ?? '',
    r.deviceUser?.toString() ?? '',
    ...CSV_COLUMNS.map((c) => {
      const v = r.values[c.metric]
      return v === undefined ? '' : String(Number(v.toFixed(Math.max(METRICS[c.metric].digits, 1))))
    }),
    (r.notes ?? []).join('; '),
  ]
}

export function toCsv(readings: Reading[]): string {
  return [CSV_HEADER, ...readings.map(toCsvRow)].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

export function toJson(readings: Reading[]): string {
  return JSON.stringify(
    {
      format: 'healthgear',
      version: 1,
      exportedAt: new Date().toISOString(),
      units: Object.fromEntries(Object.entries(METRICS).map(([k, m]) => [k, m.unit])),
      readings: readings.map(({ id, kind, takenAt, deviceTime, values, source, device, deviceUser, notes }) => ({
        id,
        kind,
        takenAt: new Date(takenAt).toISOString(),
        deviceTime,
        values,
        source,
        device,
        deviceUser,
        notes,
      })),
    },
    null,
    2,
  )
}

export function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
