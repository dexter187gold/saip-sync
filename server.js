/**
 * SA Invoice Pro Sync v6.13.0 — portal · client login · git data · WA Cloud scaffold
 */
require('dotenv').config()
const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const path = require('path')
const fs = require('fs')
const { createGitStore, GIT_ENABLED } = require('./git-store')
const { resolveWorkspaceKey } = require('./workspace-owner')

let mountSecurity, loginRateLimit, registerRateLimit, strongPassword, safeEmail
try {
  ;({ mountSecurity, loginRateLimit, registerRateLimit, strongPassword, safeEmail } = require('./security'))
} catch {
  mountSecurity = (app) => {
    app.use((req, res, next) => {
      const origin = req.headers.origin
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Vary', 'Origin')
        res.setHeader('Access-Control-Allow-Credentials', 'true')
      } else res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Status-Token, X-Requested-With')
      if (req.method === 'OPTIONS') return res.status(204).end()
      next()
    })
  }
  loginRateLimit = registerRateLimit = (_r, _s, n) => n()
  strongPassword = (pw) => {
    const s = String(pw || '')
    if (s.length < 8) return { ok: false, error: 'Password must be at least 8 characters' }
    if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) return { ok: false, error: 'Password must include letters and numbers' }
    return { ok: true }
  }
  safeEmail = (email) => {
    const e = String(email || '').toLowerCase().trim()
    if (!e || e.length > 254) return null
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null
    return e
  }
}

const app = express()
const PORT = process.env.PORT || 3847
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me'
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://saip-sync.onrender.com'
const RESET_TOKEN_HOURS = 1
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@SAIP2026!'
const USING_DEFAULT_ADMIN_PASSWORD = !process.env.ADMIN_PASSWORD
const USING_DEFAULT_JWT = !process.env.JWT_SECRET || process.env.JWT_SECRET === 'dev-secret-change-me'
const VERSION = '6.13.0'

const DATA_DIR = path.join(__dirname, 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const WORKSPACES_FILE = path.join(DATA_DIR, 'workspaces.json')
const RESET_FILE = path.join(DATA_DIR, 'password_resets.json')
const SUPPORT_FILE = path.join(DATA_DIR, 'support-tickets.json')

const git = createGitStore(DATA_DIR)
const gitMeta = git.meta

function loadJson(file, fallback = {}) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    console.error('loadJson', file, e.message)
  }
  return fallback
}
function saveJson(file, obj) {
  try {
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch (e) {
    try {
      fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8')
    } catch (e2) {
      console.error(e2.message)
    }
  }
}

let users = {}
let workspaces = {}
let passwordResets = {}
let supportTickets = []

function reloadFromDisk() {
  const u = loadJson(USERS_FILE, {})
  const w = loadJson(WORKSPACES_FILE, {})
  const r = loadJson(RESET_FILE, {})
  const s = loadJson(SUPPORT_FILE, [])
  for (const k of Object.keys(users)) delete users[k]
  Object.assign(users, u)
  for (const k of Object.keys(workspaces)) delete workspaces[k]
  Object.assign(workspaces, w)
  for (const k of Object.keys(passwordResets)) delete passwordResets[k]
  Object.assign(passwordResets, r)
  supportTickets.splice(0, supportTickets.length, ...(Array.isArray(s) ? s : []))
}
function persistUsers() {
  saveJson(USERS_FILE, users)
  git.schedulePush('users')
}
function persistWorkspaces() {
  saveJson(WORKSPACES_FILE, workspaces)
  git.schedulePush('workspaces')
}
function persistResets() {
  saveJson(RESET_FILE, passwordResets)
  git.schedulePush('resets')
}
function persistSupportTickets() {
  saveJson(SUPPORT_FILE, supportTickets)
  git.schedulePush('support-tickets')
}
function currentUser(req) {
  return Object.values(users).find((u) => u.id === req.user?.id) || null
}
function requireSupportAdmin(req, res) {
  const actor = currentUser(req)
  if (!actor || actor.role !== 'admin') {
    res.status(403).json({ error: 'Administrator access required' })
    return null
  }
  return actor
}
function now() {
  return new Date().toISOString()
}

function seedAdmin() {
  const defaults = ['admin@sainvoice.pro']
  const envEmail = (process.env.ADMIN_EMAIL || '').toLowerCase().trim()
  if (envEmail && !defaults.includes(envEmail)) defaults.push(envEmail)
  const force = String(process.env.ADMIN_FORCE_RESET || '').trim() === '1'
  for (const key of defaults) {
    if (!users[key]) {
      const id = uuidv4()
      users[key] = {
        id, email: key,
        password_hash: bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, 10),
        name: 'Administrator', role: 'admin',
        created_at: now(), updated_at: now(),
      }
      workspaces[id] = { data: { clients: [], invoices: [], tickets: [], settings: {} }, version: 1, updated_at: now() }
      console.log('[admin] seeded', key)
    } else {
      let changed = false
      if (users[key].role !== 'admin') { users[key].role = 'admin'; changed = true }
      let needHash = force
      try { if (!bcrypt.compareSync(DEFAULT_ADMIN_PASSWORD, users[key].password_hash)) needHash = true } catch { needHash = true }
      if (needHash) {
        users[key].password_hash = bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, 10)
        users[key].updated_at = now()
        changed = true
      }
      if (changed) users[key].updated_at = now()
    }
  }
  persistUsers()
  persistWorkspaces()
}

