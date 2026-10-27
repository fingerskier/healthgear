import { useEffect, useState } from 'react'
import { bluetoothSupport, rememberedDevices, type ConnState, type Support } from '../ble/connection'
import { PROFILES } from '../ble/profiles'
import { SIMULATORS } from '../ble/simulator'
import type { Metric, NewReading } from '../model'
import { addBluetoothDevice, attach, removeDevice, runDemo, saveLive, setListen, useDevices, type DeviceEntry } from '../state/devices'
import { useUnits } from '../state/settings'
import { display, type UnitPrefs } from '../units'
import { AlertIcon, BatteryIcon, BluetoothIcon, CheckIcon, ClockIcon, InfoIcon, PlayIcon, PlugOffIcon, SpinnerIcon, TrashIcon } from './icons'

export function Devices() {
  const devices = useDevices()
  const [support, setSupport] = useState<Support | null>(null)
  const [remembered, setRemembered] = useState<BluetoothDevice[]>([])

  useEffect(() => {
    void bluetoothSupport().then(setSupport)
    void rememberedDevices().then(setRemembered)
  }, [])

  const activeIds = new Set(devices.map((d) => d.key))
  const dormant = remembered.filter((d) => !activeIds.has(`ble:${d.id}`))

  return (
    <div className="stack">
      {support && !support.ok && (
        <div className="banner warn" role="status">
          <AlertIcon />
          <div>
            <strong>Bluetooth unavailable.</strong> {support.reason}
          </div>
        </div>
      )}

      <section className="card">
        <h2>Connect a device</h2>
        <p className="muted">
          Works with devices that speak the standard Bluetooth health profiles: blood pressure, weight scale, body
          composition, heart rate, thermometer, pulse oximeter and glucose.
        </p>
        <div className="row">
          <button className="primary" disabled={!support?.ok} onClick={() => void addBluetoothDevice(false)}>
            <BluetoothIcon /> Find health devices
          </button>
          <button disabled={!support?.ok} onClick={() => void addBluetoothDevice(true)}>
            Show all nearby devices
          </button>
        </div>
        <p className="fine">
          Device not listed? Wake it first (press its button or step on the scale), then search again. "Show all" helps
          with devices that don't advertise their services.
        </p>
        {dormant.length > 0 && (
          <div className="remembered">
            <h3>Previously paired</h3>
            {dormant.map((d) => (
              <div key={d.id} className="row between">
                <span>{d.name ?? 'Unnamed device'}</span>
                <button onClick={() => void attach(d)}>Reconnect</button>
              </div>
            ))}
          </div>
        )}
      </section>

      {devices.map((d) => (
        <DeviceCard key={d.key} entry={d} />
      ))}

      <section className="card">
        <h2>Try it without hardware</h2>
        <p className="muted">
          Demo devices replay realistic Bluetooth packets through the same parsers. Demo readings are tagged so you
          can delete them in Settings.
        </p>
        <div className="row wrap">
          {Object.entries(SIMULATORS).map(([id, sim]) => (
            <button key={id} onClick={() => runDemo(id as keyof typeof SIMULATORS)}>
              <PlayIcon /> {sim!.label.replace('Demo ', '')}
            </button>
          ))}
        </div>
      </section>

      <Compatibility />
    </div>
  )
}

const STATE_LABEL: Record<ConnState, string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  waiting: 'Listening',
  disconnected: 'Disconnected',
  error: 'Error',
}

function StatePill({ state }: { state: ConnState }) {
  const icon = {
    connecting: <SpinnerIcon />,
    connected: <CheckIcon />,
    waiting: <ClockIcon />,
    disconnected: <PlugOffIcon />,
    error: <AlertIcon />,
  }[state]
  return (
    <span className={`pill pill-${state}`}>
      {icon}
      {STATE_LABEL[state]}
    </span>
  )
}

