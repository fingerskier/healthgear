// Byte-level parsers for Bluetooth SIG health characteristics.
// References: GATT Specification Supplement (GSS) and the BLS / WSS / BCS / HRS / HTS / PLXS / GLS
// service specs. All multi-byte fields are little-endian.

import { KG_PER_LB, MGDL_PER_MMOLL, MMHG_PER_KPA, type NewReading, type Values } from '../model'
import { decodeFloat, decodeSfloat } from './ieee11073'

const IN_TO_M = 0.0254

export class ByteReader {
  private offset = 0
  private readonly view: DataView

  constructor(data: DataView | ArrayBufferView | ArrayBuffer) {
    this.view =
      data instanceof DataView
        ? data
        : data instanceof ArrayBuffer
          ? new DataView(data)
          : new DataView(data.buffer, data.byteOffset, data.byteLength)
  }

  get remaining() {
    return this.view.byteLength - this.offset
  }

  private need(n: number) {
    if (this.remaining < n) throw new RangeError(`characteristic truncated: need ${n} bytes at offset ${this.offset}`)
  }

  u8() {
    this.need(1)
    return this.view.getUint8(this.offset++)
  }

  u16() {
    this.need(2)
    const v = this.view.getUint16(this.offset, true)
    this.offset += 2
    return v
  }

  s16() {
    this.need(2)
    const v = this.view.getInt16(this.offset, true)
    this.offset += 2
    return v
  }

  u24() {
    this.need(3)
    const v = this.view.getUint16(this.offset, true) | (this.view.getUint8(this.offset + 2) << 16)
    this.offset += 3
    return v
  }

  u32() {
    this.need(4)
    const v = this.view.getUint32(this.offset, true)
    this.offset += 4
    return v
  }

  sfloat() {
    return decodeSfloat(this.u16())
  }

  float() {
    return decodeFloat(this.u32())
  }

  /** GSS "Date Time": uint16 year, then month/day/hour/minute/second. Local time, no zone. */
  dateTime(): number | undefined {
    const year = this.u16()
    const month = this.u8()
    const day = this.u8()
    const hours = this.u8()
    const minutes = this.u8()
    const seconds = this.u8()
    if (year === 0 || month === 0 || day === 0) return undefined
    return new Date(year, month - 1, day, hours, minutes, seconds).getTime()
  }
}

export interface Parsed {
  reading: NewReading
  /** true for intermediate values (live cuff pressure) that should be shown but never stored */
  transient?: boolean
}

type Ctx = { device?: string; now?: number }

function stamp(ts: number | undefined, ctx: Ctx) {
  return ts === undefined ? { takenAt: ctx.now ?? Date.now(), deviceTime: false } : { takenAt: ts, deviceTime: true }
}

const userId = (id: number | undefined) => (id === undefined || id === 0xff ? undefined : id)

// --- Blood Pressure Measurement (0x2A35) / Intermediate Cuff Pressure (0x2A36) -----------------

const BP_STATUS = [
  'body movement detected',
  'cuff fit too loose',
  'irregular pulse detected',
  null, // bits 3-4: pulse rate range, handled below
  null,
  'improper measurement position',
] as const

export function parseBloodPressure(data: DataView, ctx: Ctx = {}, intermediate = false): Parsed {
  const r = new ByteReader(data)
  const flags = r.u8()
  const kpa = (flags & 0x01) !== 0
  const scale = kpa ? MMHG_PER_KPA : 1
  const systolic = r.sfloat() * scale
  const diastolic = r.sfloat() * scale
  const meanArterial = r.sfloat() * scale
  const ts = flags & 0x02 ? r.dateTime() : undefined
  const heartRate = flags & 0x04 ? r.sfloat() : undefined
  const user = flags & 0x08 ? r.u8() : undefined
  const notes: string[] = []
  if (flags & 0x10) {
    const status = r.u16()
    BP_STATUS.forEach((label, bit) => {
      if (label && status & (1 << bit)) notes.push(label)
    })
    const range = (status >> 3) & 0x03
    if (range === 1) notes.push('pulse rate above upper limit')
    if (range === 2) notes.push('pulse rate below lower limit')
  }
  const values: Values = intermediate
    ? { systolic: round(systolic, 1) } // cuff pressure rides in the systolic field
    : { systolic: round(systolic, 1), diastolic: round(diastolic, 1), meanArterial: round(meanArterial, 1), heartRate }
  return {
    transient: intermediate,
    reading: {
      kind: 'bloodPressure',
      ...stamp(ts, ctx),
      values,
      source: 'ble',
      device: ctx.device,
      deviceUser: userId(user),
      notes: notes.length ? notes : undefined,
    },
  }
}

