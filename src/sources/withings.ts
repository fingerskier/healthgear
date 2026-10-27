// Withings cloud import. Withings hardware speaks a proprietary, challenge-authenticated BLE
// protocol whose device secret lives only in Withings' cloud, so the browser can't talk to the
// scale or cuff directly. Readings taken with the Withings app are pulled from the Public API.
//
// The token endpoint requires client_secret (no PKCE). Two ways to supply it:
//   - bring your own: the user registers a free Withings developer app and pastes ID + secret
//   - hosted: the site was built with a token broker (worker/withings-broker.js) that holds the
//     secret of one shared app; its origin is pinned in the CSP at build time
// Withings answers errors as HTTP 200 with a non-zero `status`; never trust response.ok alone.

import type { NewReading, Values } from '../model'

const AUTHORIZE_URL = 'https://account.withings.com/oauth2_user/authorize2'
const TOKEN_URL = 'https://wbsapi.withings.net/v2/oauth2'
const MEASURE_URL = 'https://wbsapi.withings.net/measure'
const SCOPE = 'user.metrics'

export interface WithingsConfig {
  clientId: string
  /** absent when a broker is used */
  clientSecret?: string
  /** base URL of a token broker (POST {grant_type, code|refresh_token, redirect_uri}) */
  brokerUrl?: string
}

/** The hosted app this build was configured with, if any. */
export const HOSTED_WITHINGS: WithingsConfig | null =
  import.meta.env.VITE_WITHINGS_BROKER_URL && import.meta.env.VITE_WITHINGS_CLIENT_ID
    ? { clientId: import.meta.env.VITE_WITHINGS_CLIENT_ID, brokerUrl: import.meta.env.VITE_WITHINGS_BROKER_URL }
    : null

export interface WithingsTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  userId: string
}

export class WithingsError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
  /** the grant is dead: the user has to reconnect */
  get authFailed() {
    return (
      (this.status >= 100 && this.status <= 102) ||
      this.status === 200 ||
      this.status === 401 ||
      (this.status === 503 && !/client id|secret/i.test(this.message) && /refresh|code|grant|token/i.test(this.message))
    )
  }
  get rateLimited() {
    return this.status === 601
  }
}

type Fetch = typeof fetch

export function redirectUri(): string {
  return new URL(import.meta.env.BASE_URL, location.origin).href
}

export function authorizeUrl(cfg: WithingsConfig, state: string, demo = false): string {
  const p = new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, scope: SCOPE, redirect_uri: redirectUri(), state })
  if (demo) p.set('mode', 'demo')
  return `${AUTHORIZE_URL}?${p}`
}

async function withingsPost(fetchFn: Fetch, url: string, params: Record<string, string>) {
  // Form-encoded body and no custom headers keeps this a CORS "simple request" (no preflight).
  const res = await fetchFn(url, { method: 'POST', body: new URLSearchParams(params) })
  if (!res.ok) throw new WithingsError(res.status, `HTTP ${res.status}`)
  const json = await res.json()
  if (json.status !== 0) throw new WithingsError(json.status, json.error ?? `Withings status ${json.status}`)
  return json.body
}

function toTokens(body: { access_token: string; refresh_token: string; expires_in: number; userid: string | number }, now: number): WithingsTokens {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: now + (body.expires_in - 60) * 1000,
    userId: String(body.userid),
  }
}

async function tokenRequest(cfg: WithingsConfig, grant: Record<string, string>, fetchFn: Fetch, now: number): Promise<WithingsTokens> {
  if (cfg.brokerUrl) {
    const res = await fetchFn(cfg.brokerUrl.replace(/\/$/, '') + '/withings/token', {
      method: 'POST',
      // text/plain avoids a preflight; the broker parses JSON regardless
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ ...grant, redirect_uri: redirectUri() }),
    })
    const json = await res.json().catch(() => ({}))
    // The broker answers 401 only for a dead grant; anything else carries Withings' own status
    // (601 rate limit, 522 timeout…) or is the broker's problem, and must not drop the tokens.
    if (res.status === 401) throw new WithingsError(401, json.error ?? 'grant rejected')
    if (!res.ok) throw new WithingsError(typeof json.status === 'number' ? json.status : 0, json.error ?? `broker HTTP ${res.status}`)
    return toTokens(json, now)
  }
  if (!cfg.clientSecret) throw new WithingsError(503, 'Missing client secret')
  const body = await withingsPost(fetchFn, TOKEN_URL, {
    action: 'requesttoken',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    ...grant,
  })
  return toTokens(body, now)
}

