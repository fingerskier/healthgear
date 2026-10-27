// Google: the Health API (health.googleapis.com/v4) takes weight, body fat and height. It has no
// blood-pressure type, and Google Fit — which did — is closed to new projects and shuts down at
// the end of 2026. So everything (BP included) can also be appended to a Google Sheet the app
// creates, using the non-sensitive drive.file scope.
//
// Auth is the Google Identity Services token model: a 1-hour access token minted in the browser,
// no client secret, no refresh token. The user supplies their own OAuth client ID (see README).

import type { Reading } from '../model'
import { toCsvRow, CSV_HEADER } from '../export'

export const HEALTH_SCOPE = 'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.writeonly'
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const HEALTH_API = 'https://health.googleapis.com/v4/users/me/dataTypes'
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets'

interface TokenResponse {
  access_token: string
  expires_in: number
  scope: string
  error?: string
  error_description?: string
}

interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string; scope?: string }): void
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: {
            client_id: string
            scope: string
            callback: (r: TokenResponse) => void
            error_callback?: (e: { type: string; message?: string }) => void
          }): TokenClient
          revoke(token: string, done?: () => void): void
        }
      }
    }
  }
}

let gisLoading: Promise<void> | null = null

/** Load the GIS script ahead of time so the popup opens inside the click's user activation. */
export function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve()
  gisLoading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => {
      gisLoading = null
      reject(new Error('Could not load Google sign-in (offline or blocked?)'))
    }
    document.head.append(s)
  })
  return gisLoading
}

export interface GoogleToken {
  accessToken: string
  expiresAt: number
  scopes: Set<string>
}

/** Must be called from a click handler: GIS opens a popup. */
export async function requestGoogleToken(clientId: string, scopes: string[]): Promise<GoogleToken> {
  await loadGis()
  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: scopes.join(' '),
      callback: (r) => {
        if (r.error || !r.access_token) return reject(new Error(r.error_description ?? r.error ?? 'Google sign-in failed'))
        resolve({ accessToken: r.access_token, expiresAt: Date.now() + (r.expires_in - 60) * 1000, scopes: new Set(r.scope.split(' ')) })
      },
      error_callback: (e) => reject(new Error(e.type === 'popup_closed' ? 'Google sign-in was closed' : (e.message ?? e.type))),
    })
    client.requestAccessToken()
  })
}

export function revokeGoogleToken(token: GoogleToken) {
  window.google?.accounts.oauth2.revoke(token.accessToken)
}

export class GoogleApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type Fetch = typeof fetch

async function call(fetchFn: Fetch, token: GoogleToken, url: string, init: RequestInit = {}) {
  const res = await fetchFn(url, {
    ...init,
    headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json', ...init.headers },
  })
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      msg = body?.error?.message ?? msg
    } catch {
      /* not JSON */
    }
    throw new GoogleApiError(res.status, msg)
  }
  return res.status === 204 ? null : res.json()
}

// --- Health API ----------------------------------------------------------------------------------

function sampleTime(t: number) {
  // utcOffset is the local offset at the time of the reading, as a google-duration string
  return { physicalTime: new Date(t).toISOString(), utcOffset: `${-new Date(t).getTimezoneOffset() * 60}s` }
}

function dataSource(r: Reading) {
  return {
    recordingMethod: r.source === 'manual' ? 'MANUAL' : 'ACTIVELY_MEASURED',
    ...(r.device ? { device: { formFactor: 'SCALE', displayName: r.device.slice(0, 100) } } : {}),
  }
}

/** The Health API data points one reading turns into. Exported for tests. */
export function healthDataPoints(r: Reading): { type: string; body: object }[] {
  if (r.kind !== 'body') return []
  const out: { type: string; body: object }[] = []
  const { weight, bodyFat, height } = r.values
  const ts = sampleTime(r.takenAt)
  const src = dataSource(r)
  if (weight !== undefined) out.push({ type: 'weight', body: { weight: { weightGrams: Math.round(weight * 1000), sampleTime: ts }, dataSource: src } })
  if (bodyFat !== undefined) out.push({ type: 'body-fat', body: { bodyFat: { percentage: bodyFat, sampleTime: ts }, dataSource: src } })
  if (height !== undefined) out.push({ type: 'height', body: { height: { heightMillimeters: String(Math.round(height * 1000)), sampleTime: ts }, dataSource: src } })
  return out
}

export function googleHealthEligible(r: Reading) {
  return healthDataPoints(r).length > 0
}

export interface PushResult {
  done: string[]
  failed: { id: string; error: string }[]
}

export async function pushToGoogleHealth(token: GoogleToken, readings: Reading[], fetchFn: Fetch = fetch): Promise<PushResult> {
  const result: PushResult = { done: [], failed: [] }
  for (const r of readings) {
    try {
      for (const p of healthDataPoints(r)) {
        await call(fetchFn, token, `${HEALTH_API}/${p.type}/dataPoints`, { method: 'POST', body: JSON.stringify(p.body) })
      }
      result.done.push(r.id)
    } catch (e) {
      // An expired token or a project misconfiguration fails every request; stop instead of
      // hammering the API with the rest of the queue.
      if (e instanceof GoogleApiError && (e.status === 401 || e.status === 403)) throw e
      result.failed.push({ id: r.id, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return result
}

// --- Sheets --------------------------------------------------------------------------------------

export async function createSheet(token: GoogleToken, fetchFn: Fetch = fetch): Promise<string> {
  const sheet = await call(fetchFn, token, SHEETS_API, {
    method: 'POST',
    body: JSON.stringify({
      properties: { title: 'healthgear readings' },
      sheets: [{ properties: { title: 'readings', gridProperties: { frozenRowCount: 1 } } }],
    }),
  })
  const id: string = sheet.spreadsheetId
  await appendRows(token, id, [CSV_HEADER], fetchFn)
  return id
}

async function appendRows(token: GoogleToken, sheetId: string, rows: string[][], fetchFn: Fetch) {
  const range = encodeURIComponent('readings!A1')
  await call(fetchFn, token, `${SHEETS_API}/${sheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    body: JSON.stringify({ values: rows }),
  })
}

export async function appendToSheet(token: GoogleToken, sheetId: string, readings: Reading[], fetchFn: Fetch = fetch) {
  // Sheets accepts large batches; 500 rows per call keeps payloads modest.
  for (let i = 0; i < readings.length; i += 500) {
    await appendRows(token, sheetId, readings.slice(i, i + 500).map(toCsvRow), fetchFn)
  }
}

export const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`
