import { describe, expect, it } from 'vitest'
import {
  parseBloodPressure,
  parseBodyComposition,
  parseGlucose,
  parseHeartRate,
  parsePlxSpotCheck,
  parseTemperature,
  parseWeight,
} from './parsers'

const dv = (...bytes: number[]) => new DataView(new Uint8Array(bytes).buffer)
const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff]
const dateTime = (y: number, mo: number, d: number, h: number, mi: number, s: number) => [...le16(y), mo, d, h, mi, s]
const NOW = 1_800_000_000_000
const ctx = { device: 'test', now: NOW }

describe('Blood Pressure Measurement', () => {
  it('parses mmHg with timestamp, pulse, user and status', () => {
    const bytes = dv(
      0x1e, // timestamp | pulse | user | status
      ...le16(0x0079), // 121
      ...le16(0x004f), // 79
      ...le16(0x005d), // 93
      ...dateTime(2026, 10, 27, 8, 30, 15),
      ...le16(0x0040), // 64 bpm
      0x01,
      ...le16(0b0000_0100), // irregular pulse
    )
    const { reading, transient } = parseBloodPressure(bytes, ctx)
    expect(transient).toBe(false)
    expect(reading.values).toEqual({ systolic: 121, diastolic: 79, meanArterial: 93, heartRate: 64 })
    expect(reading.takenAt).toBe(new Date(2026, 9, 27, 8, 30, 15).getTime())
    expect(reading.deviceTime).toBe(true)
    expect(reading.deviceUser).toBe(1)
    expect(reading.notes).toEqual(['irregular pulse detected'])
  })

  it('converts kPa to mmHg', () => {
    // 16.0 kPa = mantissa 160, exp -1 => 0xF0A0
    const { reading } = parseBloodPressure(dv(0x01, ...le16(0xf0a0), ...le16(0xf06b), ...le16(0xf07d)), ctx)
    expect(reading.values.systolic).toBeCloseTo(120.0, 0)
    expect(reading.values.diastolic).toBeCloseTo(80.3, 0)
  })

  it('falls back to receipt time and maps unknown user 0xFF to undefined', () => {
    const { reading } = parseBloodPressure(dv(0x08, ...le16(120), ...le16(80), ...le16(93), 0xff), ctx)
    expect(reading.takenAt).toBe(NOW)
    expect(reading.deviceTime).toBe(false)
    expect(reading.deviceUser).toBeUndefined()
  })

  it('reports pulse-rate range from status bits 3-4', () => {
    const { reading } = parseBloodPressure(dv(0x10, ...le16(120), ...le16(80), ...le16(93), ...le16(0b01_000)), ctx)
    expect(reading.notes).toEqual(['pulse rate above upper limit'])
  })

  it('marks intermediate cuff pressure as transient', () => {
    const { reading, transient } = parseBloodPressure(dv(0x00, ...le16(150), ...le16(0x07ff), ...le16(0x07ff)), ctx, true)
    expect(transient).toBe(true)
    expect(reading.values).toEqual({ systolic: 150 })
  })

  it('throws on a truncated payload', () => {
    expect(() => parseBloodPressure(dv(0x02, ...le16(120), ...le16(80), ...le16(93), 0xea), ctx)).toThrow(RangeError)
  })
})

describe('Weight Measurement', () => {
  it('parses SI weight with BMI and height', () => {
    // 72.5 kg / 0.005 = 14500; BMI 23.7 => 237; height 1.75 m => 1750
    const { reading } = parseWeight(dv(0x08, ...le16(14500), ...le16(237), ...le16(1750)), ctx)!
    expect(reading.values).toEqual({ weight: 72.5, bmi: 23.7, height: 1.75 })
  })

  it('parses imperial weight with timestamp and user', () => {
    // 160.00 lb => 16000 @ 0.01 lb
    const { reading } = parseWeight(dv(0x07, ...le16(16000), ...dateTime(2026, 1, 2, 3, 4, 5), 0x02), ctx)!
    expect(reading.values.weight).toBeCloseTo(72.575, 3)
    expect(reading.deviceUser).toBe(2)
    expect(reading.deviceTime).toBe(true)
  })

  it('returns null for an unsuccessful measurement', () => {
    expect(parseWeight(dv(0x00, 0xff, 0xff), ctx)).toBeNull()
  })
})

