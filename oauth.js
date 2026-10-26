/**
 * Google OAuth (optional) — set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + PUBLIC_BASE_URL
 */
const crypto = require('crypto')

function mountOAuth(app, ctx) {
  const { users, workspaces, persistUsers, persistWorkspaces, JWT_SECRET, PUBLIC_BASE, now } = ctx
  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ''
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ''
  const REDIRECT = (PUBLIC_BASE || '').replace(/\/$/, '') + '/api/auth/google/callback'

  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.log('[oauth] Google disabled — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET')
    app.get('/api/auth/google/status', (_req, res) => {
      res.json({ ok: true, enabled: false, message: 'Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET' })
    })
    app.get('/api/auth/google', (_req, res) => {
      res.status(503).json({ error: 'Google sign-in not configured on server' })
    })
    return
  }

  const bcrypt = require('bcryptjs')
  const jwt = require('jsonwebtoken')
  const { v4: uuidv4 } = require('uuid')

  app.get('/api/auth/google/status', (_req, res) => {
    res.json({ ok: true, enabled: true, clientId: CLIENT_ID })
  })

  app.get('/api/auth/google', (req, res) => {
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
    try {
      const code = req.query.code
      if (!code) return res.status(400).type('text').send('Missing code')
      const body = new URLSearchParams({
        code: String(code),
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
      const email = String(profile.email || '').toLowerCase().trim()
      if (!email) return res.status(400).type('text').send('No email from Google')
      let user = users[email]
      if (!user) {
        const id = uuidv4()
        const ts = typeof now === 'function' ? now() : new Date().toISOString()
        user = {
          id,
          email,
          password_hash: bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10),
          name: profile.name || email.split('@')[0],
          role: 'user',
          google_id: profile.id,
          created_at: ts,
          updated_at: ts,
        }
        users[email] = user
        workspaces[id] = { data: { clients: [], invoices: [], tickets: [], settings: {} }, version: 1, updated_at: ts }
        if (typeof persistUsers === 'function') persistUsers()
        if (typeof persistWorkspaces === 'function') persistWorkspaces()
      } else {
        user.google_id = profile.id
        user.updated_at = typeof now === 'function' ? now() : new Date().toISOString()
        if (typeof persistUsers === 'function') persistUsers()
      }
      const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '90d' })
      const appUrl = process.env.APP_PUBLIC_URL || 'https://sa-invoice-pro.pcrepairdex.workers.dev'
      res.redirect(appUrl.replace(/\/$/, '') + '/login?google_token=' + encodeURIComponent(token) + '&email=' + encodeURIComponent(user.email))
    } catch (e) {
      console.error('[oauth]', e)
      res.status(500).type('text').send('OAuth error: ' + (e.message || 'failed'))
    }
  })

  console.log('[oauth] Google OAuth enabled')
}

module.exports = { mountOAuth }