mountSecurity(app, {})
app.use(express.json({ limit: '8mb' }))
app.use(express.urlencoded({ extended: true, limit: '1mb' }))

function auth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Missing token' })
  try {
    req.user = jwt.verify(token, JWT_SECRET)
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

app.post('/api/auth/register', registerRateLimit, (req, res) => {
  const { password, name } = req.body || {}
  const key = safeEmail(req.body?.email)
  if (!key) return res.status(400).json({ error: 'Valid email required' })
  const pwCheck = strongPassword(password)
  if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.error })
  if (users[key]) {
    return res.status(409).json({
      error: 'This email already has a cloud account. Sign in, or use Forgot password to set a new password — your invoices/jobs stay in the cloud.',
      code: 'email_exists',
      exists: true,
    })
  }
  const id = uuidv4()
  const hash = bcrypt.hashSync(password, 10)
  const ts = now()
  users[key] = { id, email: key, password_hash: hash, name: name || null, role: 'user', created_at: ts, updated_at: ts }
  workspaces[id] = { data: { clients: [], invoices: [], tickets: [], settings: {} }, version: 1, updated_at: ts }
  persistUsers()
  persistWorkspaces()
  const token = jwt.sign({ id, email: key }, JWT_SECRET, { expiresIn: '90d' })
  res.json({ ok: true, token, user: { id, email: key, name: name || null } })
})

app.post('/api/auth/login', loginRateLimit, (req, res) => {
  const password = req.body?.password
  const key = safeEmail(req.body?.email)
  if (!key || !password) return res.status(400).json({ error: 'Email and password required' })
  const user = users[key]
  const ok = user && bcrypt.compareSync(password, user.password_hash)
  if (!ok) {
    if (Object.keys(users).length === 0) {
      return res.status(401).json({ error: 'No accounts on server yet — Sign up once, then Sync Now from a device that has your data', code: 'empty_store' })
    }
    if (user) {
      return res.status(401).json({ error: 'Wrong password for this email. Use Forgot password — recovery code sets a new password without losing your cloud profile.', code: 'wrong_password', exists: true })
    }
    return res.status(401).json({ error: 'No account with that email. Use Sign up, or check the email spelling.', code: 'unknown_email', exists: false })
  }
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '90d' })
  res.json({ ok: true, token, user: { id: user.id, email: user.email, name: user.name } })
})

app.get('/api/auth/me', auth, (req, res) => {
  const user = Object.values(users).find((u) => u.id === req.user.id)
  if (!user) return res.status(404).json({ error: 'User not found' })
  res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, created_at: user.created_at, linkedWorkspaceOwnerId: user.linkedWorkspaceOwnerId || null, teamRole: user.teamRole || null } })
})

app.post('/api/auth/forgot-password', loginRateLimit, (req, res) => {
  const email = safeEmail(req.body?.email) || ''
  if (!email) return res.status(400).json({ error: 'Email required' })
  const user = users[email]
  if (!user) return res.json({ ok: true, message: 'If registered, a recovery code was issued.', expires_in_hours: RESET_TOKEN_HOURS })
  const token = crypto.randomBytes(32).toString('hex')
  const recovery_code = String(crypto.randomInt(100000, 999999))
  const expires = new Date(Date.now() + RESET_TOKEN_HOURS * 60 * 60 * 1000).toISOString()
  passwordResets[token] = { email, expires, used: false, created_at: now(), recovery_code }
  passwordResets['code:' + email + ':' + recovery_code] = { email, expires, used: false, created_at: now(), token, recovery_code }
  persistResets()
  res.json({ ok: true, message: 'Recovery code created. Enter it with your new password in the app.', recovery_code, expires_in_hours: RESET_TOKEN_HOURS })
})

