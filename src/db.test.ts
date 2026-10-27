import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { addReadings, deleteReadings, HealthDb, markSynced, unsynced, upsertReadings } from './db'
import type { NewReading } from './model'

let db: HealthDb
let n = 0

beforeEach(async () => {
  db = new HealthDb(`test-${n++}`)
  await db.open()
})

const bp = (takenAt: number, systolic = 120): NewReading => ({
  kind: 'bloodPressure',
  takenAt,
  deviceTime: true,
  values: { systolic, diastolic: 80, heartRate: 62 },
  source: 'ble',
})

describe('addReadings', () => {
  it('drops duplicates within a batch and across batches', async () => {
    const first = await addReadings([bp(1_700_000_000_000), bp(1_700_000_000_000), bp(1_700_000_060_000)], db)
    expect(first).toHaveLength(2)
    // cuff re-sends its memory on reconnect
    const second = await addReadings([bp(1_700_000_000_000), bp(1_700_000_120_000)], db)
    expect(second).toHaveLength(1)
    expect(await db.readings.count()).toBe(3)
  })

  it('keeps distinct values at the same timestamp', async () => {
    const out = await addReadings([bp(1_700_000_000_000, 120), bp(1_700_000_000_000, 121)], db)
    expect(out).toHaveLength(2)
  })

  it('strips non-finite values and skips empty readings', async () => {
    const out = await addReadings(
      [
        { ...bp(1), values: { systolic: 118, diastolic: 76, meanArterial: NaN } },
        { ...bp(2), values: { systolic: NaN } },
      ],
      db,
    )
    expect(out).toHaveLength(1)
    expect(out[0].values).toEqual({ systolic: 118, diastolic: 76 })
  })

  it('rejects readings missing their essential values', async () => {
    const out = await addReadings(
      [
        { ...bp(5), values: { systolic: NaN, diastolic: 80, heartRate: 60 } }, // end-of-burst junk record
        { kind: 'spo2', takenAt: 6, deviceTime: true, values: { spo2: NaN, heartRate: 70 }, source: 'ble' },
        { kind: 'body', takenAt: 7, deviceTime: true, values: { bodyFat: 21 }, source: 'ble' },
      ],
      db,
    )
    expect(out.map((r) => r.kind)).toEqual(['body'])
  })
})

describe('sync marks', () => {
  it('reports only unsynced readings per sink', async () => {
    const [a, b] = await addReadings([bp(1000), bp(2000)], db)
    await markSynced('apple', [a.id], db)
    expect((await unsynced('apple', db)).map((r) => r.id)).toEqual([b.id])
    expect((await unsynced('googleHealth', db)).map((r) => r.id)).toEqual([a.id, b.id])
  })

  it('never offers demo readings to a sink', async () => {
    await addReadings([{ ...bp(3000), source: 'demo' }], db)
    expect(await unsynced('apple', db)).toHaveLength(0)
  })
})

describe('deletion and corrections', () => {
  it('a deleted reading is not resurrected when the device re-sends it', async () => {
    const [a] = await addReadings([bp(1_700_000_000_000)], db)
    await markSynced('apple', [a.id], db)
    await deleteReadings([a.id], db)
    expect(await db.syncs.count()).toBe(0)
    expect(await addReadings([bp(1_700_000_000_000)], db)).toHaveLength(0)
  })

  it('a changed record under the same key replaces the old one and is re-sent everywhere', async () => {
    const w = (kg: number, notes?: string[]): NewReading => ({ kind: 'body', takenAt: 1000, deviceTime: true, values: { weight: kg }, source: 'withings', dedupeKey: 'withings|7', notes })
    const [orig] = await addReadings([w(82.1, ['may belong to another user of this device'])], db)
    await markSynced('googleHealth', [orig.id], db)
    const { added, updated } = await upsertReadings([w(71.5)], db)
    expect(added).toHaveLength(0)
    expect(updated.map((r) => r.id)).toEqual([orig.id])
    expect((await db.readings.get(orig.id))!.values.weight).toBe(71.5)
    expect((await unsynced('googleHealth', db)).map((r) => r.id)).toEqual([orig.id])
    // unchanged re-sync is a no-op
    expect((await upsertReadings([w(71.5)], db)).updated).toHaveLength(0)
  })
})
