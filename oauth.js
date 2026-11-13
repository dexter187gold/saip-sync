/**
 * Google OAuth — redirect flow + GIS ID-token exchange.
 * Env: GOOGLE_CLIENT_ID (required for any Google auth),
 *      GOOGLE_CLIENT_SECRET (only required for redirect OAuth code exchange),
 *      PUBLIC_BASE_URL, APP_PUBLIC_URL, JWT_SECRET
 *
 * Privacy: server only stores email, name, google_id. Workspace JSON is per user id.
 * Access requires a valid JWT after Google verification — never open access by email alone.
 *
 * GIS / One Tap only needs GOOGLE_CLIENT_ID (audience check via tokeninfo).
 * Redirect flow additionally needs GOOGLE_CLIENT_SECRET.
 */
const crypto = require('crypto')

function mountOAuth(app, ctx) {
  const { users, workspaces, persistUsers, persistWorkspaces, JWT_SECRET, PUBLIC_BASE, now } = ctx
  const CLIENT_ID =
    process.env.GOOGLE_CLIENT_ID ||
    '1035068069363-o5st6insdv9d349onoa4gqqnf5gadav8.apps.googleusercontent.com'
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ''
  const REDIRECT = (PUBLIC_BASE || '').replace(/\/$/, '') + '/api/auth/google/callback'

  // ID-token path works with client id only; redirect needs secret too
  const idTokenEnabled = !!CLIENT_ID
  const redirectEnabled = !!(CLIENT_ID && CLIENT_SECRET)

  if (!idTokenEnabled) {
    console.log('[oauth] Google disabled — set GOOGLE_CLIENT_ID')
    app.get('/api/auth/google/status', (_req, res) => {
      res.json({ ok: true, enabled: false, message: 'Configure GOOGLE_CLIENT_ID' })
    })
    app.get('/api/auth/google', (_req, res) => {
      res.status(503).json({ error: 'Google sign-in not configured on server' })
    })
    app.post('/api/auth/google', (_req, res) => {
      res.status(503).json({ error: 'Google sign-in not configured on server' })
    })
    return
  }

  const bcrypt = require('bcryptjs')
  const jwt = require('jsonwebtoken')
  const { v4: uuidv4 } = require('uuid')

  function upsertGoogleUser(profile) {
    const email = String(profile.email || '').toLowerCase().trim()
    if (!email) throw new Error('No email from Google')
    const ts = typeof now === 'function' ? now() : new Date().toISOString()
    let user = users[email]
    if (!user) {
      const id = uuidv4()
      user = {
        id,
        email,
        password_hash: bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10),
        name: profile.name || email.split('@')[0],
        role: 'user',
        google_id: profile.id || profile.sub,
        created_at: ts,
        updated_at: ts,
      }
      users[email] = user
      workspaces[id] = {
        data: { clients: [], invoices: [], tickets: [], quotes: [], payments: [], settings: {} },
        version: 1,
        updated_at: ts,
      }
      if (typeof persistUsers === 'function') persistUsers()
      if (typeof persistWorkspaces === 'function') persistWorkspaces()
    } else {
      user.google_id = profile.id || profile.sub || user.google_id
      user.name = user.name || profile.name
      user.updated_at = ts
      if (typeof persistUsers === 'function') persistUsers()
    }
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '90d' })
    return { user, token }
  }

  app.get('/api/auth/google/status', (_req, res) => {
    res.json({
      ok: true,
      enabled: true,
      idToken: idTokenEnabled,
      redirect: redirectEnabled,
      clientId: CLIENT_ID,
    })
  })

  // Browser redirect flow (needs client secret)
  app.get('/api/auth/google', (req, res) => {
    if (!redirectEnabled) {
      return res.status(503).json({
        error: 'Google redirect flow needs GOOGLE_CLIENT_SECRET. Use GIS ID-token (POST /api/auth/google) instead.',
      })
    }
    const state = crypto.randomBytes(16).toString('hex')
    const q = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'online',
      prompt: 'select_account',
      state,
    })
    res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q.toString())
  })

  app.get('/api/auth/google/callback', async (req, res) => {
    if (!redirectEnabled) {
      return res.status(503).type('text').send('Google redirect not configured')
    }
    try {
      const code = String(req.query.code || '')
      if (!code) return res.status(400).type('text').send('Missing code')
      const body = new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT,
        grant_type: 'authorization_code',
      })
      const tokRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })
      const tok = await tokRes.json()
      if (!tok.access_token) return res.status(400).type('text').send('Token exchange failed')
      const uiRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: 'Bearer ' + tok.access_token },
      })
      const profile = await uiRes.json()
      const { user, token } = upsertGoogleUser(profile)
      const appUrl = process.env.APP_PUBLIC_URL || 'https://sa-invoice.pages.dev'
      res.redirect(
        appUrl.replace(/\/$/, '') +
          '/login?google_token=' +
          encodeURIComponent(token) +
          '&email=' +
          encodeURIComponent(user.email),
      )
    } catch (e) {
      console.error('[oauth]', e)
      res.status(500).type('text').send('OAuth error: ' + (e.message || 'failed'))
    }
  })

  /**
   * GIS / One Tap: client sends Google ID token; we verify with tokeninfo
   * and issue a SAIP JWT. Profile is created/linked by verified email only.
   * Only GOOGLE_CLIENT_ID is required (audience check).
   */
  app.post('/api/auth/google', async (req, res) => {
    try {
      const idToken = String(req.body?.idToken || req.body?.id_token || '').trim()
      if (!idToken) return res.status(400).json({ error: 'idToken required' })
      const infoRes = await fetch(
        'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      )
      const info = await infoRes.json()
      if (!infoRes.ok || !info.email) {
        return res.status(401).json({ error: 'Invalid Google ID token' })
      }
      if (info.aud && info.aud !== CLIENT_ID) {
        return res.status(401).json({ error: 'Google token audience mismatch' })
      }
      if (String(info.email_verified) === 'false') {
        return res.status(401).json({ error: 'Google email not verified' })
      }
      const { user, token } = upsertGoogleUser({
        email: info.email,
        name: info.name,
        id: info.sub,
        sub: info.sub,
      })
      return res.json({
        ok: true,
        token,
        user: { id: user.id, email: user.email, name: user.name },
      })
    } catch (e) {
      console.error('[oauth] id_token', e)
      return res.status(500).json({ error: e.message || 'Google auth failed' })
    }
  })

  console.log(
    '[oauth] Google enabled — ID-token=' +
      idTokenEnabled +
      ' redirect=' +
      redirectEnabled +
      ' client=' +
      CLIENT_ID.slice(0, 20) +
      '…',
  )
}

module.exports = { mountOAuth }
