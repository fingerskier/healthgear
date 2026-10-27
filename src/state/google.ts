import { useLiveQuery } from 'dexie-react-hooks'
import { db, getSetting, markSynced, setSetting, unsynced } from '../db'
import {
  appendToSheet,
  createSheet,
  GoogleApiError,
  googleHealthEligible,
  HEALTH_SCOPE,
  pushToGoogleHealth,
  requestGoogleToken,
  SHEETS_SCOPE,
  type GoogleToken,
} from '../sinks/google'
import { toast } from './toast'

const KEY = 'google'

export interface GoogleState {
  clientId?: string
  sheetId?: string
  lastHealthPush?: number
  lastSheetPush?: number
}

// Access tokens are short-lived (1 h) and never persisted.
let token: GoogleToken | null = null

const load = () => getSetting<GoogleState>(KEY, {})
const save = async (patch: Partial<GoogleState>) => setSetting(KEY, { ...(await load()), ...patch })

export function useGoogle(): GoogleState | undefined {
  return useLiveQuery(async () => ((await db.settings.get(KEY))?.value as GoogleState | undefined) ?? {})
}

export const saveGoogleClientId = (clientId: string) => save({ clientId: clientId.trim() })

async function tokenFor(scope: string): Promise<GoogleToken> {
  if (token && Date.now() < token.expiresAt && token.scopes.has(scope)) return token
  const { clientId } = await load()
  if (!clientId) throw new Error('Add your Google OAuth client ID first')
  // Ask for both scopes at once so one consent covers both buttons; the user can untick either.
  token = await requestGoogleToken(clientId, [HEALTH_SCOPE, SHEETS_SCOPE])
  if (!token.scopes.has(scope)) throw new Error('Permission was not granted for this action')
  return token
}

function explain(e: unknown): string {
  if (e instanceof GoogleApiError) {
    if (e.status === 401) {
      token = null
      return 'Google session expired. Try again.'
    }
    if (e.status === 403) return `Google refused (${e.message}). Is the API enabled in your project and your account a test user?`
  }
  return e instanceof Error ? e.message : String(e)
}

export async function pushGoogleHealth(): Promise<void> {
  try {
    const t = await tokenFor(HEALTH_SCOPE)
    const pending = (await unsynced('googleHealth')).filter(googleHealthEligible)
    if (pending.length === 0) return toast('Google Health is up to date')
    const { done, failed } = await pushToGoogleHealth(t, pending)
    await markSynced('googleHealth', done)
    await save({ lastHealthPush: Date.now() })
    toast(failed.length ? `Sent ${done.length}; ${failed.length} failed: ${failed[0].error}` : `Sent ${done.length} readings to Google Health`, failed.length ? 'error' : 'info')
  } catch (e) {
    toast(explain(e), 'error')
  }
}

export async function pushGoogleSheet(): Promise<void> {
  try {
    const t = await tokenFor(SHEETS_SCOPE)
    let { sheetId } = await load()
    if (!sheetId) {
      sheetId = await createSheet(t)
      await save({ sheetId })
    }
    const pending = await unsynced('googleSheets')
    if (pending.length === 0) return toast('Google Sheet is up to date')
    try {
      await appendToSheet(t, sheetId, pending)
    } catch (e) {
      // the user deleted the sheet: start a new one next time
      if (e instanceof GoogleApiError && e.status === 404) await save({ sheetId: undefined })
      throw e
    }
    await markSynced('googleSheets', pending.map((r) => r.id))
    await save({ lastSheetPush: Date.now() })
    toast(`Added ${pending.length} rows to your Google Sheet`)
  } catch (e) {
    toast(explain(e), 'error')
  }
}
