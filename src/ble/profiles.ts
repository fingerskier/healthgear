// Registry of standard Bluetooth SIG health profiles we know how to read.
// A profile names a primary service, the characteristics to subscribe to, and how to parse them.

import {
  parseBloodPressure,
  parseBodyComposition,
  parseGlucose,
  parseHeartRate,
  parsePlxContinuous,
  parsePlxSpotCheck,
  parseTemperature,
  parseWeight,
  type Parsed,
} from './parsers'

export const uuid16 = (n: number) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`

export const SERVICE = {
  bloodPressure: uuid16(0x1810),
  weightScale: uuid16(0x181d),
  bodyComposition: uuid16(0x181b),
  heartRate: uuid16(0x180d),
  thermometer: uuid16(0x1809),
  pulseOximeter: uuid16(0x1822),
  glucose: uuid16(0x1808),
  currentTime: uuid16(0x1805),
  battery: uuid16(0x180f),
  deviceInformation: uuid16(0x180a),
  userData: uuid16(0x181c),
} as const

export const CHAR = {
  bloodPressureMeasurement: uuid16(0x2a35),
  intermediateCuffPressure: uuid16(0x2a36),
  weightMeasurement: uuid16(0x2a9d),
  bodyCompositionMeasurement: uuid16(0x2a9c),
  heartRateMeasurement: uuid16(0x2a37),
  temperatureMeasurement: uuid16(0x2a1c),
  intermediateTemperature: uuid16(0x2a1e),
  plxSpotCheck: uuid16(0x2a5e),
  plxContinuous: uuid16(0x2a5f),
  glucoseMeasurement: uuid16(0x2a18),
  glucoseContext: uuid16(0x2a34),
  recordAccessControlPoint: uuid16(0x2a52),
  currentTime: uuid16(0x2a2b),
  dateTime: uuid16(0x2a08),
  batteryLevel: uuid16(0x2a19),
  manufacturerName: uuid16(0x2a29),
  modelNumber: uuid16(0x2a24),
} as const

export type ParseFn = (data: DataView, ctx: { device?: string; now?: number }) => Parsed | null

export interface CharacteristicSpec {
  uuid: string
  parse: ParseFn
  /** the device can't work without it (vs. optional extras like intermediate cuff pressure) */
  required: boolean
  /** collect per-notification parts into one reading (body composition multi-packet) */
  continued?: (data: DataView) => boolean
}

export type ProfileId = 'bloodPressure' | 'weightScale' | 'bodyComposition' | 'heartRate' | 'thermometer' | 'pulseOximeter' | 'glucose'

export interface Profile {
  id: ProfileId
  label: string
  service: string
  characteristics: CharacteristicSpec[]
  /** what to tell the user to do once connected */
  hint: string
}

export const PROFILES: Profile[] = [
  {
    id: 'bloodPressure',
    label: 'Blood pressure monitor',
    service: SERVICE.bloodPressure,
    hint: 'Take a measurement. Cuffs usually send it, plus any stored readings, as soon as it finishes.',
    characteristics: [
      { uuid: CHAR.bloodPressureMeasurement, required: true, parse: (d, c) => parseBloodPressure(d, c) },
      { uuid: CHAR.intermediateCuffPressure, required: false, parse: (d, c) => parseBloodPressure(d, c, true) },
    ],
  },
  {
    id: 'weightScale',
    label: 'Weight scale',
    service: SERVICE.weightScale,
    hint: 'Step on the scale and stay still until the reading locks.',
    characteristics: [{ uuid: CHAR.weightMeasurement, required: true, parse: parseWeight }],
  },
  {
    id: 'bodyComposition',
    label: 'Body composition scale',
    service: SERVICE.bodyComposition,
    hint: 'Step on barefoot so the electrodes can measure impedance.',
    characteristics: [
      {
        uuid: CHAR.bodyCompositionMeasurement,
        required: true,
        parse: parseBodyComposition,
        continued: (d) => (d.getUint16(0, true) & 0x1000) !== 0,
      },
    ],
  },
  {
    id: 'heartRate',
    label: 'Heart rate sensor',
    service: SERVICE.heartRate,
    hint: 'Live heart rate streams while connected. Use "Save" to keep a reading.',
    characteristics: [{ uuid: CHAR.heartRateMeasurement, required: true, parse: parseHeartRate }],
  },
  {
    id: 'thermometer',
    label: 'Thermometer',
    service: SERVICE.thermometer,
    hint: 'Take a temperature; the final value is saved automatically.',
    characteristics: [
      { uuid: CHAR.temperatureMeasurement, required: true, parse: (d, c) => parseTemperature(d, c) },
      { uuid: CHAR.intermediateTemperature, required: false, parse: (d, c) => parseTemperature(d, c, true) },
    ],
  },
  {
    id: 'pulseOximeter',
    label: 'Pulse oximeter',
    service: SERVICE.pulseOximeter,
    hint: 'Spot-check readings save automatically; continuous readings stream live.',
    characteristics: [
      { uuid: CHAR.plxSpotCheck, required: false, parse: parsePlxSpotCheck },
      { uuid: CHAR.plxContinuous, required: false, parse: parsePlxContinuous },
    ],
  },
  {
    id: 'glucose',
    label: 'Glucose meter',
    service: SERVICE.glucose,
    hint: 'Stored records are requested on connect.',
    characteristics: [{ uuid: CHAR.glucoseMeasurement, required: true, parse: (d, c) => parseGlucose(d, c) }],
  },
]

export const PROFILE_SERVICES = PROFILES.map((p) => p.service)

/** Extra services we read if present; must be declared up front for Web Bluetooth to allow access. */
export const OPTIONAL_SERVICES = [SERVICE.currentTime, SERVICE.battery, SERVICE.deviceInformation, SERVICE.userData]

/** Date Time characteristic payload (0x2A08): local wall-clock time, no zone. */
export function encodeDateTime(now: Date): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(7)
  new DataView(out.buffer).setUint16(0, now.getFullYear(), true)
  out[2] = now.getMonth() + 1
  out[3] = now.getDate()
  out[4] = now.getHours()
  out[5] = now.getMinutes()
  out[6] = now.getSeconds()
  return out
}

/** Current Time characteristic payload (0x2A2B): Date Time + day of week + fractions256 + adjust reason. */
export function encodeCurrentTime(now: Date): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(10)
  out.set(encodeDateTime(now))
  out[7] = now.getDay() === 0 ? 7 : now.getDay() // 1 = Monday … 7 = Sunday
  out[8] = Math.floor((now.getMilliseconds() / 1000) * 256)
  out[9] = 0x01 // adjust reason: manual time update
  return out
}
