import { describe, expect, it } from 'vitest'
import type { Reading } from '../model'
import { buildPayload, localIso, MAX_URL_LENGTH, nextBatch, shortcutUrl } from './apple'

const reading = (i: number, extra: Partial<Reading> = {}): Reading => ({
  id: `r${i}`,
  kind: 'bloodPressure',
  takenAt: Date.UTC(2026, 9, 27, 12, 0, i),
  deviceTime: true,
  values: { systolic: 121.4, diastolic: 79.2, heartRate: 64 },
  source: 'ble',
  dedupeKey: `k${i}`,
  createdAt: 0,
  ...extra,
})

describe('Apple Shortcuts payload', () => {
  it('formats local time with a numeric offset, never Z', () => {
    expect(localIso(Date.now())).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/)
  })

  it('groups by Health type in Shortcuts units', () => {
    const p = buildPayload([
      reading(1),
      reading(2, { kind: 'body', values: { weight: 72.456, bodyFat: 21.44, height: 1.78 } }),
      reading(3, { kind: 'glucose', values: { glucose: 5.5 } }),
      reading(4, { kind: 'spo2', values: { spo2: 97, heartRate: 61 } }),
    ])
    expect(p.bloodPressure).toEqual([{ systolic: 121, diastolic: 79, date: expect.any(String) }])
    expect(p.heartRate.map((s) => s.value)).toEqual([64, 61])
    expect(p.weight[0].value).toBe(72.46)
    expect(p.bodyFat[0].value).toBe(21.4)
    expect(p.height[0].value).toBe(178)
    expect(p.glucose[0].value).toBeCloseTo(99.1, 1)
    expect(p.spo2[0].value).toBe(97)
  })

  it('encodes a URL the Shortcuts app accepts', () => {
    const url = shortcutUrl('healthgear import', buildPayload([reading(1)]))
    expect(url.startsWith('shortcuts://run-shortcut?name=healthgear%20import&input=text&text=%7B')).toBe(true)
    expect(JSON.parse(decodeURIComponent(url.split('&text=')[1])).v).toBe(1)
  })

  it('splits large backlogs into URL-sized batches, oldest first', () => {
    const many = Array.from({ length: 300 }, (_, i) => reading(i))
    const batch = nextBatch('healthgear import', many)!
    expect(batch.url.length).toBeLessThanOrEqual(MAX_URL_LENGTH)
    expect(batch.readings.length).toBeGreaterThan(10)
    expect(batch.readings.length).toBeLessThan(300)
    expect(batch.readings[0].id).toBe('r0')
  })
})