/** Authorization codes expire after ~30 s: call this immediately on return from Withings. */
export function exchangeCode(cfg: WithingsConfig, code: string, fetchFn: Fetch = fetch, now = Date.now()) {
  return tokenRequest(cfg, { grant_type: 'authorization_code', code, redirect_uri: redirectUri() }, fetchFn, now)
}

/** Each refresh rotates the refresh token: persist the result before using it. */
export function refreshTokens(cfg: WithingsConfig, tokens: WithingsTokens, fetchFn: Fetch = fetch, now = Date.now()) {
  return tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken }, fetchFn, now)
}

// --- measurements --------------------------------------------------------------------------------

/** Withings meastype → our metric. Only types with a direct canonical equivalent. */
const MEASTYPE: Record<number, keyof Values> = {
  1: 'weight',
  4: 'height',
  5: 'leanMass',
  6: 'bodyFat',
  8: 'fatMass',
  9: 'diastolic',
  10: 'systolic',
  11: 'heartRate',
  12: 'temperature',
  54: 'spo2',
  71: 'temperature',
  76: 'muscleMass',
  77: 'bodyWater',
  88: 'boneMass',
}

export const MEASTYPES = Object.keys(MEASTYPE).join(',')

export interface MeasureGroup {
  grpid: number
  attrib: number
  date: number
  category: number
  deviceid?: string | null
  model?: string
  measures: { value: number; type: number; unit: number }[]
}

/** Exported for tests. */
export function groupToReading(g: MeasureGroup): NewReading | null {
  if (g.category !== 1) return null // 2 = user objectives, not measurements
  const values: Values = {}
  for (const m of g.measures) {
    const metric = MEASTYPE[m.type]
    if (metric) values[metric] = Number((m.value * 10 ** m.unit).toFixed(Math.max(0, -m.unit)))
  }
  if (Object.keys(values).length === 0) return null
  // Scales report pulse too, so heart rate alone doesn't classify a group.
  const kind: NewReading['kind'] =
    values.systolic !== undefined || values.diastolic !== undefined
      ? 'bloodPressure'
      : values.weight !== undefined || values.bodyFat !== undefined || values.height !== undefined || values.fatMass !== undefined || values.muscleMass !== undefined
        ? 'body'
        : values.spo2 !== undefined
          ? 'spo2'
          : values.temperature !== undefined
            ? 'temperature'
            : 'heartRate'
  if (kind === 'body') delete values.heartRate
  const notes: string[] = []
  if (g.attrib === 1) notes.push('may belong to another user of this device')
  if (g.attrib === 2 || g.attrib === 4) notes.push('entered manually in Withings')
  return {
    kind,
    takenAt: g.date * 1000,
    deviceTime: true,
    values,
    source: 'withings',
    device: g.model ?? 'Withings',
    notes: notes.length ? notes : undefined,
    dedupeKey: `withings|${g.grpid}`,
  }
}

export interface FetchMeasuresResult {
  readings: NewReading[]
  /** pass back as `lastUpdate` next time to fetch only changes */
  updateTime: number
}

export async function fetchMeasures(tokens: WithingsTokens, lastUpdate: number | undefined, fetchFn: Fetch = fetch): Promise<FetchMeasuresResult> {
  const readings: NewReading[] = []
  let offset: number | undefined
  let updateTime = lastUpdate ?? 0
  for (let page = 0; page < 50; page++) {
    const params: Record<string, string> = {
      action: 'getmeas',
      access_token: tokens.accessToken, // in the body, not a header: avoids a CORS preflight
      meastypes: MEASTYPES,
      category: '1',
    }
    if (lastUpdate) params.lastupdate = String(lastUpdate)
    if (offset !== undefined) params.offset = String(offset)
    const body = await withingsPost(fetchFn, MEASURE_URL, params)
    for (const g of body.measuregrps as MeasureGroup[]) {
      const r = groupToReading(g)
      if (r) readings.push(r)
    }
    updateTime = Math.max(updateTime, body.updatetime ?? 0)
    if (!body.more) break
    offset = body.offset
  }
  return { readings, updateTime }
}

export function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]!)
}
