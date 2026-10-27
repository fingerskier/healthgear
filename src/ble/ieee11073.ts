// IEEE-11073-20601 numeric formats used by the Bluetooth SIG health profiles.
// SFLOAT: 16 bits, 4-bit signed exponent + 12-bit signed mantissa.
// FLOAT:  32 bits, 8-bit signed exponent + 24-bit signed mantissa.
// Special values decode to NaN / ±Infinity; callers treat non-finite as "absent".

const SFLOAT_SPECIAL: Record<number, number> = {
  0x07ff: NaN, // NaN
  0x0800: NaN, // NRes (not at this resolution)
  0x07fe: Infinity,
  0x0802: -Infinity,
  0x0801: NaN, // reserved
}

const FLOAT_SPECIAL: Record<number, number> = {
  0x007fffff: NaN,
  0x00800000: NaN,
  0x007ffffe: Infinity,
  0x00800002: -Infinity,
  0x00800001: NaN,
}

export function decodeSfloat(raw: number): number {
  const mantissaBits = raw & 0x0fff
  if (raw >> 12 === 0 && mantissaBits in SFLOAT_SPECIAL) return SFLOAT_SPECIAL[mantissaBits]
  let mantissa = mantissaBits
  if (mantissa >= 0x0800) mantissa -= 0x1000
  let exponent = raw >> 12
  if (exponent >= 0x8) exponent -= 0x10
  return round(mantissa * 10 ** exponent, exponent)
}

export function decodeFloat(raw: number): number {
  const mantissaBits = raw & 0x00ffffff
  const expByte = (raw >>> 24) & 0xff
  if (expByte === 0 && mantissaBits in FLOAT_SPECIAL) return FLOAT_SPECIAL[mantissaBits]
  let mantissa = mantissaBits
  if (mantissa >= 0x00800000) mantissa -= 0x01000000
  const exponent = expByte >= 0x80 ? expByte - 0x100 : expByte
  return round(mantissa * 10 ** exponent, exponent)
}

// Strip binary floating-point noise (e.g. 1209 * 10^-1 = 120.89999999999999).
function round(value: number, exponent: number): number {
  return exponent < 0 ? Number(value.toFixed(-exponent)) : value
}

export function encodeSfloat(value: number, exponent: number): number {
  const mantissa = Math.round(value / 10 ** exponent)
  if (mantissa < -2046 || mantissa > 2045) throw new RangeError(`SFLOAT mantissa out of range: ${mantissa}`)
  return ((exponent & 0x0f) << 12) | (mantissa & 0x0fff)
}

export function encodeFloat(value: number, exponent: number): number {
  const mantissa = Math.round(value / 10 ** exponent)
  if (mantissa < -8388606 || mantissa > 8388605) throw new RangeError(`FLOAT mantissa out of range: ${mantissa}`)
  return (((exponent & 0xff) << 24) | (mantissa & 0x00ffffff)) >>> 0
}
