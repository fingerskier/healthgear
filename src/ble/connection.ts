// Web Bluetooth plumbing: pick a device, discover which health profiles it speaks, subscribe,
// and keep listening across the connect → send → disconnect cycle that cuffs and scales use.

import type { NewReading } from '../model'
import { ReadingAssembler } from './assembler'
import {
  CHAR,
  encodeCurrentTime,
  encodeDateTime,
  OPTIONAL_SERVICES,
  PROFILE_SERVICES,
  PROFILES,
  SERVICE,
  type CharacteristicSpec,
  type Profile,
} from './profiles'

export type ConnState = 'connecting' | 'connected' | 'waiting' | 'disconnected' | 'error'

export interface DeviceInfo {
  id: string
  name: string
  profiles: Profile[]
  battery?: number
  manufacturer?: string
  model?: string
}

export interface SessionHandlers {
  onState: (state: ConnState, detail?: string) => void
  onInfo: (info: DeviceInfo) => void
  onLive: (reading: NewReading) => void
  onFinal: (readings: NewReading[]) => void
}

export type Support = { ok: true } | { ok: false; reason: string }

export async function bluetoothSupport(): Promise<Support> {
  if (!window.isSecureContext) return { ok: false, reason: 'Web Bluetooth needs HTTPS.' }
  if (!navigator.bluetooth) {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    return {
      ok: false,
      reason: ios
        ? 'No iOS browser has Web Bluetooth, and Home Screen apps never do. Open this page in a Bluefy tab, or in Safari with the beacio extension (iOS 26.2+), to use devices.'
        : 'This browser has no Web Bluetooth. Use Chrome or Edge on Windows, macOS, ChromeOS or Android (on Linux, enable chrome://flags/#enable-web-bluetooth).',
    }
  }
  try {
    if (!(await navigator.bluetooth.getAvailability())) return { ok: false, reason: 'Bluetooth is off or no adapter was found.' }
  } catch {
    // getAvailability is missing in some implementations (Bluefy); assume available
  }
  return { ok: true }
}

export async function requestDevice(acceptAll = false): Promise<BluetoothDevice> {
  const optionalServices = [...PROFILE_SERVICES, ...OPTIONAL_SERVICES]
  return navigator.bluetooth.requestDevice(
    acceptAll
      ? { acceptAllDevices: true, optionalServices }
      : { filters: PROFILE_SERVICES.map((s) => ({ services: [s] })), optionalServices },
  )
}

/** Devices this origin already has permission for (Chrome; may be empty or unsupported elsewhere). */
export async function rememberedDevices(): Promise<BluetoothDevice[]> {
  try {
    return navigator.bluetooth.getDevices ? await navigator.bluetooth.getDevices() : []
  } catch {
    return []
  }
}

const CONNECT_TIMEOUT_MS = 15_000

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms)
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    )
  })
}

/** Errors that retrying won't fix: show them and stop listening. */
class FatalConnectError extends Error {}

function isFatal(e: unknown) {
  return e instanceof FatalConnectError || (e instanceof DOMException && (e.name === 'SecurityError' || e.name === 'NotSupportedError'))
}

class Aborted extends Error {}

/**
 * A live link to one device. With `listen` on, the session re-arms after every disconnect so a cuff
 * or scale that wakes, sends, and sleeps again is picked up each time without another chooser.
 */
export class DeviceSession {
  private assembler: ReadingAssembler
  private stopped = false
  private listening = false
  /** a fatal error is on screen; the disconnect it causes must not overwrite it */
  private errored = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private advertAbort: AbortController | null = null
  private retryMs = 2000
  // Browsers may hand back the same characteristic object after a reconnect; track our listener
  // per characteristic so re-subscribing replaces it instead of stacking a second one.
  private readonly listeners = new Map<BluetoothRemoteGATTCharacteristic, () => void>()
  private readonly onDisconnect = () => this.handleDisconnect()
  private readonly onVisibility = () => {
    // Chrome aborts watchAdvertisements when the tab is hidden; re-arm when it's back.
    if (document.visibilityState === 'visible' && this.listening && !this.device.gatt?.connected) this.scheduleRetry(0)
  }

  readonly device: BluetoothDevice
  private readonly handlers: SessionHandlers

  constructor(device: BluetoothDevice, handlers: SessionHandlers) {
    this.device = device
    this.handlers = handlers
    this.assembler = new ReadingAssembler({ onLive: handlers.onLive, onFinal: handlers.onFinal })
  }

  get connected() {
    return this.device.gatt?.connected ?? false
  }

