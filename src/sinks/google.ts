// Google: the Health API (health.googleapis.com/v4) takes weight, body fat and height. It has no
// blood-pressure type, and Google Fit — which did — is closed to new projects and shuts down at
// the end of 2026. So everything (BP included) can also be appended to a Google Sheet the app
// creates, using the non-sensitive drive.file scope.
//
// Auth is the Google Identity Services token model: a 1-hour access token minted in the browser,
// no client secret, no refresh token. The user supplies their own OAuth client ID (see README).

import type { Reading } from '../model'
import { CSV_HEADER, toSheetRow } from '../export'

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

export const gisReady = () => !!window.google?.accounts?.oauth2

/**
 * Must be called synchronously from a click handler, with GIS already loaded (see loadGis):
 * GIS opens a popup, and browsers only allow that inside the click's user activation, which an
 * await on a script download or a database read can outlive.
 */
export function requestGoogleToken(clientId: string, scopes: string[]): Promise<GoogleToken> {
  if (!gisReady()) return Promise.reject(new Error('Google sign-in is still loading. Try again in a moment.'))
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

export interface PushProgress {
  /** data points already accepted for a reading in an earlier, interrupted push */
  sentPoints?: (readingId: string) => Set<string>
  onPoint?: (readingId: string, type: string) => void | Promise<void>
  onReading?: (readingId: string) => void | Promise<void>
}

/**
 * Push readings one data point at a time, reporting progress as it goes: Google has no
 * idempotency key for weight or body fat, so anything accepted must never be sent again, even
 * if a later point or the token fails.
 */
export async function pushToGoogleHealth(token: GoogleToken, readings: Reading[], fetchFn: Fetch = fetch, progress: PushProgress = {}): Promise<PushResult> {
  const result: PushResult = { done: [], failed: [] }
  for (const r of readings) {
    try {
      const sent = progress.sentPoints?.(r.id) ?? new Set<string>()
      for (const p of healthDataPoints(r)) {
        if (sent.has(p.type)) continue
        await call(fetchFn, token, `${HEALTH_API}/${p.type}/dataPoints`, { method: 'POST', body: JSON.stringify(p.body) })
        await progress.onPoint?.(r.id, p.type)
      }
      result.done.push(r.id)
      await progress.onReading?.(r.id)
    } catch (e) {
      // An expired token or a project misconfiguration fails every request; stop instead of
      // hammering the API with the rest of the queue. Progress so far is already reported.
      if (e instanceof GoogleApiError && (e.status === 401 || e.status === 403)) throw e
      result.failed.push({ id: r.id, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return result
}

/**
 * The account must have a Google Health profile (the Google Health / Fitbit app set up) before it
 * can take writes; otherwise this fails with FAILED_PRECONDITION / ACCOUNT_NOT_LINKED.
 */
export async function checkHealthAccount(token: GoogleToken, fetchFn: Fetch = fetch): Promise<void> {
  try {
    await call(fetchFn, token, 'https://health.googleapis.com/v4/users/me/identity')
  } catch (e) {
    if (e instanceof GoogleApiError && e.status === 400) {
      throw new GoogleApiError(400, 'This Google account has no Google Health profile yet. Set up the Google Health (Fitbit) app with it first.')
    }
    throw e
  }
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

async function appendRows(token: GoogleToken, sheetId: string, rows: (string | number)[][], fetchFn: Fetch) {
  const range = encodeURIComponent('readings!A1')
  // RAW: numbers stay numbers, and text such as a device name is never parsed as a formula.
  await call(fetchFn, token, `${SHEETS_API}/${sheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    body: JSON.stringify({ values: rows }),
  })
}

/** Appends in 500-row chunks, reporting each so a failure part-way never re-sends earlier rows. */
export async function appendToSheet(
  token: GoogleToken,
  sheetId: string,
  readings: Reading[],
  fetchFn: Fetch = fetch,
  onChunk?: (ids: string[]) => void | Promise<void>,
) {
  for (let i = 0; i < readings.length; i += 500) {
    const chunk = readings.slice(i, i + 500)
    await appendRows(token, sheetId, chunk.map(toSheetRow), fetchFn)
    await onChunk?.(chunk.map((r) => r.id))
  }
}

export const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`
