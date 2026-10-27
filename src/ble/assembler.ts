// Turns the raw stream of parsed notifications into finished readings.
//  - transient values (cuff pressure, live HR) go to onLive only
//  - body-composition multi-packet parts are stitched into one reading
//  - a scale's Weight and Body Composition notifications for the same weigh-in become one reading

import type { NewReading } from '../model'
import type { Parsed } from './parsers'

export interface AssemblerOptions {
  onLive: (reading: NewReading) => void
  onFinal: (readings: NewReading[]) => void
  /** how long to wait for a scale's companion notification before saving */
  quietMs?: number
  /** body readings closer than this are the same weigh-in */
  mergeWindowMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export class ReadingAssembler {
  private partial: NewReading | null = null
  private pendingBody: NewReading[] = []
  private timer: unknown = null
  private readonly quietMs: number
  private readonly mergeWindowMs: number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly opts: AssemblerOptions

  constructor(opts: AssemblerOptions) {
    this.opts = opts
    this.quietMs = opts.quietMs ?? 1500
    this.mergeWindowMs = opts.mergeWindowMs ?? 5000
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  push(parsed: Parsed | null, continued = false) {
    if (!parsed) return
    let reading = parsed.reading
    if (parsed.transient) {
      this.opts.onLive(reading)
      return
    }
    if (this.partial) {
      // continuation packets carry their own (usually absent) timestamp; the first part's wins
      reading = { ...this.partial, values: { ...this.partial.values, ...reading.values } }
      this.partial = null
    }
    if (continued) {
      this.partial = reading
      return
    }
    this.opts.onLive(reading)
    if (reading.kind === 'body') {
      this.pendingBody.push(reading)
      this.armTimer()
    } else {
      this.opts.onFinal([reading])
    }
  }

  /** Emit everything held back (call on disconnect). */
  flush() {
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    if (this.partial) {
      this.pendingBody.push(this.partial)
      this.partial = null
    }
    if (this.pendingBody.length === 0) return
    const merged = mergeBody(this.pendingBody, this.mergeWindowMs)
    this.pendingBody = []
    this.opts.onFinal(merged)
  }

  private armTimer() {
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = this.setTimer(() => {
      this.timer = null
      this.flush()
    }, this.quietMs)
  }
}

export function mergeBody(readings: NewReading[], windowMs: number): NewReading[] {
  const sorted = [...readings].sort((a, b) => a.takenAt - b.takenAt)
  const out: NewReading[] = []
  for (const r of sorted) {
    const prev = out.at(-1)
    if (
      prev &&
      prev.deviceUser === r.deviceUser &&
      r.takenAt - prev.takenAt <= windowMs &&
      !conflicts(prev, r)
    ) {
      // prefer the device-stamped time if only one side has it
      const base = prev.deviceTime || !r.deviceTime ? prev : r
      out[out.length - 1] = {
        ...base,
        values: { ...prev.values, ...r.values },
        notes: mergeNotes(prev.notes, r.notes),
      }
    } else {
      out.push(r)
    }
  }
  return out.map(deriveFatMass)
}

// Two weigh-ins reporting clearly different weights are not the same event.
function conflicts(a: NewReading, b: NewReading) {
  const wa = a.values.weight
  const wb = b.values.weight
  return wa !== undefined && wb !== undefined && Math.abs(wa - wb) > 0.2
}

function mergeNotes(a?: string[], b?: string[]) {
  const all = [...(a ?? []), ...(b ?? [])]
  return all.length ? [...new Set(all)] : undefined
}

function deriveFatMass(r: NewReading): NewReading {
  const { weight, bodyFat, fatMass } = r.values
  if (fatMass !== undefined || weight === undefined || bodyFat === undefined) return r
  return { ...r, values: { ...r.values, fatMass: Number(((weight * bodyFat) / 100).toFixed(3)) } }
}