  /** Connect now; if `listen`, keep reconnecting whenever the device comes back. */
  async start(listen: boolean) {
    this.stopped = false
    this.errored = false
    this.listening = listen
    // (Re)attach here, not in the constructor, so a session restarted after stop() still hears
    // disconnects. Removing first keeps it idempotent.
    this.device.removeEventListener('gattserverdisconnected', this.onDisconnect)
    this.device.addEventListener('gattserverdisconnected', this.onDisconnect)
    document.removeEventListener('visibilitychange', this.onVisibility)
    document.addEventListener('visibilitychange', this.onVisibility)
    try {
      await this.connectOnce()
    } catch (e) {
      this.failed(e)
      if (!listen && !(e instanceof Aborted)) throw e
    }
  }

  /** Turn auto-reconnect on or off without dropping a live connection. */
  setListening(on: boolean) {
    if (this.stopped) return
    this.listening = on
    this.errored = false
    if (on) {
      if (!this.connected) this.waitForDevice()
    } else {
      this.clearRetry()
      if (!this.connected) this.handlers.onState('disconnected')
    }
  }

  stop() {
    this.stopped = true
    this.listening = false
    this.clearRetry()
    this.assembler.flush()
    this.device.removeEventListener('gattserverdisconnected', this.onDisconnect)
    document.removeEventListener('visibilitychange', this.onVisibility)
    for (const [ch, fn] of this.listeners) ch.removeEventListener('characteristicvaluechanged', fn)
    this.listeners.clear()
    // Unconditionally: per spec this also aborts a connect() still in flight.
    this.device.gatt?.disconnect()
    this.handlers.onState('disconnected')
  }

  /** Throw if stop() ran while we were awaiting, closing whatever link the await produced. */
  private checkpoint() {
    if (!this.stopped) return
    this.device.gatt?.disconnect()
    throw new Aborted()
  }

  private async connectOnce() {
    const gatt = this.device.gatt
    if (!gatt) throw new FatalConnectError('Device has no GATT server')
    this.handlers.onState('connecting')
    const server = await withTimeout(gatt.connect(), CONNECT_TIMEOUT_MS, 'Connection')
    this.checkpoint()
    // Errors here are transient (the device dropped mid-discovery); only a completed discovery
    // with nothing we speak is fatal.
    const services = await server.getPrimaryServices()
    this.checkpoint()
    const byUuid = new Map(services.map((s) => [s.uuid, s]))
    const profiles = PROFILES.filter((p) => byUuid.has(p.service))
    if (profiles.length === 0) {
      throw new FatalConnectError('No supported health service found. The device may use a proprietary protocol.')
    }

    const info: DeviceInfo = { id: this.device.id, name: this.device.name ?? 'Unnamed device', profiles }
    this.handlers.onInfo(info)

    // Set the device clock first; many cuffs/scales stamp readings with it (and some refuse to
    // send stored readings until it's set).
    await setDeviceClock([byUuid.get(SERVICE.currentTime), ...profiles.map((p) => byUuid.get(p.service))])
    this.checkpoint()

    for (const profile of profiles) {
      const service = byUuid.get(profile.service)!
      for (const spec of profile.characteristics) {
        await this.subscribe(service, spec)
        this.checkpoint()
      }
      if (profile.id === 'glucose') await requestAllGlucoseRecords(service)
    }
    this.handlers.onState('connected')
    this.retryMs = 2000

    // Nice-to-haves after the important subscriptions, so a device that disconnects quickly
    // still delivers its data.
    void readExtras(byUuid).then((extras) => {
      if (!this.stopped) this.handlers.onInfo({ ...info, ...extras })
    })
  }

  private async subscribe(service: BluetoothRemoteGATTService, spec: CharacteristicSpec) {
    let ch: BluetoothRemoteGATTCharacteristic
    try {
      ch = await service.getCharacteristic(spec.uuid)
    } catch (e) {
      if (spec.required) throw e
      return
    }
    const onValue = () => {
      const data = ch.value
      if (!data) return
      try {
        this.assembler.push(spec.parse(data, { device: this.device.name ?? undefined }), spec.continued?.(data) ?? false)
      } catch (e) {
        console.warn('unparseable notification', spec.uuid, e)
      }
    }
    const previous = this.listeners.get(ch)
    if (previous) ch.removeEventListener('characteristicvaluechanged', previous)
    ch.addEventListener('characteristicvaluechanged', onValue)
    this.listeners.set(ch, onValue)
    try {
      await ch.startNotifications()
    } catch (e) {
      if (spec.required) throw e
    }
  }