// --- Weight Measurement (0x2A9D) -----------------------------------------------------------------

export function parseWeight(data: DataView, ctx: Ctx = {}): Parsed | null {
  const r = new ByteReader(data)
  const flags = r.u8()
  const imperial = (flags & 0x01) !== 0
  const rawWeight = r.u16()
  const ts = flags & 0x02 ? r.dateTime() : undefined
  const user = flags & 0x04 ? r.u8() : undefined
  const values: Values = {}
  if (rawWeight === 0xffff) return null // "measurement unsuccessful"
  values.weight = imperial ? rawWeight * 0.01 * KG_PER_LB : rawWeight * 0.005
  if (flags & 0x08) {
    values.bmi = r.u16() * 0.1
    const h = r.u16()
    values.height = imperial ? h * 0.1 * IN_TO_M : h * 0.001
  }
  return { reading: { kind: 'body', ...stamp(ts, ctx), values: roundAll(values, 3), source: 'ble', device: ctx.device, deviceUser: userId(user) } }
}

// --- Body Composition Measurement (0x2A9C) -------------------------------------------------------

export interface BodyCompositionPart extends Parsed {
  /** flag bit 12: the measurement continues in the next notification */
  continued: boolean
}

export function parseBodyComposition(data: DataView, ctx: Ctx = {}): BodyCompositionPart | null {
  const r = new ByteReader(data)
  const flags = r.u16()
  const imperial = (flags & 0x0001) !== 0
  const mass = (raw: number) => (raw === 0xffff ? NaN : imperial ? raw * 0.01 * KG_PER_LB : raw * 0.005)
  const values: Values = {}
  const fat = r.u16()
  if (fat !== 0xffff) values.bodyFat = fat * 0.1
  const ts = flags & 0x0002 ? r.dateTime() : undefined
  const user = flags & 0x0004 ? r.u8() : undefined
  if (flags & 0x0008) values.basalMetabolism = r.u16()
  if (flags & 0x0010) r.u16() // muscle percentage; we store muscle mass instead
  if (flags & 0x0020) values.muscleMass = mass(r.u16())
  if (flags & 0x0040) values.leanMass = mass(r.u16()) // fat free mass
  if (flags & 0x0080) r.u16() // soft lean mass (not exported anywhere)
  if (flags & 0x0100) values.bodyWater = mass(r.u16())
  if (flags & 0x0200) values.impedance = r.u16() * 0.1
  if (flags & 0x0400) values.weight = mass(r.u16())
  if (flags & 0x0800) {
    const h = r.u16()
    values.height = imperial ? h * 0.1 * IN_TO_M : h * 0.001
  }
  if (fat === 0xffff && Object.keys(values).length === 0) return null
  if (values.weight !== undefined && values.bodyFat !== undefined && Number.isFinite(values.weight)) {
    values.fatMass = (values.weight * values.bodyFat) / 100
  }
  return {
    continued: (flags & 0x1000) !== 0,
    reading: { kind: 'body', ...stamp(ts, ctx), values: roundAll(values, 3), source: 'ble', device: ctx.device, deviceUser: userId(user) },
  }
}

// --- Heart Rate Measurement (0x2A37) -------------------------------------------------------------

export function parseHeartRate(data: DataView, ctx: Ctx = {}): Parsed {
  const r = new ByteReader(data)
  const flags = r.u8()
  const heartRate = flags & 0x01 ? r.u16() : r.u8()
  if (flags & 0x08) r.u16() // energy expended, kJ
  const values: Values = { heartRate }
  if (flags & 0x10 && r.remaining >= 2) {
    // RR intervals in 1/1024 s; keep the last one
    let last = 0
    while (r.remaining >= 2) last = r.u16()
    values.rrInterval = Math.round((last / 1024) * 1000)
  }
  // sensor contact supported (bit 2) but not detected (bit 1 clear) => no skin contact
  const notes = (flags & 0x06) === 0x04 ? ['no sensor contact'] : undefined
  return { transient: true, reading: { kind: 'heartRate', ...stamp(undefined, ctx), values, source: 'ble', device: ctx.device, notes } }
}

