import { useLiveQuery } from 'dexie-react-hooks'
import { clearSyncs, db, getSetting, markSynced, setSetting, unsynced } from '../db'
import {
  appendToSheet,
  checkHealthAccount,
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
const POINTS_KEY = 'google.sentPoints'

export interface GoogleState {
  clientId?: string
  sheetId?: string
  lastHealthPush?: number
  lastSheetPush?: number
}

// Access tokens are short-lived (1 h) and never persisted.
let token: GoogleToken | null = null
let accountChecked = false

const load = () => getSetting<GoogleState>(KEY, {})
const save = async (patch: Partial<GoogleState>) => setSetting(KEY, { ...(await load()), ...patch })

export function useGoogle(): GoogleState | undefined {
  return useLiveQuery(async () => ((await db.settings.get(KEY))?.value as GoogleState | undefined) ?? {})
}

export const saveGoogleClientId = (clientId: string) => save({ clientId: clientId.trim() })

/**
 * Call synchronously from the click handler. When a new token is needed the consent popup is
 * requested before anything is awaited, so it opens inside the click's user activation.
 */
function tokenFor(clientId: string, scope: string): Promise<GoogleToken> {
  if (token && Date.now() < token.expiresAt && token.scopes.has(scope)) return Promise.resolve(token)
  // Ask for both scopes at once so one consent covers both buttons; the user can untick either.
  return requestGoogleToken(clientId, [HEALTH_SCOPE, SHEETS_SCOPE]).then((t) => {
    token = t
    accountChecked = false
    if (!t.scopes.has(scope)) throw new Error('Permission was not granted for this action')
    return t
  })
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

export function pushGoogleHealth(clientId: string): Promise<void> {
  const tokenPromise = tokenFor(clientId, HEALTH_SCOPE)
  return (async () => {
    try {
      const t = await tokenPromise
      if (!accountChecked) {
        await checkHealthAccount(t)
        accountChecked = true
      }
      const pending = (await unsynced('googleHealth')).filter(googleHealthEligible)
      if (pending.length === 0) return toast('Google Health is up to date')
      // Points accepted by Google in an interrupted run, so a retry never sends them twice.
      const points = await getSetting<Record<string, string[]>>(POINTS_KEY, {})
      const { done, failed } = await pushToGoogleHealth(t, pending, fetch, {
        sentPoints: (id) => new Set(points[id] ?? []),
        onPoint: async (id, type) => {
          points[id] = [...(points[id] ?? []), type]
          await setSetting(POINTS_KEY, points)
        },
        onReading: async (id) => {
          await markSynced('googleHealth', [id])
          delete points[id]
          await setSetting(POINTS_KEY, points)
        },
      })
      await save({ lastHealthPush: Date.now() })
      toast(failed.length ? `Sent ${done.length}; ${failed.length} failed: ${failed[0].error}` : `Sent ${done.length} readings to Google Health`, failed.length ? 'error' : 'info')
    } catch (e) {
      toast(explain(e), 'error')
    }
  })()
}

export function pushGoogleSheet(clientId: string): Promise<void> {
  const tokenPromise = tokenFor(clientId, SHEETS_SCOPE)
  return (async () => {
    try {
      const t = await tokenPromise
      let { sheetId } = await load()
      if (!sheetId) {
        sheetId = await createSheet(t)
        await save({ sheetId })
      }
      const pending = await unsynced('googleSheets')
      if (pending.length === 0) return toast('Google Sheet is up to date')
      try {
        await appendToSheet(t, sheetId, pending, fetch, (ids) => markSynced('googleSheets', ids))
      } catch (e) {
        if (e instanceof GoogleApiError && e.status === 404) {
          // The user deleted the sheet: the next push starts a new one with the full history.
          await save({ sheetId: undefined })
          await clearSyncs('googleSheets')
          throw new Error('Your healthgear sheet is gone. Press again to create a new one with everything in it.')
        }
        throw e
      }
      await save({ lastSheetPush: Date.now() })
      toast(`Added ${pending.length} rows to your Google Sheet`)
    } catch (e) {
      toast(explain(e), 'error')
    }
  })()
}
