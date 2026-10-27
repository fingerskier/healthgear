// Device sessions live outside React so they survive re-renders and tab switches.
// Components subscribe with useDevices().

import { useSyncExternalStore } from 'react'
import { ReadingAssembler } from '../ble/assembler'
import { DeviceSession, errorText, requestDevice, type ConnState, type DeviceInfo } from '../ble/connection'
import { PROFILES, type ProfileId } from '../ble/profiles'
import { SIMULATORS } from '../ble/simulator'
import { addReadings, db } from '../db'
import type { NewReading, Reading } from '../model'
import { toast } from './toast'

export interface DeviceEntry {
  key: string
  label: string
  state: ConnState
  detail?: string
  info?: DeviceInfo
  live?: NewReading
  demo: boolean
  listen: boolean
  saved: number
}

type Listener = () => void

let entries: DeviceEntry[] = []
const listeners = new Set<Listener>()
const sessions = new Map<string, DeviceSession>()
const demoTimers = new Map<string, ReturnType<typeof setTimeout>[]>()

function emit() {
  entries = [...entries]
  listeners.forEach((l) => l())
}

function patch(key: string, change: Partial<DeviceEntry>) {
  entries = entries.map((e) => (e.key === key ? { ...e, ...change } : e))
  listeners.forEach((l) => l())
}

function upsert(entry: DeviceEntry) {
  const i = entries.findIndex((e) => e.key === entry.key)
  if (i >= 0) entries[i] = { ...entries[i], ...entry }
  else entries.push(entry)
  emit()
}

export function useDevices(): DeviceEntry[] {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => entries,
  )
}

async function saveFinal(key: string, readings: NewReading[]) {
  const fresh = await addReadings(readings)
  if (fresh.length === 0) return
  const entry = entries.find((e) => e.key === key)
  patch(key, { saved: (entry?.saved ?? 0) + fresh.length })
  toast(describeSaved(fresh))
}

function describeSaved(fresh: Reading[]) {
  if (fresh.length > 1) return `Saved ${fresh.length} readings`
  const r = fresh[0]
  const v = r.values
  if (r.kind === 'bloodPressure') return `Saved ${v.systolic}/${v.diastolic} mmHg`
  return `Saved ${PROFILES.find((p) => p.id === profileForKind(r.kind))?.label.toLowerCase() ?? 'reading'}`
}

function profileForKind(kind: Reading['kind']): ProfileId {
  return ({ body: 'weightScale', bloodPressure: 'bloodPressure', heartRate: 'heartRate', spo2: 'pulseOximeter', temperature: 'thermometer', glucose: 'glucose' } as const)[kind]
}

function handlersFor(key: string) {
  return {
    onState: (state: ConnState, detail?: string) => patch(key, { state, detail }),
    onInfo: (info: DeviceInfo) => {
      patch(key, { info, label: info.name })
      void db.devices.put({ id: info.id, name: info.name, profile: info.profiles.map((p) => p.id).join(','), lastSeen: Date.now() })
    },
    onLive: (live: NewReading) => patch(key, { live }),
    onFinal: (readings: NewReading[]) => void saveFinal(key, readings),
  }
}

/** Open the browser's device chooser and connect to the pick. */
export async function addBluetoothDevice(acceptAll = false) {
  let device: BluetoothDevice
  try {
    device = await requestDevice(acceptAll)
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'NotFoundError')) toast(errorText(e), 'error')
    return
  }
  await attach(device)
}

export async function attach(device: BluetoothDevice) {
  const key = `ble:${device.id}`
  sessions.get(key)?.stop()
  upsert({ key, label: device.name ?? 'Bluetooth device', state: 'connecting', demo: false, listen: true, saved: 0 })
  const session = new DeviceSession(device, handlersFor(key))
  sessions.set(key, session)
  try {
    await session.start(true)
  } catch (e) {
    patch(key, { state: 'error', detail: errorText(e) })
  }
}

export function setListen(key: string, listen: boolean) {
  const session = sessions.get(key)
  patch(key, { listen })
  if (!session) return
  if (listen) void session.start(true).catch(() => {})
  else if (!session.connected) session.stop()
}

export function removeDevice(key: string) {
  sessions.get(key)?.stop()
  sessions.delete(key)
  demoTimers.get(key)?.forEach(clearTimeout)
  demoTimers.delete(key)
  entries = entries.filter((e) => e.key !== key)
  emit()
}

/** Persist the current live value (for streaming sensors like HR straps). */
export async function saveLive(key: string) {
  const entry = entries.find((e) => e.key === key)
  if (!entry?.live) return
  await saveFinal(key, [{ ...entry.live, takenAt: Date.now(), deviceTime: false }])
}

// --- demo devices ---------------------------------------------------------------------------------

export function runDemo(profileId: ProfileId) {
  const sim = SIMULATORS[profileId]
  if (!sim) return
  const key = `demo:${profileId}`
  demoTimers.get(key)?.forEach(clearTimeout)
  const profile = PROFILES.find((p) => p.id === profileId)!
  upsert({
    key,
    label: sim.label,
    state: 'connecting',
    demo: true,
    listen: false,
    saved: entries.find((e) => e.key === key)?.saved ?? 0,
    live: undefined,
    info: { id: key, name: sim.label, profiles: [profile], battery: 87, manufacturer: 'healthgear', model: 'simulator' },
  })
  const h = handlersFor(key)
  const asm = new ReadingAssembler({ onLive: h.onLive, onFinal: h.onFinal, quietMs: 600 })
  const specs = PROFILES.flatMap((p) => p.characteristics)
  // stamp demo data as demo so it's easy to tell apart and purge
  const asDemo = <T extends { reading: NewReading } | null>(p: T): T =>
    p ? { ...p, reading: { ...p.reading, source: 'demo' as const, device: sim.label } } : p
  const timers: ReturnType<typeof setTimeout>[] = []
  let at = 600
  timers.push(setTimeout(() => patch(key, { state: 'connected' }), at))
  for (const n of sim.run(new Date())) {
    at += n.delay
    timers.push(
      setTimeout(() => {
        const spec = specs.find((c) => c.uuid === n.characteristic)
        if (spec) asm.push(asDemo(spec.parse(n.data, { device: sim.label })), spec.continued?.(n.data) ?? false)
      }, at),
    )
  }
  timers.push(
    setTimeout(() => {
      asm.flush()
      patch(key, { state: 'disconnected', detail: 'Demo finished. Run it again for another reading.' })
    }, at + 900),
  )
  demoTimers.set(key, timers)
}
