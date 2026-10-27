import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { addReadings, HealthDb, markSynced, unsynced } from './db'
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