app.post('/api/auth/reset-password', loginRateLimit, (req, res) => {
  const password = req.body?.password
  const token = req.body?.token
  const recovery_code = String(req.body?.recovery_code || req.body?.code || '').trim()
  const emailKey = safeEmail(req.body?.email) || ''
  if (!password) return res.status(400).json({ error: 'Password required' })
  const rp = strongPassword(password)
  if (!rp.ok) return res.status(400).json({ error: rp.error })
  let rec = null
  if (token && passwordResets[token]) rec = passwordResets[token]
  else if (emailKey && recovery_code) rec = passwordResets['code:' + emailKey + ':' + recovery_code]
  if (!rec || rec.used) return res.status(400).json({ error: 'Invalid or already used recovery code' })
  if (new Date(rec.expires) < new Date()) return res.status(400).json({ error: 'Recovery code expired' })
  const user = users[rec.email]
  if (!user) return res.status(400).json({ error: 'User no longer exists' })
  user.password_hash = bcrypt.hashSync(password, 10)
  user.updated_at = now()
  rec.used = true
  persistUsers()
  persistResets()
  const jwtToken = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '90d' })
  res.json({ ok: true, message: 'Password updated', token: jwtToken, user: { id: user.id, email: user.email, name: user.name } })
})

app.get('/api/workspace', auth, (req, res) => {
  const me = Object.values(users).find((u) => u.id === req.user.id)
  const ownerId = resolveWorkspaceKey({ user: me, tokenUser: req.user, workspaces })
  const row = ownerId ? workspaces[ownerId] : null
  if (!row) return res.status(404).json({ error: 'No workspace for this email yet' })
  res.json({ ok: true, version: row.version, updated_at: row.updated_at, data: row.data, ownerId, shared: ownerId !== req.user.id })
})

app.put('/api/workspace', auth, (req, res) => {
  const { data } = req.body || {}
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data object required' })
  const me = Object.values(users).find((u) => u.id === req.user.id)
  const ownerId = resolveWorkspaceKey({ user: me, tokenUser: req.user, workspaces }) || req.user.id
  const current = workspaces[ownerId] || { version: 0 }
  const newVersion = (current.version || 0) + 1
  const ts = now()
  workspaces[ownerId] = { data, version: newVersion, updated_at: ts }
  persistWorkspaces()
  res.json({ ok: true, version: newVersion, updated_at: ts, ownerId, shared: ownerId !== req.user.id })
})

app.get('/api/support/tickets', auth, (req, res) => {
  const rows = supportTickets.filter((t) => t.userId === req.user.id).slice(0, 100)
  res.json({ ok: true, tickets: rows })
})

app.post('/api/support/tickets', auth, loginRateLimit, (req, res) => {
  const subject = String(req.body?.subject || '').trim().slice(0, 120)
  const details = String(req.body?.details || '').trim().slice(0, 4000)
  const category = String(req.body?.category || 'Other').trim().slice(0, 40)
  const allowedCategories = ['Sync or data mismatch', 'Invoice or PDF issue', 'Sign-in or account issue', 'Payments or calculations', 'Bug or unexpected behaviour', 'Privacy or data request', 'Other']
  if (subject.length < 4) return res.status(400).json({ error: 'Subject must be at least 4 characters' })
  if (details.length < 10) return res.status(400).json({ error: 'Please describe the issue in at least 10 characters' })
  const actor = currentUser(req)
  if (!actor) return res.status(401).json({ error: 'Account no longer exists' })
  const id = uuidv4()
  const ticket = {
    id,
    number: 'SAIP-' + new Date().getUTCFullYear() + '-' + id.slice(0, 6).toUpperCase(),
    userId: actor.id,
    userEmail: actor.email,
    subject,
    details,
    category: allowedCategories.includes(category) ? category : 'Other',
    status: 'open',
    createdAt: now(),
    updatedAt: now(),
    replies: [],
  }
  supportTickets.unshift(ticket)
  persistSupportTickets()
  res.status(201).json({ ok: true, ticket: { id: ticket.id, number: ticket.number, subject: ticket.subject, category: ticket.category, status: ticket.status, createdAt: ticket.createdAt } })
})

app.get('/api/admin/support/tickets', auth, (req, res) => {
  if (!requireSupportAdmin(req, res)) return
  const status = String(req.query.status || '').trim()
  const rows = supportTickets.filter((t) => !status || t.status === status).slice(0, 200)
  res.json({ ok: true, tickets: rows })
})

app.patch('/api/admin/support/tickets/:id', auth, (req, res) => {
  if (!requireSupportAdmin(req, res)) return
  const ticket = supportTickets.find((t) => t.id === req.params.id || t.number === req.params.id)
  if (!ticket) return res.status(404).json({ error: 'Support ticket not found' })
  const allowedStatuses = ['open', 'in_progress', 'waiting', 'resolved', 'closed']
  const status = req.body?.status == null ? null : String(req.body.status)
  const reply = String(req.body?.reply || '').trim().slice(0, 4000)
  if (status && !allowedStatuses.includes(status)) return res.status(400).json({ error: 'Invalid ticket status' })
  if (status) ticket.status = status
  if (reply) ticket.replies.push({ id: uuidv4(), author: currentUser(req)?.email || 'Support', body: reply, createdAt: now() })
  ticket.updatedAt = now()
  persistSupportTickets()
  res.json({ ok: true, ticket })
})