describe('Body Composition Measurement', () => {
  it('parses fat %, muscle, water, impedance, weight, and derives fat mass', () => {
    const flags = 0x0020 | 0x0100 | 0x0200 | 0x0400
    const { reading, continued } = parseBodyComposition(
      dv(
        ...le16(flags),
        ...le16(215), // 21.5 %
        ...le16(11000), // muscle 55 kg
        ...le16(8000), // water 40 kg
        ...le16(5005), // 500.5 ohm
        ...le16(14500), // 72.5 kg
      ),
      ctx,
    )!
    expect(continued).toBe(false)
    expect(reading.values).toEqual({
      bodyFat: 21.5,
      muscleMass: 55,
      bodyWater: 40,
      impedance: 500.5,
      weight: 72.5,
      fatMass: 15.588,
    })
  })

  it('flags multi-packet measurements', () => {
    const part = parseBodyComposition(dv(...le16(0x1000), ...le16(200)), ctx)!
    expect(part.continued).toBe(true)
    expect(part.reading.values.bodyFat).toBe(20)
  })
})

describe('Heart Rate Measurement', () => {
  it('parses uint8 HR', () => {
    expect(parseHeartRate(dv(0x00, 72), ctx).reading.values).toEqual({ heartRate: 72 })
  })

  it('parses uint16 HR, energy, and RR intervals', () => {
    const { reading } = parseHeartRate(dv(0x19, ...le16(180), ...le16(10), ...le16(1024), ...le16(512)), ctx)
    expect(reading.values).toEqual({ heartRate: 180, rrInterval: 500 })
  })

  it('notes missing sensor contact', () => {
    expect(parseHeartRate(dv(0x04, 0), ctx).reading.notes).toEqual(['no sensor contact'])
  })
})

describe('Temperature Measurement', () => {
  it('parses Celsius FLOAT with type', () => {
    const { reading } = parseTemperature(dv(0x04, 0x4c, 0x0e, 0x00, 0xfe, 0x06), ctx)
    expect(reading.values.temperature).toBe(36.6)
    expect(reading.notes).toEqual(['mouth'])
  })

  it('converts Fahrenheit', () => {
    // 98.6 F => mantissa 986, exp -1
    const { reading } = parseTemperature(dv(0x01, 0xda, 0x03, 0x00, 0xff), ctx)
    expect(reading.values.temperature).toBe(37)
  })
})

describe('PLX Spot-Check', () => {
  it('parses SpO2 and pulse; discards timestamp when device clock is unset', () => {
    const { reading } = parsePlxSpotCheck(dv(0x11, ...le16(97), ...le16(65), ...dateTime(2000, 1, 1, 0, 0, 0)), ctx)
    expect(reading.values).toEqual({ spo2: 97, heartRate: 65, perfusionIndex: undefined })
    expect(reading.takenAt).toBe(NOW)
  })
})

describe('Glucose Measurement', () => {
  it('converts kg/L to mmol/L and applies time offset', () => {
    // 100 mg/dL = 0.001 kg/L => mantissa 100, exp -5 => 0xB064
    const rec = parseGlucose(dv(0x03, ...le16(7), ...dateTime(2026, 5, 6, 7, 0, 0), ...le16(15), ...le16(0xb064), 0x11), ctx)!
    expect(rec.sequence).toBe(7)
    expect(rec.reading.values.glucose).toBeCloseTo(5.55, 2)
    expect(rec.reading.takenAt).toBe(new Date(2026, 4, 6, 7, 15, 0).getTime())
    expect(rec.reading.dedupeKey).toBe('ble|glucose|test|7')
  })

  it('converts mol/L', () => {
    // 5.5 mmol/L = 0.0055 mol/L => mantissa 55, exp -4 => 0xC037
    const rec = parseGlucose(dv(0x06, ...le16(1), ...dateTime(2026, 5, 6, 7, 0, 0), ...le16(0xc037), 0x11), ctx)!
    expect(rec.reading.values.glucose).toBe(5.5)
  })
})
