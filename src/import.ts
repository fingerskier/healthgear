// File import: healthgear's own CSV/JSON exports, and the CSVs inside the Withings account data
// export (Withings app → Settings → Download my data), which needs no API access or membership.

import { CSV_COLUMNS } from './export'
import { addReadings, db } from './db'
import { KG_PER_LB, type NewReading, type ReadingKind, type SourceKind } from './model'

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      if (row.some((x) => x !== '')) rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  row.push(cell)
  if (row.some((x) => x !== '')) rows.push(row)
  return rows
}

const KINDS = new Set<ReadingKind>(['body', 'bloodPressure', 'heartRate', 'spo2', 'temperature', 'glucose'])
const SOURCES = new Set<SourceKind>(['ble', 'withings', 'manual', 'demo', 'import'])

function fromHealthgearCsv(rows: string[][]): NewReading[] {
  const header = rows[0]
  const col = (name: string) => header.indexOf(name)
  const metricCols = CSV_COLUMNS.map((c) => ({ idx: col(c.header), metric: c.metric }))
  return rows.slice(1).flatMap((r) => {
    const takenAt = Date.parse(r[col('timestamp')])
    const kind = r[col('kind')] as ReadingKind
    if (!Number.isFinite(takenAt) || !KINDS.has(kind)) return []
    const values: NewReading['values'] = {}
    for (const { idx, metric } of metricCols) {
      if (idx >= 0 && r[idx] !== '' && r[idx] !== undefined) values[metric] = Number(r[idx])
    }
    const source = r[col('source')] as SourceKind
    const notes = r[col('notes')]
    const user = r[col('device_user')]
    const key = col('dedupe_key') >= 0 ? r[col('dedupe_key')] : ''
    return [
      {
        kind,
        takenAt,
        deviceTime: true,
        values,
        source: SOURCES.has(source) ? source : 'import',
        device: r[col('device')] || undefined,
        deviceUser: user ? Number(user) : undefined,
        notes: notes ? notes.split('; ') : undefined,
        dedupeKey: key || undefined,
      },
    ]
  })
}

function fromHealthgearJson(json: { readings: (Omit<NewReading, 'takenAt'> & { takenAt: string })[] }): NewReading[] {
  return json.readings.flatMap((r) => {
    const takenAt = Date.parse(r.takenAt)
    if (!Number.isFinite(takenAt) || !KINDS.has(r.kind)) return []
    return [{ ...r, takenAt, source: SOURCES.has(r.source) ? r.source : 'import' }]
  })
}

/** Withings export dates are local wall-clock "YYYY-MM-DD HH:MM:SS". */
function withingsDate(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s.trim())
  if (!m) return Date.parse(s)
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)).getTime()
}

function fromWithingsCsv(rows: string[][]): NewReading[] {
  const header = rows[0].map((h) => h.toLowerCase())
  const find = (...needles: string[]) => header.findIndex((h) => needles.every((n) => h.includes(n)))
  const date = find('date')
  const lb = header.some((h) => h.includes('(lb)'))
  const mass = (v: number) => (lb ? v * KG_PER_LB : v)
  const cols = {
    weight: find('weight'),
    fatMass: find('fat mass'),
    boneMass: find('bone mass'),
    muscleMass: find('muscle mass'),
    bodyWater: find('hydration'),
    bodyFat: find('fat', '%'),
    systolic: find('systolic'),
    diastolic: find('diastolic'),
    heartRate: find('heart rate'),
  }
  const isBp = cols.systolic >= 0
  return rows.slice(1).flatMap((r) => {
    const takenAt = withingsDate(r[date] ?? '')
    if (!Number.isFinite(takenAt)) return []
    const num = (i: number) => (i >= 0 && r[i] !== '' && r[i] !== undefined ? Number(r[i]) : undefined)
    const values: NewReading['values'] = isBp
      ? { systolic: num(cols.systolic), diastolic: num(cols.diastolic), heartRate: num(cols.heartRate) }
      : {
          weight: num(cols.weight) === undefined ? undefined : mass(num(cols.weight)!),
          fatMass: num(cols.fatMass) === undefined ? undefined : mass(num(cols.fatMass)!),
          boneMass: num(cols.boneMass) === undefined ? undefined : mass(num(cols.boneMass)!),
          muscleMass: num(cols.muscleMass) === undefined ? undefined : mass(num(cols.muscleMass)!),
          bodyWater: num(cols.bodyWater) === undefined ? undefined : mass(num(cols.bodyWater)!),
          bodyFat: num(cols.bodyFat),
        }
    if (!isBp && values.bodyFat === undefined && values.fatMass !== undefined && values.weight) {
      values.bodyFat = Number(((values.fatMass / values.weight) * 100).toFixed(1))
    }
    return [{ kind: isBp ? 'bloodPressure' : 'body', takenAt, deviceTime: true, values, source: 'withings', device: 'Withings export' } satisfies NewReading]
  })
}

export function parseImport(name: string, text: string): { format: string; readings: NewReading[] } {
  const trimmed = text.replace(/^﻿/, '').trim()
  if (trimmed.startsWith('{')) {
    const json = JSON.parse(trimmed)
    if (json?.format !== 'healthgear' || !Array.isArray(json.readings)) throw new Error(`${name}: not a healthgear JSON export`)
    return { format: 'healthgear JSON', readings: fromHealthgearJson(json) }
  }
  const rows = parseCsv(trimmed)
  if (rows.length === 0) throw new Error(`${name}: empty file`)
  const header = rows[0].map((h) => h.trim().toLowerCase())
  if (header[0] === 'timestamp' && header[1] === 'kind') return { format: 'healthgear CSV', readings: fromHealthgearCsv(rows) }
  if (header[0] === 'date' && header.some((h) => /weight|systolic/.test(h))) return { format: 'Withings export', readings: fromWithingsCsv(rows) }
  throw new Error(`${name}: unrecognised CSV. Expected a healthgear export or Withings weight.csv / bp.csv`)
}

/**
 * The Withings account export has no measurement ids, so its rows can't share keys with readings
 * already pulled from the Withings API. Treat a Withings reading of the same kind in the same
 * second as the same measurement.
 */
async function dropKnownWithings(readings: NewReading[]): Promise<NewReading[]> {
  if (!readings.some((r) => r.source === 'withings' && !r.dedupeKey)) return readings
  const known = new Set((await db.readings.where('source').equals('withings').toArray()).map((r) => `${r.kind}|${Math.floor(r.takenAt / 1000)}`))
  return readings.filter((r) => r.dedupeKey || r.source !== 'withings' || !known.has(`${r.kind}|${Math.floor(r.takenAt / 1000)}`))
}

export async function importFile(file: File): Promise<{ format: string; parsed: number; added: number }> {
  const { format, readings } = parseImport(file.name, await file.text())
  const added = await addReadings(await dropKnownWithings(readings))
  return { format, parsed: readings.length, added: added.length }
}
