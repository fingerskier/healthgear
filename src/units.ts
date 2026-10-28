import { KG_PER_LB, METRICS, MGDL_PER_MMOLL, type Metric } from './model'

export interface UnitPrefs {
  mass: 'kg' | 'lb' | 'st'
  temperature: 'C' | 'F'
  glucose: 'mmol/L' | 'mg/dL'
  length: 'm' | 'in'
}

export const DEFAULT_UNITS: UnitPrefs = guessUnits()

function guessUnits(): UnitPrefs {
  const locale = typeof navigator === 'undefined' ? 'en-US' : navigator.language
  const us = /-(US|LR|MM)$/i.test(locale)
  const uk = /-GB$/i.test(locale)
  return {
    mass: us ? 'lb' : uk ? 'st' : 'kg',
    temperature: us ? 'F' : 'C',
    glucose: us ? 'mg/dL' : 'mmol/L',
    length: us ? 'in' : 'm',
  }
}

const MASS_METRICS = new Set<Metric>(['weight', 'fatMass', 'leanMass', 'muscleMass', 'boneMass', 'bodyWater'])

export interface Display {
  value: number
  unit: string
  text: string
}

/** Convert a canonical value for display. Stone is shown as decimal stone (st) for simplicity. */
export function display(metric: Metric, canonical: number, prefs: UnitPrefs): Display {
  let value = canonical
  let unit: string = METRICS[metric].unit
  let digits: number = METRICS[metric].digits
  if (MASS_METRICS.has(metric) && prefs.mass !== 'kg') {
    value = canonical / KG_PER_LB
    unit = 'lb'
    digits = 1
    if (prefs.mass === 'st') {
      value /= 14
      unit = 'st'
      digits = 2
    }
  } else if (metric === 'temperature' && prefs.temperature === 'F') {
    value = (canonical * 9) / 5 + 32
    unit = '°F'
    digits = 1
  } else if (metric === 'glucose' && prefs.glucose === 'mg/dL') {
    value = canonical * MGDL_PER_MMOLL
    unit = 'mg/dL'
    digits = 0
  } else if (metric === 'height' && prefs.length === 'in') {
    value = canonical / 0.0254
    unit = 'in'
    digits = 1
  } else if (metric === 'weight' || MASS_METRICS.has(metric)) {
    digits = 1
  }
  return { value, unit, text: value.toFixed(digits) }
}

/** Inverse of display(): parse what a user typed in their display unit back to canonical. */
export function fromDisplay(metric: Metric, shown: number, prefs: UnitPrefs): number {
  if (MASS_METRICS.has(metric) && prefs.mass !== 'kg') return (prefs.mass === 'st' ? shown * 14 : shown) * KG_PER_LB
  if (metric === 'temperature' && prefs.temperature === 'F') return ((shown - 32) * 5) / 9
  if (metric === 'glucose' && prefs.glucose === 'mg/dL') return shown / MGDL_PER_MMOLL
  if (metric === 'height' && prefs.length === 'in') return shown * 0.0254
  return shown
}

export function unitLabel(metric: Metric, prefs: UnitPrefs): string {
  return display(metric, 0, prefs).unit
}
