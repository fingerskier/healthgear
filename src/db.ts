import Dexie, { type EntityTable } from 'dexie'
import { dedupeKeyFor, cleanValues, type NewReading, type Reading } from './model'

export type SinkId = 'googleHealth' | 'googleSheets' | 'apple'

export interface SyncMark {
  /** `${sink}:${readingId}` */
  key: string
  sink: SinkId
  readingId: string
  at: number
  remoteId?: string
}

export interface KnownDevice {
  /** Web Bluetooth device.id (stable per origin once permission is granted) */
  id: string
  name: string
  profile: string
  lastSeen: number
}

export interface Setting {
  key: string
  value: unknown
}

export class HealthDb extends Dexie {
  readings!: EntityTable<Reading, 'id'>
  syncs!: EntityTable<SyncMark, 'key'>
  devices!: EntityTable<KnownDevice, 'id'>
  settings!: EntityTable<Setting, 'key'>

  constructor(name = 'healthgear') {
    super(name)
    this.version(1).stores({
      readings: 'id, &dedupeKey, takenAt, kind, source, [kind+takenAt]',
      syncs: 'key, sink, readingId, [sink+readingId]',
      devices: 'id, lastSeen',
      settings: 'key',
    })
  }
}

export const db = new HealthDb()

/**
 * Insert readings, silently skipping ones already stored (same dedupe key).
 * Returns only the readings that were actually new.
 */
export async function addReadings(input: NewReading[], target: HealthDb = db): Promise<Reading[]> {
  const now = Date.now()
  const prepared: Reading[] = []
  const seen = new Set<string>()
  for (const r of input) {
    const values = cleanValues(r.kind, r.values)
    if (Object.keys(values).length === 0) continue
    const dedupeKey = r.dedupeKey ?? dedupeKeyFor({ ...r, values })
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    prepared.push({ ...r, values, dedupeKey, id: crypto.randomUUID(), createdAt: now })
  }
  if (prepared.length === 0) return []
  return target.transaction('rw', target.readings, async () => {
    const existingKeys = new Set(
      await target.readings.where('dedupeKey').anyOf(prepared.map((r) => r.dedupeKey)).keys(),
    )
    const fresh = prepared.filter((r) => !existingKeys.has(r.dedupeKey))
    await target.readings.bulkAdd(fresh)
    return fresh
  })
}

export async function markSynced(sink: SinkId, readingIds: string[], target: HealthDb = db, remoteIds?: Map<string, string>) {
  const at = Date.now()
  await target.syncs.bulkPut(
    readingIds.map((readingId) => ({ key: `${sink}:${readingId}`, sink, readingId, at, remoteId: remoteIds?.get(readingId) })),
  )
}

/** Readings never pushed to the given sink, oldest first. Demo data never leaves the browser. */
export async function unsynced(sink: SinkId, target: HealthDb = db): Promise<Reading[]> {
  const done = new Set(await target.syncs.where('sink').equals(sink).toArray().then((m) => m.map((x) => x.readingId)))
  return (await target.readings.orderBy('takenAt').toArray()).filter((r) => r.source !== 'demo' && !done.has(r.id))
}

export async function getSetting<T>(key: string, fallback: T, target: HealthDb = db): Promise<T> {
  const row = await target.settings.get(key)
  return row === undefined ? fallback : (row.value as T)
}

export async function setSetting(key: string, value: unknown, target: HealthDb = db) {
  await target.settings.put({ key, value })
}
