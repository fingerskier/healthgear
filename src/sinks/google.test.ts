import { describe, expect, it, vi } from 'vitest'
import type { Reading } from '../model'
import { appendToSheet, GoogleApiError, healthDataPoints, pushToGoogleHealth, type GoogleToken } from './google'

const token: GoogleToken = { accessToken: 'tok', expiresAt: Infinity, scopes: new Set() }

const body = (extra: Partial<Reading> = {}): Reading => ({
  id: 'r1',
  kind: 'body',
  takenAt: Date.UTC(2026, 9, 27, 12, 15, 0),
  deviceTime: true,
  values: { weight: 72.456, bodyFat: 21.4, height: 1.78 },
  source: 'ble',
  device: 'A&D UC-352BLE',
  dedupeKey: 'k',
  createdAt: 0,
  ...extra,
})

describe('Google Health data points', () => {
  it('maps weight, body fat and height with the documented field names and units', () => {
    const points = healthDataPoints(body())
    expect(points.map((p) => p.type)).toEqual(['weight', 'body-fat', 'height'])
    const [w, f, h] = points.map((p) => p.body as Record<string, Record<string, unknown>>)
    expect(w.weight.weightGrams).toBe(72456)
    expect(w.weight.sampleTime).toEqual({ physicalTime: '2026-10-27T12:15:00.000Z', utcOffset: expect.stringMatching(/^-?\d+s$/) })
    expect(f.bodyFat.percentage).toBe(21.4)
    expect(h.height.heightMillimeters).toBe('1780') // int64 travels as a string
    expect(w.dataSource).toMatchObject({ recordingMethod: 'ACTIVELY_MEASURED' })
  })

  it('has nothing to send for blood pressure (no such Health API type)', () => {
    expect(healthDataPoints(body({ kind: 'bloodPressure', values: { systolic: 120, diastolic: 80 } }))).toEqual([])
  })

  it('stops on 401 but has already reported everything Google accepted', async () => {
    const urls: string[] = []
    let n = 0
    const fetchFn = vi.fn(async (url: string) => {
      urls.push(url)
      return ++n <= 4 ? new Response('{}', { status: 200 }) : new Response(JSON.stringify({ error: { message: 'expired' } }), { status: 401 })
    }) as unknown as typeof fetch
    const points: string[] = []
    const readings: string[] = []
    await expect(
      pushToGoogleHealth(token, [body(), body({ id: 'r2' })], fetchFn, {
        onPoint: (id, type) => void points.push(`${id}:${type}`),
        onReading: (id) => void readings.push(id),
      }),
    ).rejects.toBeInstanceOf(GoogleApiError)
    expect(urls[0]).toBe('https://health.googleapis.com/v4/users/me/dataTypes/weight/dataPoints')
    expect(readings).toEqual(['r1'])
    expect(points).toEqual(['r1:weight', 'r1:body-fat', 'r1:height', 'r2:weight'])
  })

  it('skips points an interrupted push already delivered', async () => {
    const urls: string[] = []
    const fetchFn = vi.fn(async (url: string) => (urls.push(url), new Response('{}', { status: 200 }))) as unknown as typeof fetch
    await pushToGoogleHealth(token, [body()], fetchFn, { sentPoints: () => new Set(['weight']) })
    expect(urls.map((u) => u.split('/').at(-2))).toEqual(['body-fat', 'height'])
  })

  it('records per-reading failures that are not auth problems', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'bad value' } }), { status: 400 })) as unknown as typeof fetch
    const out = await pushToGoogleHealth(token, [body()], fetchFn)
    expect(out).toEqual({ done: [], failed: [{ id: 'r1', error: 'bad value' }] })
  })
})

describe('Google Sheets append', () => {
  it('appends typed rows in RAW mode and reports each chunk', async () => {
    const calls: { url: string; body: string }[] = []
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as string })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const chunks: string[][] = []
    await appendToSheet(token, 'sheet1', [body({ kind: 'bloodPressure', values: { systolic: 120, diastolic: 80 } })], fetchFn, (ids) => void chunks.push(ids))
    expect(chunks).toEqual([['r1']])
    expect(calls[0].url).toBe('https://sheets.googleapis.com/v4/spreadsheets/sheet1/values/readings!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS'.replace('readings!A1', encodeURIComponent('readings!A1')))
    const rows = JSON.parse(calls[0].body).values
    expect(rows[0][1]).toBe('bloodPressure')
    expect(rows[0]).toContain(120) // a number cell, not the text "120"
  })
})
