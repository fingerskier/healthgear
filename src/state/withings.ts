// Persistence and orchestration for the Withings import: login round-trip, token rotation,
// incremental sync. Tokens live in IndexedDB; the client secret too, if the user brought one.

import { useLiveQuery } from 'dexie-react-hooks'
import { addReadings, db, getSetting, setSetting } from '../db'
import {
  authorizeUrl,
  exchangeCode,
  fetchMeasures,
  randomState,
  refreshTokens,
  WithingsError,
  type WithingsConfig,
  type WithingsTokens,
} from '../sources/withings'
import { toast } from './toast'

const KEY = 'withings'

export interface WithingsState {
  config?: WithingsConfig
  tokens?: WithingsTokens
  pendingState?: string
  lastUpdate?: number
  lastSync?: number
}

const load = () => getSetting<WithingsState>(KEY, {})
const save = (s: WithingsState) => setSetting(KEY, s)

export function useWithings(): WithingsState | undefined {
  return useLiveQuery(async () => ((await db.settings.get(KEY))?.value as WithingsState | undefined) ?? {})
}

export async function saveWithingsConfig(config: WithingsConfig) {
  await save({ ...(await load()), config })
}

/** Navigates away to Withings; we come back to the app URL with ?code&state. */
export async function startWithingsLogin(config: WithingsConfig, demo = false) {
  const state = randomState()
  await save({ ...(await load()), config, pendingState: state })
  location.assign(authorizeUrl(config, state, demo))
}

/** Run as early as possible on page load: the authorization code is only valid for ~30 s. */
export async function completeWithingsLogin(): Promise<void> {
  const url = new URL(location.href)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) return
  const s = await load()
  if (!s.pendingState || s.pendingState !== state || !s.config) return
  url.searchParams.delete('code')
  url.searchParams.delete('state')
  history.replaceState(null, '', `${url.pathname}${url.search}#sync`)
  try {
    const tokens = await exchangeCode(s.config, code)
    await save({ ...s, tokens, pendingState: undefined, lastUpdate: undefined })
    toast('Withings connected')
    await syncWithings()
  } catch (e) {
    await save({ ...s, pendingState: undefined })
    toast(`Withings login failed: ${describe(e)}`, 'error')
  }
}

async function freshTokens(): Promise<{ s: WithingsState; tokens: WithingsTokens }> {
  const run = async () => {
    const s = await load()
    if (!s.config || !s.tokens) throw new Error('Withings is not connected')
    if (Date.now() < s.tokens.expiresAt) return { s, tokens: s.tokens }
    // Refresh rotates the refresh token. Persist before first use, or the account unlinks.
    const tokens = await refreshTokens(s.config, s.tokens)
    const next = { ...s, tokens }
    await save(next)
    return { s: next, tokens }
  }
  // Two tabs refreshing at once would burn the rotated token; serialize across tabs.
  return navigator.locks ? navigator.locks.request('healthgear-withings-refresh', run) : run()
}

export async function syncWithings(full = false): Promise<number> {
  try {
    const { s, tokens } = await freshTokens()
    const { readings, updateTime } = await fetchMeasures(tokens, full ? undefined : s.lastUpdate)
    const fresh = await addReadings(readings)
    await save({ ...(await load()), lastUpdate: updateTime || s.lastUpdate, lastSync: Date.now() })
    toast(fresh.length ? `Imported ${fresh.length} Withings readings` : 'Withings: nothing new')
    return fresh.length
  } catch (e) {
    if (e instanceof WithingsError && e.authFailed) {
      const s = await load()
      await save({ ...s, tokens: undefined })
      toast('Withings access expired or was revoked. Connect again.', 'error')
    } else {
      toast(`Withings sync failed: ${describe(e)}`, 'error')
    }
    return 0
  }
}

export async function disconnectWithings(forget = false) {
  const s = await load()
  await save(forget ? {} : { ...s, tokens: undefined, lastUpdate: undefined })
}

function describe(e: unknown) {
  if (e instanceof WithingsError && e.rateLimited) return 'rate limited by Withings, try again in a minute'
  if (e instanceof TypeError) return 'network or CORS error (see README: token broker)'
  return e instanceof Error ? e.message : String(e)
}
