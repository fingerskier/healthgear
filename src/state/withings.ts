// Persistence and orchestration for the Withings import: login round-trip, token rotation,
// incremental sync. Tokens live in IndexedDB; the client secret too, if the user brought one.

import { useLiveQuery } from 'dexie-react-hooks'
import { db, getSetting, setSetting, upsertReadings } from '../db'
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

/**
 * Run before the first render: the authorization code is only valid for ~30 s, and the URL is
 * cleaned up synchronously (before any await) so the app opens on the Sync tab without the code.
 */
export async function completeWithingsLogin(): Promise<void> {
  const url = new URL(location.href)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const denied = url.searchParams.get('error')
  if (!(code && state) && !denied) return
  for (const p of ['code', 'state', 'error', 'error_description']) url.searchParams.delete(p)
  history.replaceState(null, '', `${url.pathname}${url.search}#sync`)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
  const s = await load()
  if (denied) {
    if (s.pendingState) await save({ ...s, pendingState: undefined })
    return toast('Withings login was cancelled', 'error')
  }
  if (!code || !s.pendingState || s.pendingState !== state || !s.config) {
    return toast('Withings login could not be verified (expired or from another tab). Connect again.', 'error')
  }
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
    // Withings returns edited or reassigned measurement groups under the same id: replace ours.
    const { added, updated } = await upsertReadings(readings)
    await save({ ...(await load()), lastUpdate: updateTime || s.lastUpdate, lastSync: Date.now() })
    const parts = [added.length && `${added.length} new`, updated.length && `${updated.length} corrected`].filter(Boolean)
    toast(parts.length ? `Withings: ${parts.join(', ')}` : 'Withings: nothing new')
    return added.length + updated.length
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
