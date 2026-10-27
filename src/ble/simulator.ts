// Fake devices that emit real GATT payloads, so demo mode exercises the same parsers and assembler
// as hardware. Used on browsers without Web Bluetooth and in tests.

import { encodeSfloat } from './ieee11073'
import { CHAR, type ProfileId } from './profiles'

export interface SimNotification {
  characteristic: string
  data: DataView
  /** ms to wait after the previous notification */
  delay: number
}

function bytes(...parts: (number | number[])[]): DataView {
  return new DataView(new Uint8Array(parts.flat()).buffer)
}

const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff]

function dateTime(d: Date) {
  return [...le16(d.getFullYear()), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]
}

// Deterministic jitter so demo data looks alive without Math.random() noise in tests.
function wobble(seed: number, spread: number) {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return (x - Math.floor(x) - 0.5) * 2 * spread
}

export function simulateBloodPressure(now: Date, seed = now.getTime() / 60_000): SimNotification[] {
  const sys = Math.round(122 + wobble(seed, 9))
  const dia = Math.round(79 + wobble(seed + 1, 6))
  const map = Math.round(dia + (sys - dia) / 3)
  const pulse = Math.round(66 + wobble(seed + 2, 8))
  const out: SimNotification[] = []
  // cuff inflates to ~sys+30 then deflates, streaming intermediate pressure
  for (let p = 20; p <= sys + 30; p += 15) out.push({ characteristic: CHAR.intermediateCuffPressure, delay: 180, data: bytes(0x00, le16(p), le16(0x07ff), le16(0x07ff)) })
  for (let p = sys + 30; p >= dia - 10; p -= 6) out.push({ characteristic: CHAR.intermediateCuffPressure, delay: 220, data: bytes(0x00, le16(p), le16(0x07ff), le16(0x07ff)) })
  out.push({
    characteristic: CHAR.bloodPressureMeasurement,
    delay: 400,
    data: bytes(0x06, le16(sys), le16(dia), le16(map), dateTime(now), le16(pulse)),
  })
  return out
}

export function simulateScale(now: Date, seed = now.getTime() / 86_400_000): SimNotification[] {
  const kg = 74 + wobble(seed, 1.5)
  const out: SimNotification[] = []
  // settling: weight without timestamp isn't stored by real scales until stable; we just stream the final
  out.push({
    characteristic: CHAR.weightMeasurement,
    delay: 1200,
    data: bytes(0x0a, le16(Math.round(kg / 0.005)), dateTime(now), le16(Math.round((kg / 1.78 ** 2) * 10)), le16(1780)),
  })
  const fat = 21 + wobble(seed + 3, 2)
  const flags = 0x0002 | 0x0020 | 0x0100 | 0x0200
  out.push({
    characteristic: CHAR.bodyCompositionMeasurement,
    delay: 300,
    data: bytes(
      le16(flags),
      le16(Math.round(fat * 10)),
      dateTime(now),
      le16(Math.round((kg * 0.42) / 0.005)),
      le16(Math.round((kg * 0.55) / 0.005)),
      le16(Math.round((480 + wobble(seed + 4, 30)) * 10)),
    ),
  })
  return out
}

export function simulateThermometer(now: Date, seed = now.getTime() / 60_000): SimNotification[] {
  const c = 36.7 + wobble(seed, 0.3)
  const mantissa = Math.round(c * 100)
  const exp = 0xfe
  const view = new DataView(new ArrayBuffer(13))
  view.setUint8(0, 0x06)
  view.setUint32(1, ((exp << 24) | (mantissa & 0xffffff)) >>> 0, true)
  dateTime(now).forEach((b, i) => view.setUint8(5 + i, b))
  view.setUint8(12, 0x06) // mouth
  return [{ characteristic: CHAR.temperatureMeasurement, delay: 2500, data: view }]
}

export function simulatePulseOximeter(now: Date, seed = now.getTime() / 1000): SimNotification[] {
  const out: SimNotification[] = []
  for (let i = 0; i < 8; i++) {
    out.push({
      characteristic: CHAR.plxContinuous,
      delay: 500,
      data: bytes(0x00, le16(encodeSfloat(Math.round(97 + wobble(seed + i, 1.5)), 0)), le16(encodeSfloat(Math.round(68 + wobble(seed + i + 50, 4)), 0))),
    })
  }
  out.push({
    characteristic: CHAR.plxSpotCheck,
    delay: 500,
    data: bytes(0x01, le16(97), le16(67), dateTime(now)),
  })
  return out
}

export function simulateHeartRate(now: Date, count = 20, seed = now.getTime() / 1000): SimNotification[] {
  return Array.from({ length: count }, (_, i) => ({
    characteristic: CHAR.heartRateMeasurement,
    delay: 1000,
    data: bytes(0x06, Math.round(72 + wobble(seed + i, 6))),
  }))
}

export const SIMULATORS: Partial<Record<ProfileId, { label: string; run: (now: Date) => SimNotification[] }>> = {
  bloodPressure: { label: 'Demo blood pressure cuff', run: simulateBloodPressure },
  bodyComposition: { label: 'Demo body composition scale', run: simulateScale },
  thermometer: { label: 'Demo thermometer', run: simulateThermometer },
  pulseOximeter: { label: 'Demo pulse oximeter', run: simulatePulseOximeter },
  heartRate: { label: 'Demo heart rate strap', run: (now) => simulateHeartRate(now) },
}