function DeviceCard({ entry }: { entry: DeviceEntry }) {
  const [units] = useUnits()
  const profiles = entry.info?.profiles ?? []
  const streaming = profiles.some((p) => p.id === 'heartRate' || p.id === 'pulseOximeter')
  return (
    <section className="card device" aria-live="polite">
      <header className="row between">
        <div>
          <h2>{entry.label}</h2>
          <div className="row wrap small">
            {profiles.map((p) => (
              <span key={p.id} className="chip">
                {p.label}
              </span>
            ))}
            {entry.info?.battery !== undefined && (
              <span className="chip">
                <BatteryIcon /> {entry.info.battery}%
              </span>
            )}
            {entry.demo && <span className="chip">demo</span>}
          </div>
        </div>
        <StatePill state={entry.state} />
      </header>

      {entry.live && <LiveValue reading={entry.live} units={units} />}

      {entry.detail && <p className="muted">{entry.detail}</p>}
      {!entry.live && entry.state === 'connected' && profiles[0] && <p className="muted">{profiles[0].hint}</p>}
      {entry.state === 'waiting' && (
        <p className="muted">
          Keep this tab open and visible. When the device wakes up to send a reading, it will reconnect on its own.
        </p>
      )}

      <footer className="row between">
        <span className="small muted">{entry.saved > 0 ? `${entry.saved} saved this session` : ''}</span>
        <div className="row">
          {streaming && entry.live && (
            <button onClick={() => void saveLive(entry.key)}>Save current value</button>
          )}
          {!entry.demo && (
            <label className="toggle">
              <input type="checkbox" checked={entry.listen} onChange={(e) => setListen(entry.key, e.target.checked)} />
              Auto-reconnect
            </label>
          )}
          {entry.demo && entry.state === 'disconnected' && (
            <button onClick={() => runDemo(entry.key.replace('demo:', '') as keyof typeof SIMULATORS)}>
              <PlayIcon /> Again
            </button>
          )}
          <button className="ghost" aria-label="Remove device" onClick={() => removeDevice(entry.key)}>
            <TrashIcon />
          </button>
        </div>
      </footer>
    </section>
  )
}

const HERO: Record<NewReading['kind'], Metric[]> = {
  bloodPressure: ['systolic', 'diastolic'],
  body: ['weight'],
  heartRate: ['heartRate'],
  spo2: ['spo2'],
  temperature: ['temperature'],
  glucose: ['glucose'],
}

function LiveValue({ reading, units }: { reading: NewReading; units: UnitPrefs }) {
  const metrics = HERO[reading.kind].filter((m) => reading.values[m] !== undefined)
  if (metrics.length === 0) return null
  const parts = metrics.map((m) => display(m, reading.values[m]!, units))
  const intermediate = reading.kind === 'bloodPressure' && reading.values.diastolic === undefined
  const secondary = (['heartRate', 'bodyFat', 'spo2'] as Metric[]).filter(
    (m) => !metrics.includes(m) && reading.values[m] !== undefined,
  )
  return (
    <div className="live">
      <div className="hero">
        {parts.map((p) => p.text).join('/')}
        <span className="hero-unit">{parts[0].unit}</span>
      </div>
      <div className="small muted">
        {intermediate ? 'cuff pressure' : secondary.map((m) => `${display(m, reading.values[m]!, units).text} ${display(m, 0, units).unit}`).join(' · ')}
      </div>
    </div>
  )
}

function Compatibility() {
  return (
    <details className="card">
      <summary>
        <InfoIcon /> Which devices work?
      </summary>
      <div className="prose">
        <p>
          <strong>Works directly over Bluetooth:</strong> devices that implement the Bluetooth SIG health profiles
          ({PROFILES.map((p) => p.label.toLowerCase()).join(', ')}). Known good: A&amp;D UA-651BLE and UC-352BLE, Beurer
          BM/BC cuffs, Medisana connect, Sanitas and Silvercrest cuffs, Samsung Smart Scale, Accu-Chek Instant, Contour
          Next One, and heart-rate straps. Omron cuffs usually share only their latest reading.
        </p>
        <p>
          <strong>Withings</strong> scales and cuffs use a proprietary, encrypted Bluetooth protocol that only the
          Withings app can speak. Keep using the Withings app to take readings, then import them from the Sync tab.
        </p>
        <p>
          <strong>Xiaomi, Renpho, Eufy, and most budget smart scales</strong> use proprietary protocols and are not
          supported.
        </p>
        <p>
          <strong>Browsers:</strong> Chrome and Edge on Windows, macOS, ChromeOS and Android. On Linux, enable{' '}
          <code>chrome://flags/#enable-web-bluetooth</code>. Not Firefox, not iOS Safari (use the Bluefy browser there).
        </p>
        <p>
          <strong>Windows and Linux:</strong> pair a cuff or scale once in the system Bluetooth settings first. Chrome
          can't complete its pairing on these systems.
        </p>
      </div>
    </details>
  )
}
