import Dexie, { type EntityTable } from 'dexie'
import { cleanValues, dedupeKeyFor, isComplete, type NewReading, type Reading } from './model'

export type SinkId = 'googleHealth' | 'googleSheets' | 'apple'
/** partial progress inside one reading (e.g. its weight point accepted, body fat not yet) */
type PartialSink = 'googleHealthPoint'

export interface SyncMark {
  /** `${sink}:${readingId}`, or `${sink}:${readingId}:${part}` for partial progress */
  key: string
  sink: SinkId | PartialSink
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

/** A reading the user deleted: devices and imports keep re-offering it, so remember to refuse. */
export interface Tombstone {
  dedupeKey: string
  at: number
}

export class HealthDb extends Dexie {
  readings!: EntityTable<Reading, 'id'>
  syncs!: EntityTable<SyncMark, 'key'>
  devices!: EntityTable<KnownDevice, 'id'>
  settings!: EntityTable<Setting, 'key'>
  tombstones!: EntityTable<Tombstone, 'dedupeKey'>

  constructor(name = 'healthgear') {
    super(name)
    this.version(1).stores({
      readings: 'id, &dedupeKey, takenAt, kind, source, [kind+takenAt]',
      syncs: 'key, sink, readingId, [sink+readingId]',
      devices: 'id, lastSeen',
      settings: 'key',
      tombstones: 'dedupeKey',
    })
  }
}

export const db = new HealthDb()

function prepare(input: NewReading[]): Reading[] {
  const now = Date.now()
  const prepared: Reading[] = []
  const seen = new Set<string>()
  for (const r of input) {
    const values = cleanValues(r.kind, r.values)
    if (!isComplete(r.kind, values)) continue
    const dedupeKey = r.dedupeKey ?? dedupeKeyFor({ ...r, values })
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    prepared.push({ ...r, values, dedupeKey, id: crypto.randomUUID(), createdAt: now })
  }
  return prepared
}

/**
 * Insert readings, silently skipping ones already stored (same dedupe key) or deleted by the user.
 * Returns only the readings that were actually new.
 */
export async function addReadings(input: NewReading[], target: HealthDb = db): Promise<Reading[]> {
  return (await upsertReadings(input, target, false)).added
}

/**
 * Like addReadings, but a reading whose key exists with different content replaces it (same id)
 * and loses its sync marks so every sink gets the corrected version. For sources whose records
 * can change after the fact, e.g. a Withings measurement group the user edits or reassigns.
 */
export async function upsertReadings(
  input: NewReading[],
  target: HealthDb = db,
  replaceChanged = true,
): Promise<{ added: Reading[]; updated: Reading[] }> {
  const prepared = prepare(input)
  if (prepared.length === 0) return { added: [], updated: [] }
  return target.transaction('rw', target.readings, target.syncs, target.tombstones, async () => {
    const keys = prepared.map((r) => r.dedupeKey)
    const dead = new Set(await target.tombstones.where('dedupeKey').anyOf(keys).primaryKeys())
    const existing = new Map((await target.readings.where('dedupeKey').anyOf(keys).toArray()).map((r) => [r.dedupeKey, r]))
    const added: Reading[] = []
    const updated: Reading[] = []
    for (const r of prepared) {
      if (dead.has(r.dedupeKey)) continue
      const old = existing.get(r.dedupeKey)
      if (!old) added.push(r)
      else if (replaceChanged && contentDiffers(old, r)) updated.push({ ...r, id: old.id, createdAt: old.createdAt })
    }
    await target.readings.bulkAdd(added)
    if (updated.length) {
      await target.readings.bulkPut(updated)
      await target.syncs.where('readingId').anyOf(updated.map((r) => r.id)).delete()
    }
    return { added, updated }
  })
}

function contentDiffers(a: Reading, b: Reading) {
  return (
    a.kind !== b.kind ||
    a.takenAt !== b.takenAt ||
    JSON.stringify(a.values) !== JSON.stringify(b.values) ||
    JSON.stringify(a.notes ?? []) !== JSON.stringify(b.notes ?? [])
  )
}

/** Delete readings for good: their sync marks go, and their keys are refused from now on. */
export async function deleteReadings(ids: string[], target: HealthDb = db, remember = true) {
  await target.transaction('rw', target.readings, target.syncs, target.tombstones, async () => {
    const rows = (await target.readings.bulkGet(ids)).filter((r): r is Reading => !!r)
    if (remember) await target.tombstones.bulkPut(rows.map((r) => ({ dedupeKey: r.dedupeKey, at: Date.now() })))
    await target.readings.bulkDelete(ids)
    await target.syncs.where('readingId').anyOf(ids).delete()
  })
}

export async function markSynced(sink: SinkId, readingIds: string[], target: HealthDb = db, remoteIds?: Map<string, string>) {
  if (readingIds.length === 0) return
  const at = Date.now()
  await target.syncs.bulkPut(
    readingIds.map((readingId) => ({ key: `${sink}:${readingId}`, sink, readingId, at, remoteId: remoteIds?.get(readingId) })),
  )
}

/**
 * Partial progress lives with the sync marks, so anything that invalidates a reading's marks (a
 * correction, a delete) invalidates its partial progress too.
 */
export async function markPartSynced(readingId: string, part: string, target: HealthDb = db) {
  const sink: PartialSink = 'googleHealthPoint'
  await target.syncs.put({ key: `${sink}:${readingId}:${part}`, sink, readingId, at: Date.now(), remoteId: part })
}

export async function partsSynced(readingIds: string[], target: HealthDb = db): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  const marks = await target.syncs.where('sink').equals('googleHealthPoint').toArray()
  const wanted = new Set(readingIds)
  for (const m of marks) {
    if (!wanted.has(m.readingId) || !m.remoteId) continue
    out.set(m.readingId, (out.get(m.readingId) ?? new Set()).add(m.remoteId))
  }
  return out
}

/** Forget every mark for a sink, e.g. when its destination was deleted and must be refilled. */
export async function clearSyncs(sink: SinkId, target: HealthDb = db) {
  await target.syncs.where('sink').equals(sink).delete()
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