  /** A connect attempt failed: never leave a half-set-up link open, then decide whether to retry. */
  private failed(e: unknown) {
    if (e instanceof Aborted || this.stopped) return
    const fatal = isFatal(e) || !this.listening
    if (fatal) {
      this.listening = false
      this.errored = true
      this.clearRetry()
    }
    // A timed-out connect may still be pending, and a link whose subscriptions failed is useless:
    // the retry loop would otherwise see "connected" and sit idle while indications go nowhere.
    this.device.gatt?.disconnect()
    if (fatal) {
      this.handlers.onState('error', errorText(e))
      return
    }
    this.retryMs = Math.min(this.retryMs * 1.5, 15_000)
    this.waitForDevice()
  }

  private handleDisconnect() {
    this.assembler.flush()
    if (this.stopped || this.errored) return
    if (this.listening) this.waitForDevice()
    else this.handlers.onState('disconnected')
  }

  private waitForDevice() {
    if (this.stopped || !this.listening) return
    this.handlers.onState('waiting', 'Waiting for the device to wake up…')
    if (this.device.watchAdvertisements && document.visibilityState === 'visible') {
      // Cheapest path: wait for an advertisement, then connect.
      this.advertAbort?.abort()
      const abort = new AbortController()
      this.advertAbort = abort
      const onAdvert = () => {
        this.device.removeEventListener('advertisementreceived', onAdvert)
        abort.abort()
        this.scheduleRetry(0)
      }
      this.device.addEventListener('advertisementreceived', onAdvert)
      this.device.watchAdvertisements({ signal: abort.signal }).catch(() => {
        this.device.removeEventListener('advertisementreceived', onAdvert)
        if (!abort.signal.aborted) this.scheduleRetry(this.retryMs)
      })
      return
    }
    this.scheduleRetry(this.retryMs)
  }

  private scheduleRetry(ms: number) {
    this.clearRetry()
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null
      if (this.stopped || !this.listening || this.device.gatt?.connected) return
      try {
        await this.connectOnce()
      } catch (e) {
        this.failed(e)
      }
    }, ms)
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.advertAbort?.abort()
    this.advertAbort = null
  }
}

/**
 * Write the clock wherever the device exposes one: Current Time (0x2A2B) usually in the Current
 * Time Service but sometimes inside the scale's own service, or plain Date Time (0x2A08), which
 * A&D cuffs expect. Failures are normal (read-only clocks, "data field ignored").
 */
async function setDeviceClock(services: (BluetoothRemoteGATTService | undefined)[]) {
  const now = new Date()
  for (const service of services) {
    if (!service) continue
    for (const [uuid, payload] of [
      [CHAR.currentTime, encodeCurrentTime(now)],
      [CHAR.dateTime, encodeDateTime(now)],
    ] as const) {
      try {
        const ch = await service.getCharacteristic(uuid)
        if (ch.properties.write) await ch.writeValueWithResponse(payload)
        else if (ch.properties.writeWithoutResponse) await ch.writeValueWithoutResponse(payload)
        else continue
        return
      } catch {
        /* not present or not writable here */
      }
    }
  }
}

async function requestAllGlucoseRecords(service: BluetoothRemoteGATTService) {
  try {
    const racp = await service.getCharacteristic(CHAR.recordAccessControlPoint)
    await racp.startNotifications() // RACP responses arrive as indications
    await racp.writeValueWithResponse(new Uint8Array([0x01, 0x01])) // Report Stored Records: All
  } catch (e) {
    console.info('glucose RACP unavailable', e)
  }
}

async function readExtras(byUuid: Map<string, BluetoothRemoteGATTService>): Promise<Partial<DeviceInfo>> {
  const out: Partial<DeviceInfo> = {}
  const text = new TextDecoder()
  try {
    const battery = byUuid.get(SERVICE.battery)
    if (battery) out.battery = (await (await battery.getCharacteristic(CHAR.batteryLevel)).readValue()).getUint8(0)
  } catch {
    /* optional */
  }
  try {
    const dis = byUuid.get(SERVICE.deviceInformation)
    if (dis) {
      out.manufacturer = text.decode(await (await dis.getCharacteristic(CHAR.manufacturerName)).readValue()).replace(/\0+$/, '')
      out.model = text.decode(await (await dis.getCharacteristic(CHAR.modelNumber)).readValue()).replace(/\0+$/, '')
    }
  } catch {
    /* optional; DIS characteristics may be blocklisted or absent */
  }
  return out
}

export function errorText(e: unknown): string {
  if (e instanceof DOMException) {
    if (e.name === 'NotFoundError') return 'No device selected.'
    if (e.name === 'SecurityError') return 'Bluetooth permission was denied.'
    if (e.name === 'NetworkError') return 'Connection failed. Wake the device (press its button) and try again.'
    if (e.name === 'NotSupportedError') return 'The device refused this operation; it may need to be paired in the OS first.'
  }
  return e instanceof Error ? e.message : String(e)
}
