import { describe, expect, it } from 'vitest'
import type { NewReading } from '../model'
import { ReadingAssembler } from './assembler'
import { PROFILES } from './profiles'
import { SIMULATORS, type SimNotification } from './simulator'

const NOW = new Date(2026, 9, 27, 7, 45, 0)

function run(profileId: keyof typeof SIMULATORS, notes: SimNotification[]) {
  const profile = PROFILES.find((p) => p.id === profileId)!
  const live: NewReading[] = []
  const final: NewReading[] = []
  const asm = new ReadingAssembler({ onLive: (r) => live.push(r), onFinal: (rs) => final.push(...rs), setTimer: () => 0, clearTimer: () => {} })
  for (const n of notes) {
    // the bodyComposition simulator also emits Weight Measurement, which belongs to the weight scale profile
    const spec = [...profile.characteristics, ...PROFILES.flatMap((p) => p.characteristics)].find((c) => c.uuid === n.characteristic)!
    asm.push(spec.parse(n.data, { device: 'sim', now: NOW.getTime() }), spec.continued?.(n.data) ?? false)
  }
  asm.flush()
  return { live, final }
}

describe('simulators produce payloads our parsers accept', () => {
  it('blood pressure: live cuff pressure then one final reading', () => {
    const { live, final } = run('bloodPressure', SIMULATORS.bloodPressure!.run(NOW))
    expect(live.length).toBeGreaterThan(5)
    expect(final).toHaveLength(1)
    const v = final[0].values
    expect(v.systolic).toBeGreaterThan(100)
    expect(v.diastolic).toBeLessThan(v.systolic!)
    expect(final[0].takenAt).toBe(NOW.getTime())
  })

  it('scale: weight + body composition merge into one weigh-in', () => {
    const { final } = run('bodyComposition', SIMULATORS.bodyComposition!.run(NOW))
    expect(final).toHaveLength(1)
    expect(Object.keys(final[0].values).sort()).toEqual(
      ['bmi', 'bodyFat', 'bodyWater', 'fatMass', 'height', 'impedance', 'muscleMass', 'weight'].sort(),
    )
  })

  it('thermometer', () => {
    const { final } = run('thermometer', SIMULATORS.thermometer!.run(NOW))
    expect(final[0].values.temperature).toBeGreaterThan(36)
    expect(final[0].notes).toEqual(['mouth'])
  })

  it('pulse oximeter streams continuous values and saves the spot check', () => {
    const { live, final } = run('pulseOximeter', SIMULATORS.pulseOximeter!.run(NOW))
    expect(live.length).toBe(9)
    expect(final).toHaveLength(1)
    expect(final[0].values.spo2).toBe(97)
  })

  it('heart rate is live-only', () => {
    const { live, final } = run('heartRate', SIMULATORS.heartRate!.run(NOW))
    expect(live).toHaveLength(20)
    expect(final).toHaveLength(0)
  })
})
