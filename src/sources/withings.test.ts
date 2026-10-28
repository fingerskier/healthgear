// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { exchangeCode, fetchMeasures, groupToReading, refreshTokens, WithingsError, type MeasureGroup } from './withings'

const grp = (measures: MeasureGroup['measures'], extra: Partial<MeasureGroup> = {}): MeasureGroup => ({
  grpid: 1,
  attrib: 0,
  date: 1_761_550_000,
  category: 1,
  measures,
  ...extra,
})

function fakeFetch(...bodies: unknown[]) {
  const calls: { url: string; body: URLSearchParams | string }[] = []
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body as URLSearchParams })
    return new Response(JSON.stringify(bodies.shift()), { status: 200 })
  })
  return { fn: fn as unknown as typeof fetch, calls }
}

describe('groupToReading', () => {
  it('maps a weigh-in with body composition and drops scale pulse', () => {
    const r = groupToReading(
      grp([
        { value: 72450, type: 1, unit: -3 },
        { value: 215, type: 6, unit: -1 },
        { value: 1557, type: 8, unit: -2 },
        { value: 72, type: 11, unit: 0 },
      ]),
    )!
    expect(r.kind).toBe('body')
    expect(r.values).toEqual({ weight: 72.45, bodyFat: 21.5, fatMass: 15.57 })
    expect(r.takenAt).toBe(1_761_550_000_000)
    expect(r.dedupeKey).toBe('withings|1')
  })

  it('classifies blood pressure by systolic/diastolic, keeping pulse', () => {
    const r = groupToReading(grp([{ value: 121, type: 10, unit: 0 }, { value: 79, type: 9, unit: 0 }, { value: 64, type: 11, unit: 0 }]))!
    expect(r.kind).toBe('bloodPressure')
    expect(r.values).toEqual({ systolic: 121, diastolic: 79, heartRate: 64 })
  })

  it('skips goals and flags ambiguous users', () => {
    expect(groupToReading(grp([{ value: 70000, type: 1, unit: -3 }], { category: 2 }))).toBeNull()
    expect(groupToReading(grp([{ value: 70000, type: 1, unit: -3 }], { attrib: 1 }))!.notes).toEqual(['may belong to another user of this device'])
  })
})

describe('token exchange', () => {
  it('posts the form with the secret and unwraps the envelope', async () => {
    const { fn, calls } = fakeFetch({ status: 0, body: { access_token: 'a', refresh_token: 'r', expires_in: 10800, userid: 42 } })
    const t = await exchangeCode({ clientId: 'cid', clientSecret: 'sec' }, 'code123', fn, 0)
    const body = calls[0].body as URLSearchParams
    expect(calls[0].url).toBe('https://wbsapi.withings.net/v2/oauth2')
    expect(Object.fromEntries(body)).toMatchObject({ action: 'requesttoken', grant_type: 'authorization_code', client_id: 'cid', client_secret: 'sec', code: 'code123' })
    expect(t).toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: (10800 - 60) * 1000, userId: '42' })
  })

  it('treats HTTP 200 with non-zero status as an error', async () => {
    const { fn } = fakeFetch({ status: 503, error: 'Invalid Params: invalid client id/secret' })
    await expect(exchangeCode({ clientId: 'c', clientSecret: 's' }, 'x', fn)).rejects.toBeInstanceOf(WithingsError)
  })

  it('maps broker errors: only a 401 kills the grant, rate limits stay retryable', async () => {
    const broker = { clientId: 'c', brokerUrl: 'https://b.workers.dev' }
    const tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: 0, userId: '1' }
    const reply = (status: number, body: object) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
    const dead = await refreshTokens(broker, tokens, reply(401, { error: 'invalid refresh_token' })).catch((e) => e)
    expect((dead as WithingsError).authFailed).toBe(true)
    const limited = await refreshTokens(broker, tokens, reply(502, { error: 'Too Many Requests', status: 601 })).catch((e) => e)
    expect((limited as WithingsError).authFailed).toBe(false)
    expect((limited as WithingsError).rateLimited).toBe(true)
    const misconfigured = await refreshTokens(broker, tokens, reply(500, { error: 'Invalid Params: invalid client id/secret', status: 503 })).catch((e) => e)
    expect((misconfigured as WithingsError).authFailed).toBe(false)
  })

  it('uses the broker without sending a secret', async () => {
    const { fn, calls } = fakeFetch({ access_token: 'a', refresh_token: 'r2', expires_in: 10800, userid: '1' })
    const t = await refreshTokens({ clientId: 'c', brokerUrl: 'https://b.workers.dev/' }, { accessToken: 'old', refreshToken: 'r1', expiresAt: 0, userId: '1' }, fn)
    expect(calls[0].url).toBe('https://b.workers.dev/withings/token')
    expect(JSON.parse(calls[0].body as string)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'r1' })
    expect(calls[0].body).not.toContain('secret')
    expect(t.refreshToken).toBe('r2')
  })
})

describe('fetchMeasures', () => {
  it('pages with offset, sends the token in the body, and returns the update cursor', async () => {
    const page = (grpid: number, more: number) => ({
      status: 0,
      body: { updatetime: 1_761_600_000 + grpid, more, offset: grpid, measuregrps: [grp([{ value: 70000 + grpid, type: 1, unit: -3 }], { grpid })] },
    })
    const { fn, calls } = fakeFetch(page(1, 1), page(2, 0))
    const out = await fetchMeasures({ accessToken: 'tok', refreshToken: 'r', expiresAt: 0, userId: '1' }, 1_761_000_000, fn)
    expect(out.readings.map((r) => r.dedupeKey)).toEqual(['withings|1', 'withings|2'])
    expect(out.updateTime).toBe(1_761_600_002)
    const first = Object.fromEntries(calls[0].body as URLSearchParams)
    expect(first).toMatchObject({ action: 'getmeas', access_token: 'tok', lastupdate: '1761000000', category: '1' })
    expect(Object.fromEntries(calls[1].body as URLSearchParams).offset).toBe('1')
  })

  it('surfaces rate limiting', async () => {
    const { fn } = fakeFetch({ status: 601, error: 'Too Many Requests' })
    const err = await fetchMeasures({ accessToken: 't', refreshToken: 'r', expiresAt: 0, userId: '1' }, undefined, fn).catch((e) => e)
    expect(err).toBeInstanceOf(WithingsError)
    expect((err as WithingsError).rateLimited).toBe(true)
  })
})