// --- Temperature Measurement (0x2A1C) / Intermediate Temperature (0x2A1E) ------------------------

const TEMP_TYPES = ['', 'armpit', 'body', 'ear', 'finger', 'gastro-intestinal', 'mouth', 'rectum', 'toe', 'tympanum']

export function parseTemperature(data: DataView, ctx: Ctx = {}, intermediate = false): Parsed {
  const r = new ByteReader(data)
  const flags = r.u8()
  const raw = r.float()
  const celsius = flags & 0x01 ? ((raw - 32) * 5) / 9 : raw
  const ts = flags & 0x02 ? r.dateTime() : undefined
  const type = flags & 0x04 ? TEMP_TYPES[r.u8()] : undefined
  return {
    transient: intermediate,
    reading: {
      kind: 'temperature',
      ...stamp(ts, ctx),
      values: { temperature: round(celsius, 2) },
      source: 'ble',
      device: ctx.device,
      notes: type ? [type] : undefined,
    },
  }
}

// --- PLX Spot-Check (0x2A5E) and Continuous (0x2A5F) ---------------------------------------------

export function parsePlxSpotCheck(data: DataView, ctx: Ctx = {}): Parsed {
  const r = new ByteReader(data)
  const flags = r.u8()
  const spo2 = r.sfloat()
  const heartRate = r.sfloat()
  let ts = flags & 0x01 ? r.dateTime() : undefined
  if (flags & 0x02) r.u16() // measurement status
  if (flags & 0x04) r.u24() // device and sensor status
  const pai = flags & 0x08 ? r.sfloat() : undefined
  if (flags & 0x10) ts = undefined // "device clock is not set": timestamp is meaningless
  return {
    reading: { kind: 'spo2', ...stamp(ts, ctx), values: { spo2, heartRate, perfusionIndex: pai }, source: 'ble', device: ctx.device },
  }
}

export function parsePlxContinuous(data: DataView, ctx: Ctx = {}): Parsed {
  const r = new ByteReader(data)
  r.u8() // flags: optional trailing fields we don't use
  const spo2 = r.sfloat()
  const heartRate = r.sfloat()
  return { transient: true, reading: { kind: 'spo2', ...stamp(undefined, ctx), values: { spo2, heartRate }, source: 'ble', device: ctx.device } }
}

// --- Glucose Measurement (0x2A18) ----------------------------------------------------------------

export interface GlucoseRecord extends Parsed {
  sequence: number
}

export function parseGlucose(data: DataView, ctx: Ctx = {}): GlucoseRecord | null {
  const r = new ByteReader(data)
  const flags = r.u8()
  const sequence = r.u16()
  const base = r.dateTime()
  const offsetMin = flags & 0x01 ? r.s16() : 0
  if (!(flags & 0x02)) return null // no concentration in this record
  const conc = r.sfloat()
  r.u8() // type (low nibble) / sample location (high nibble)
  // bit 2: 0 = kg/L, 1 = mol/L
  const mmolL = flags & 0x04 ? conc * 1000 : (conc * 100_000) / MGDL_PER_MMOLL
  const ts = base === undefined ? undefined : base + offsetMin * 60_000
  return {
    sequence,
    reading: {
      kind: 'glucose',
      ...stamp(ts, ctx),
      values: { glucose: round(mmolL, 2) },
      source: 'ble',
      device: ctx.device,
      // glucose meters number their records; that's a better identity than the timestamp
      dedupeKey: ctx.device ? `ble|glucose|${ctx.device}|${sequence}` : undefined,
    },
  }
}

// --- helpers --------------------------------------------------------------------------------------

function round(v: number, digits: number) {
  return Number.isFinite(v) ? Number(v.toFixed(digits)) : v
}

function roundAll(values: Values, digits: number): Values {
  const out: Values = {}
  for (const [k, v] of Object.entries(values)) out[k as keyof Values] = v === undefined ? v : round(v, digits)
  return out
}
