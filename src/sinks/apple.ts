// Apple Health has no web API: HealthKit is native-only. The bridge is Apple's Shortcuts app.
// The PWA builds a JSON payload, and a user-built shortcut parses it and runs "Log Health Sample"
// for each entry. That action's Type can't come from a variable, so the payload is grouped by
// type: the shortcut gets one Repeat per type with a hard-coded Type, and no branching.
// Shortcuts can't attach sync identifiers or delete samples, so re-sending creates duplicates.

import type { Reading } from '../model'

export const DEFAULT_SHORTCUT_NAME = 'healthgear import'

export interface ApplePayload {
  v: 1
  weight: Sample[]
  bodyFat: Sample[]
  leanMass: Sample[]
  bmi: Sample[]
  height: Sample[]
  bloodPressure: { systolic: number; diastolic: number; date: string }[]
  heartRate: Sample[]
  spo2: Sample[]
  temperature: Sample[]
  glucose: Sample[]
}

interface Sample {
  value: number
  date: string
}

/** Local wall-clock ISO-8601 with offset; Shortcuts parses this as a date reliably. */
export function localIso(t: number): string {
  const d = new Date(t)
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  )
}

const r1 = (v: number) => Math.round(v * 10) / 10
const r2 = (v: number) => Math.round(v * 100) / 100

export function buildPayload(readings: Reading[]): ApplePayload {
  const p: ApplePayload = { v: 1, weight: [], bodyFat: [], leanMass: [], bmi: [], height: [], bloodPressure: [], heartRate: [], spo2: [], temperature: [], glucose: [] }
  for (const r of readings) {
    const date = localIso(r.takenAt)
    const v = r.values
    switch (r.kind) {
      case 'body':
        if (v.weight !== undefined) p.weight.push({ value: r2(v.weight), date }) // kg
        if (v.bodyFat !== undefined) p.bodyFat.push({ value: r1(v.bodyFat), date }) // %
        if (v.leanMass !== undefined) p.leanMass.push({ value: r2(v.leanMass), date }) // kg
        if (v.bmi !== undefined) p.bmi.push({ value: r1(v.bmi), date })
        if (v.height !== undefined) p.height.push({ value: Math.round(v.height * 100), date }) // cm
        break
      case 'bloodPressure':
        if (v.systolic !== undefined && v.diastolic !== undefined) p.bloodPressure.push({ systolic: Math.round(v.systolic), diastolic: Math.round(v.diastolic), date })
        if (v.heartRate !== undefined) p.heartRate.push({ value: Math.round(v.heartRate), date })
        break
      case 'heartRate':
        if (v.heartRate !== undefined) p.heartRate.push({ value: Math.round(v.heartRate), date })
        break
      case 'spo2':
        if (v.spo2 !== undefined) p.spo2.push({ value: Math.round(v.spo2), date }) // %
        if (v.heartRate !== undefined) p.heartRate.push({ value: Math.round(v.heartRate), date })
        break
      case 'temperature':
        if (v.temperature !== undefined) p.temperature.push({ value: r2(v.temperature), date }) // °C
        break
      case 'glucose':
        if (v.glucose !== undefined) p.glucose.push({ value: r1(v.glucose * 18.0156), date }) // mg/dL
        break
    }
  }
  return p
}

export function payloadSize(p: ApplePayload): number {
  return Object.values(p).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0)
}

/**
 * The payload rides in the URL (input=text) so navigation happens synchronously inside the tap;
 * an async clipboard write first can lose the user activation iOS wants. No x-success: its https
 * callback opens in a Safari tab whose storage is separate from the installed PWA's.
 */
export function shortcutUrl(name: string, payload: ApplePayload): string {
  const q = (v: string) => encodeURIComponent(v)
  return `shortcuts://run-shortcut?name=${q(name)}&input=text&text=${q(JSON.stringify(payload))}`
}

/** No documented limit on the text parameter; stay well under what iOS URL handling copes with. */
export const MAX_URL_LENGTH = 6000

/** The longest oldest-first run of readings whose launch URL fits. */
export function nextBatch(name: string, readings: Reading[]): { readings: Reading[]; url: string } | null {
  let lo = 0
  let hi = Math.min(readings.length, 200)
  let best: { readings: Reading[]; url: string } | null = null
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const slice = readings.slice(0, mid)
    const url = shortcutUrl(name, buildPayload(slice))
    if (url.length <= MAX_URL_LENGTH) {
      best = { readings: slice, url }
      lo = mid
    } else hi = mid - 1
  }
  return best
}
