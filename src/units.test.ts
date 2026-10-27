import { describe, expect, it } from 'vitest'
import { display, fromDisplay, type UnitPrefs } from './units'

const metric: UnitPrefs = { mass: 'kg', temperature: 'C', glucose: 'mmol/L', length: 'm' }
const us: UnitPrefs = { mass: 'lb', temperature: 'F', glucose: 'mg/dL', length: 'in' }

describe('display units', () => {
  it('converts mass', () => {
    expect(display('weight', 72.5, us).text).toBe('159.8')
    expect(display('weight', 72.5, { ...metric, mass: 'st' }).text).toBe('11.42')
    expect(display('weight', 72.5, metric)).toMatchObject({ text: '72.5', unit: 'kg' })
  })

  it('converts temperature and glucose', () => {
    expect(display('temperature', 37, us).text).toBe('98.6')
    expect(display('glucose', 5.55, us).text).toBe('100')
  })

  it('leaves BP and percentages alone', () => {
    expect(display('systolic', 121, us).text).toBe('121')
    expect(display('bodyFat', 21.46, us).text).toBe('21.5')
  })

  it('round-trips user input', () => {
    for (const [m, v] of [['weight', 72.5], ['temperature', 36.6], ['glucose', 5.5], ['height', 1.8]] as const) {
      expect(fromDisplay(m, display(m, v, us).value, us)).toBeCloseTo(v, 6)
    }
  })
})
