// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'

const push = vi.fn()

vi.mock('../sinks/google', async (importOriginal) => {
  const real = await importOriginal<typeof import('../sinks/google')>()
  return {
    ...real,
    requestGoogleToken: async () => ({ accessToken: 't', expiresAt: Infinity, scopes: new Set([real.HEALTH_SCOPE, real.SHEETS_SCOPE]) }),
    checkHealthAccount: async () => {},
    pushToGoogleHealth: async (...args: unknown[]) => {
      push(...args)
      await new Promise((r) => setTimeout(r, 50))
      return { done: [], failed: [] }
    },
  }
})

describe('Google pushes', () => {
  it('a second press while a push is running does not start another', async () => {
    const { addReadings } = await import('../db')
    const { pushGoogleHealth } = await import('./google')
    await addReadings([{ kind: 'body', takenAt: 1, deviceTime: true, values: { weight: 70 }, source: 'manual' }])
    await Promise.all([pushGoogleHealth('cid'), pushGoogleHealth('cid')])
    expect(push).toHaveBeenCalledTimes(1)
    // and once it finished, the next press runs again
    await pushGoogleHealth('cid')
    expect(push).toHaveBeenCalledTimes(2)
  })
})
