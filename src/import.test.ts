import { describe, expect, it } from 'vitest'
import { toCsv, toJson } from './export'
import { parseCsv, parseImport } from './import'
import type { Reading } from './model'

const r = (extra: Partial<Reading>): Reading => ({
  id: 'x',
  kind: 'bloodPressure',
  takenAt: Date.UTC(2026, 9, 1, 8, 0, 0),
  deviceTime: true,
  values: { systolic: 120, diastolic: 80, heartRate: 60 },
  source: 'ble',
  device: 'Cuff, "v2"',
  dedupeKey: 'k',
  createdAt: 0,
  notes: ['irregular pulse detected'],
  ...extra,
})

describe('CSV', () => {
  it('parses quotes, escaped quotes, CRLF and blank lines', () => {
    expect(parseCsv('a,"b,c","d ""e"""\r\n\r\n1,2,3\n')).toEqual([
      ['a', 'b,c', 'd "e"'],
      ['1', '2', '3'],
    ])
  })

  it('round-trips a healthgear CSV export without losing integers', () => {
    const readings = [r({}), r({ kind: 'body', values: { weight: 72.5, bodyFat: 20 }, notes: undefined, device: undefined })]
    const csv = toCsv(readings)
    expect(csv).toContain(',120,80,')
    const { format, readings: back } = parseImport('x.csv', csv)
    expect(format).toBe('healthgear CSV')
    expect(back[0]).toMatchObject({ kind: 'bloodPressure', values: { systolic: 120, diastolic: 80, heartRate: 60 }, device: 'Cuff, "v2"', notes: ['irregular pulse detected'] })
    expect(back[1].values).toEqual({ weight: 72.5, bodyFat: 20 })
    expect(back[0].takenAt).toBe(readings[0].takenAt)
  })

  it('round-trips JSON', () => {
    const { readings } = parseImport('x.json', toJson([r({})]))
    expect(readings[0].values.systolic).toBe(120)
    expect(readings[0].dedupeKey).toBe('k')
  })

  it('keeps identity and full precision so a restore adds nothing new', () => {
    const stored = [
      r({ kind: 'glucose', values: { glucose: 5.55 }, dedupeKey: 'ble|glucose|Meter|7', notes: undefined }),
      r({ kind: 'body', values: { weight: 72.5747792 }, dedupeKey: 'manual|body|1|...', source: 'manual', notes: undefined }),
      r({ kind: 'body', values: { weight: 72.345 }, dedupeKey: 'withings|123', source: 'withings', notes: undefined }),
    ]
    for (const text of [toCsv(stored), toJson(stored)]) {
      const back = parseImport('backup', text).readings
      expect(back.map((x) => x.dedupeKey)).toEqual(stored.map((x) => x.dedupeKey))
      expect(back.map((x) => x.values)).toEqual(stored.map((x) => x.values))
    }
  })
})

describe('Withings data export', () => {
  it('reads weight.csv, deriving body fat %', () => {
    const csv = 'Date,"Weight (kg)","Fat mass (kg)","Bone mass (kg)","Muscle mass (kg)","Hydration (kg)",Comments\n"2026-10-26 07:41:12",80,16,3.1,60.2,45,\n'
    const { format, readings } = parseImport('weight.csv', csv)
    expect(format).toBe('Withings export')
    expect(readings[0]).toMatchObject({ kind: 'body', source: 'withings' })
    expect(readings[0].values).toMatchObject({ weight: 80, fatMass: 16, bodyFat: 20, boneMass: 3.1, muscleMass: 60.2, bodyWater: 45 })
    expect(readings[0].takenAt).toBe(new Date(2026, 9, 26, 7, 41, 12).getTime())
  })

  it('reads bp.csv', () => {
    const { readings } = parseImport('bp.csv', 'Date,"Heart rate",Systolic,Diastolic,Comments\n"2026-10-26 08:00:00",62,118,77,\n')
    expect(readings[0]).toMatchObject({ kind: 'bloodPressure', values: { systolic: 118, diastolic: 77, heartRate: 62 } })
  })

  it('converts pounds', () => {
    const { readings } = parseImport('weight.csv', 'Date,"Weight (lb)"\n2026-10-26 07:41:12,176.37\n')
    expect(readings[0].values.weight).toBeCloseTo(80, 2)
  })

  it('rejects unknown files', () => {
    expect(() => parseImport('x.csv', 'foo,bar\n1,2')).toThrow(/unrecognised/)
  })
})
