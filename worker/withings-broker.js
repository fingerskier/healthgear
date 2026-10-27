// Optional Withings token broker for healthgear (Cloudflare Worker).
//
// Why: Withings requires client_secret for the code exchange and every refresh (no PKCE), so a
// static site either asks each user for their own app secret, or delegates just these two calls
// to something that can keep a secret. This worker is that something. It stores nothing, never
// sees health data (the browser calls the measure API directly), and only talks to Withings.
//
// Deploy:
//   npx wrangler deploy worker/withings-broker.js --name healthgear-withings
//   npx wrangler secret put WITHINGS_CLIENT_SECRET
//   set vars WITHINGS_CLIENT_ID, ALLOWED_ORIGINS (comma list), ALLOWED_REDIRECTS (comma list)
// Then paste the worker URL into healthgear → Sync → Withings → "Token broker URL".

const TOKEN_URL = 'https://wbsapi.withings.net/v2/oauth2'

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? ''
    const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const cors = allowed.includes(origin)
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' }
      : null

    if (request.method === 'OPTIONS') return new Response(null, { status: cors ? 204 : 403, headers: cors ?? {} })
    const url = new URL(request.url)
    if (request.method !== 'POST' || url.pathname !== '/withings/token') return json({ error: 'not found' }, 404, cors)
    if (!cors) return json({ error: 'origin not allowed' }, 403, null)

    let input
    try {
      input = JSON.parse(await request.text())
    } catch {
      return json({ error: 'bad json' }, 400, cors)
    }

    const redirects = (env.ALLOWED_REDIRECTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const params = { action: 'requesttoken', client_id: env.WITHINGS_CLIENT_ID, client_secret: env.WITHINGS_CLIENT_SECRET }
    if (input.grant_type === 'authorization_code' && typeof input.code === 'string' && redirects.includes(input.redirect_uri)) {
      Object.assign(params, { grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirect_uri })
    } else if (input.grant_type === 'refresh_token' && typeof input.refresh_token === 'string') {
      Object.assign(params, { grant_type: 'refresh_token', refresh_token: input.refresh_token })
    } else {
      return json({ error: 'bad grant' }, 400, cors)
    }

    let upstream
    try {
      upstream = await (await fetch(TOKEN_URL, { method: 'POST', body: new URLSearchParams(params) })).json()
    } catch {
      return json({ error: 'withings unreachable' }, 502, cors)
    }
    if (upstream.status !== 0) {
      const misconfigured = /client id|secret/i.test(upstream.error ?? '')
      return json({ error: upstream.error ?? `withings status ${upstream.status}` }, misconfigured ? 500 : 401, cors)
    }
    // Same shape the browser gets from Withings directly, minus the envelope.
    const { access_token, refresh_token, expires_in, userid, scope } = upstream.body
    return json({ access_token, refresh_token, expires_in, userid, scope }, 200, cors)
  },
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...(cors ?? {}) } })
}
