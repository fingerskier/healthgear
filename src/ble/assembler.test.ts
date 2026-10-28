import { describe, expect, it } from 'vitest'
import type { NewReading } from '../model'
import { mergeBody, ReadingAssembler } from './assembler'

const body = (takenAt: number, values: NewReading['values'], extra: Partial<NewReading> = {}): NewReading => ({
  kind: 'body',
  takenAt,
  deviceTime: true,
  values,
  source: 'ble',
  ...extra,
})

function harness() {
  const live: NewReading[] = []
  const final: NewReading[] = []
  let pending: (() => void) | null = null
  const asm = new ReadingAssembler({
    onLive: (r) => live.push(r),
    onFinal: (rs) => final.push(...rs),
    setTimer: (fn) => (pending = fn),
    clearTimer: () => (pending = null),
  })
  return { asm, live, final, fire: () => pending?.() }
}

describe('ReadingAssembler', () => {
  it('routes transient values to live only', () => {
    const h = harness()
    h.asm.push({ transient: true, reading: { kind: 'bloodPressure', takenAt: 1, deviceTime: false, values: { systolic: 140 }, source: 'ble' } })
    expect(h.live).toHaveLength(1)
    expect(h.final).toHaveLength(0)
  })

  it('emits non-body readings immediately', () => {
    const h = harness()
    h.asm.push({ reading: { kind: 'bloodPressure', takenAt: 1, deviceTime: true, values: { systolic: 120, diastolic: 80 }, source: 'ble' } })
    expect(h.final).toHaveLength(1)
  })

  it('merges a weigh-in arriving on two characteristics after the quiet period', () => {
    const h = harness()
    h.asm.push({ reading: body(1000, { weight: 72.5 }) })
    h.asm.push({ reading: body(1000, { bodyFat: 20 }) })
    expect(h.final).toHaveLength(0)
    h.fire()
    expect(h.final).toEqual([body(1000, { weight: 72.5, bodyFat: 20, fatMass: 14.5 }, { notes: undefined })])
  })

  it('stitches multi-packet body composition', () => {
    const h = harness()
    h.asm.push({ reading: body(5000, { bodyFat: 18 }) }, true)
    h.asm.push({ reading: body(9999, { weight: 80 }, { deviceTime: false }) }, false)
    h.asm.flush()
    expect(h.final).toHaveLength(1)
    expect(h.final[0].takenAt).toBe(5000)
    expect(h.final[0].values).toEqual({ bodyFat: 18, weight: 80, fatMass: 14.4 })
  })

  it('flush emits a dangling partial', () => {
    const h = harness()
    h.asm.push({ reading: body(1, { bodyFat: 18 }) }, true)
    h.asm.flush()
    expect(h.final).toHaveLength(1)
  })
})

describe('mergeBody', () => {
  it('keeps separate weigh-ins and separate users apart', () => {
    const out = mergeBody(
      [
        body(0, { weight: 70 }),
        body(60_000, { weight: 70.1 }),
        body(60_500, { bodyFat: 22 }, { deviceUser: 2 }),
      ],
      5000,
    )
    expect(out).toHaveLength(3)
  })

  it('refuses to merge conflicting weights inside the window', () => {
    expect(mergeBody([body(0, { weight: 70 }), body(1000, { weight: 85 })], 5000)).toHaveLength(2)
  })

  it('prefers the device timestamp', () => {
    const [m] = mergeBody([body(1000, { weight: 70 }, { deviceTime: false }), body(2000, { bodyFat: 20 })], 5000)
    expect(m.takenAt).toBe(2000)
    expect(m.deviceTime).toBe(true)
  })
})