app.get('/api/workspace/history', auth, (req, res) => res.json({ ok: true, history: [] }))
app.post('/api/status/push', auth, (req, res) => res.json({ ok: true, count: 0 }))
app.get('/api/notifications', auth, (req, res) => res.json({ ok: true, count: 0, unread: 0, notifications: [] }))
app.get('/api/wa/pending', auth, (req, res) => res.json({ ok: true, count: 0, clients: [] }))

app.get('/', (req, res) => {
  res.json({
    name: 'SA Invoice Pro Sync',
    version: VERSION,
    codename: '6.13.0 · client portal login · git · WA cloud',
    features: ['cloud_auth', 'auth_recover', 'workspace_sync', 'team_workspace', 'google_oauth', 'customer_portal', 'client_portal_login', 'payfast_itn', 'admin_console', 'wa_cloud_scaffold'],
    admin: PUBLIC_BASE + '/admin',
    health: PUBLIC_BASE + '/health',
    ready: PUBLIC_BASE + '/ready',
    clientPortal: PUBLIC_BASE + '/api/client-portal/health',
    git: { enabled: GIT_ENABLED },
  })
})

app.get('/admin', (_req, res) => {
  try { res.type('html').send(fs.readFileSync(path.join(__dirname, 'admin-portal.html'), 'utf8')) }
  catch (e) { res.status(404).type('text').send('Admin portal HTML missing') }
})
app.get('/admin/', (_req, res) => res.redirect(302, '/admin'))
app.get('/admin-app.js', (_req, res) => {
  try { res.type('application/javascript').send(fs.readFileSync(path.join(__dirname, 'admin-app.js'), 'utf8')) }
  catch (e) { res.status(404).type('text').send('// missing') }
})

app.get('/health', (_req, res) => {
  const warnings = []
  if (USING_DEFAULT_JWT) warnings.push('Set JWT_SECRET')
  if (USING_DEFAULT_ADMIN_PASSWORD) warnings.push('Set ADMIN_PASSWORD')
  res.json({ ok: true, version: VERSION, ts: now(), users: Object.keys(users).length, warnings, git: { enabled: gitMeta.enabled, lastPushAt: gitMeta.lastPushAt } })
})

app.get('/ready', (_req, res) => {
  const gitOk = !GIT_ENABLED || !gitMeta.lastError
  res.status(gitOk ? 200 : 503).json({ ok: gitOk, version: VERSION, users: Object.keys(users).length })
})

app.post('/api/admin/git-flush', (req, res) => {
  const header = req.headers.authorization || ''
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' })
  try { jwt.verify(header.slice(7), JWT_SECRET) } catch { return res.status(401).json({ error: 'Invalid token' }) }
  git.flushPush('manual').then((r) => res.json({ ok: !!r.ok, result: r })).catch((e) => res.status(500).json({ error: e.message }))
})

for (const name of ['./authRecover', './payfastItn', './portal', './client-portal-auth', './extras', './oauth', './team', './admin', './wa-flow', './wa-cloud', './ar-brain', './quarters', './quarters-late', './flows', './workspace-reset']) {
  try {
    const mod = require(name)
    const fn = mod.mountAuthRecover || mod.mountPayfastItn || mod.mountPortal || mod.mountClientPortal || mod.mountExtras || mod.mountOAuth || mod.mountTeam || mod.mountAdmin || mod.mountWaFlow || mod.mountWaCloud || mod.mountArBrain || mod.mountQuarters || mod.mountQuartersLate || mod.mountFlows || mod.mountWorkspaceReset || mod.mount
    if (typeof fn === 'function') {
      try {
        fn(app, { DATA_DIR, loadJson, saveJson, workspaces, auth, PUBLIC_BASE, now, users, passwordResets, persistUsers, persistWorkspaces, persistResets, JWT_SECRET, loginRateLimit, strongPassword, safeEmail, ADMIN_EMAIL: process.env.ADMIN_EMAIL || '', git, gitMeta })
        console.log('[optional]', name)
      } catch (e) {
        console.warn('[optional]', name, e.message)
      }
    }
  } catch (_) {}
}

async function boot() {
  console.log(`[saip-sync] v${VERSION} starting…`)
  await git.initOrPull()
  reloadFromDisk()
  seedAdmin()
  git.startInterval(10 * 60 * 1000)
  setTimeout(() => { git.flushPush('boot-seed').catch(() => {}) }, 8000)
  app.listen(PORT, () => {
    console.log(`SAIP Sync v${VERSION} on port ${PORT} · git=${GIT_ENABLED ? 'on' : 'off'} · users=${Object.keys(users).length}`)
  })
}

boot().catch((e) => { console.error('boot failed', e); process.exit(1) })
