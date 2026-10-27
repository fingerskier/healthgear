// @vitest-environment jsdom
// Drives DeviceSession against an in-memory Web Bluetooth fake: the lifecycle (connect, notify,
// disconnect, reconnect) is where hardware-free bugs hide.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NewReading } from '../model'
import { DeviceSession } from './connection'
import { CHAR, SERVICE } from './profiles'

class FakeChar extends EventTarget {
  value: DataView | undefined
  notifying = false
  writes: Uint8Array[] = []
  readonly uuid: string
  readonly properties: { write: boolean; writeWithoutResponse: boolean }
  readonly log: string[]
  constructor(uuid: string, log: string[], props = { write: true, writeWithoutResponse: false }) {
    super()
    this.uuid = uuid
    this.log = log
    this.properties = props
  }
  async startNotifications() {
    this.notifying = true
    this.log.push(`notify:${this.uuid.slice(4, 8)}`)
    return this
  }
  async writeValueWithResponse(v: Uint8Array) {
    this.writes.push(v)
    this.log.push(`write:${this.uuid.slice(4, 8)}`)
  }
  async writeValueWithoutResponse(v: Uint8Array) {
    return this.writeValueWithResponse(v)
  }
  async readValue() {
    return new DataView(new Uint8Array([77]).buffer)
  }
  emit(bytes: number[]) {
    this.value = new DataView(new Uint8Array(bytes).buffer)
    this.dispatchEvent(new Event('characteristicvaluechanged'))
  }
}

class FakeService {
  readonly uuid: string
  readonly chars: Map<string, FakeChar>
  constructor(uuid: string, chars: FakeChar[]) {
    this.uuid = uuid
    this.chars = new Map(chars.map((c) => [c.uuid, c]))
  }
  async getCharacteristic(uuid: string) {
    const c = this.chars.get(uuid)
    if (!c) throw new DOMException('no characteristic', 'NotFoundError')
    return c
  }
}

class FakeDevice extends EventTarget {
  id = 'dev1'
  name = 'Fake cuff'
  connected = false
  connectCalls = 0
  failConnects = 0
  readonly services: FakeService[]
  readonly gatt: { readonly connected: boolean; connect: () => Promise<unknown>; disconnect: () => void }
  constructor(services: FakeService[]) {
    super()
    this.services = services
    const gatt = {
      connected: false,
      connect: async () => {
        this.connectCalls++
        if (this.failConnects > 0) {
          this.failConnects--
          throw new DOMException('unreachable', 'NetworkError')
        }
        this.connected = true
        return { connected: true, getPrimaryServices: async () => this.services }
      },
      disconnect: () => this.drop(),
    }
    Object.defineProperty(gatt, 'connected', { get: () => this.connected })
    this.gatt = gatt
  }
  drop() {
    if (!this.connected) return
    this.connected = false
    this.dispatchEvent(new Event('gattserverdisconnected'))
  }
}
const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff]
const bpPacket = (sys: number) => [0x02, ...le16(sys), ...le16(80), ...le16(93), ...le16(2026), 10, 27, 8, 0, sys % 60]

function setup(extra: FakeService[] = []) {
  const log: string[] = []
  const bpm = new FakeChar(CHAR.bloodPressureMeasurement, log)
  const cts = new FakeChar(CHAR.currentTime, log)
  const dev = new FakeDevice([new FakeService(SERVICE.bloodPressure, [bpm]), new FakeService(SERVICE.currentTime, [cts]), ...extra])
  const final: NewReading[] = []
  const states: string[] = []
  const session = new DeviceSession(dev as unknown as BluetoothDevice, {
    onState: (s) => states.push(s),
    onInfo: () => {},
    onLive: () => {},
    onFinal: (rs) => final.push(...rs),
  })
  return { dev, bpm, cts, session, final, states, log }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('DeviceSession', () => {
  it('connects, sets the clock, subscribes, and saves a measurement', async () => {
    const { bpm, cts, session, final, states } = setup()
    await session.start(false)
    expect(states.at(-1)).toBe('connected')
    expect(cts.writes[0]).toHaveLength(10)
    expect(bpm.notifying).toBe(true)
    bpm.emit(bpPacket(121))
    expect(final.map((r) => r.values.systolic)).toEqual([121])
    session.stop()
  })

  it('does not double-deliver after a reconnect', async () => {
    vi.useFakeTimers()
    const { dev, bpm, session, final } = setup()
    await session.start(true)
    dev.drop() // cuff goes to sleep after sending
    await vi.advanceTimersByTimeAsync(5000) // listen loop reconnects
    expect(dev.connected).toBe(true)
    bpm.emit(bpPacket(130))
    expect(final.map((r) => r.values.systolic)).toEqual([130])
    session.stop()
  })

  it('keeps retrying while listening and the device is away', async () => {
    vi.useFakeTimers()
    const { dev, session, states } = setup()
    dev.failConnects = 3
    await session.start(true)
    expect(states).toContain('waiting')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(dev.connected).toBe(true)
    expect(states.at(-1)).toBe('connected')
    session.stop()
  })

  it('stops retrying after stop()', async () => {
    vi.useFakeTimers()
    const { dev, session } = setup()
    dev.failConnects = 100
    await session.start(true)
    session.stop()
    const calls = dev.connectCalls
    await vi.advanceTimersByTimeAsync(120_000)
    expect(dev.connectCalls).toBe(calls)
  })

  it('enables glucose notifications before asking for stored records', async () => {
    const log: string[] = []
    const gm = new FakeChar(CHAR.glucoseMeasurement, log)
    const racp = new FakeChar(CHAR.recordAccessControlPoint, log)
    const { session, log: mainLog } = setup([new FakeService(SERVICE.glucose, [gm, racp])])
    await session.start(false)
    expect(log).toEqual(['notify:2a18', 'notify:2a52', 'write:2a52'])
    expect(Array.from(racp.writes[0])).toEqual([0x01, 0x01])
    expect(mainLog).toContain('write:2a2b')
    session.stop()
  })
})
