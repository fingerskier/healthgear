import { describe, expect, it } from 'vitest'
import { decodeFloat, decodeSfloat, encodeFloat, encodeSfloat } from './ieee11073'

describe('SFLOAT', () => {
  it('decodes positive exponent-0 values', () => {
    expect(decodeSfloat(0x0078)).toBe(120) // 120 mmHg
  })

  it('decodes negative exponents without float noise', () => {
    // mantissa 1209, exponent -1 => 120.9
    expect(decodeSfloat(0xf4b9)).toBe(120.9)
  })

  it('decodes negative mantissas', () => {
    expect(decodeSfloat(0x0fff)).toBe(-1)
  })

  it('maps special values', () => {
    expect(decodeSfloat(0x07ff)).toBeNaN()
    expect(decodeSfloat(0x0800)).toBeNaN()
    expect(decodeSfloat(0x0801)).toBeNaN()
    expect(decodeSfloat(0x07fe)).toBe(Infinity)
    expect(decodeSfloat(0x0802)).toBe(-Infinity)
  })

  it('round-trips through encode', () => {
    for (const [v, e] of [[120, 0], [80.5, -1], [36.6, -1], [-12, 0], [1.23, -2]] as const) {
      expect(decodeSfloat(encodeSfloat(v, e))).toBe(v)
    }
  })

  it('rejects mantissas that collide with special values', () => {
    expect(() => encodeSfloat(2047, 0)).toThrow(RangeError)
  })
})

describe('FLOAT', () => {
  it('decodes a thermometer reading', () => {
    // 3660 * 10^-2 = 36.6 C; exponent byte 0xFE, mantissa 0x000E4C
    expect(decodeFloat(0xfe000e4c)).toBe(36.6)
  })

  it('maps special values', () => {
    expect(decodeFloat(0x007fffff)).toBeNaN()
    expect(decodeFloat(0x007ffffe)).toBe(Infinity)
    expect(decodeFloat(0x00800002)).toBe(-Infinity)
  })

  it('round-trips through encode', () => {
    for (const [v, e] of [[36.6, -1], [98.6, -1], [-40, 0], [37.25, -2]] as const) {
      expect(decodeFloat(encodeFloat(v, e))).toBe(v)
    }
  })
})
