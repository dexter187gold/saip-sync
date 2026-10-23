/**
 * SA Invoice Pro Sync — auth + workspace + git-durable store v5.8.0
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
const VERSION = '5.8.0'

const DATA_DIR = path.join(__dirname, 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const WORKSPACES_FILE = path.join(DATA_DIR, 'workspaces.json')
const RESET_FILE = path.join(DATA_DIR, 'password_resets.json')

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

function reloadFromDisk() {
  const u = loadJson(USERS_FILE, {})
  const w = loadJson(WORKSPACES_FILE, {})
  const r = loadJson(RESET_FILE, {})
  for (const k of Object.keys(users)) delete users[k]
  Object.assign(users, u)
  for (const k of Object.keys(workspaces)) delete workspaces[k]
  Object.assign(workspaces, w)
  for (const k of Object.keys(passwordResets)) delete passwordResets[k]
  Object.assign(passwordResets, r)
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
function now() {
  return new Date().toISOString()
}

function seedAdmin() {
  const defaults = ['admin@sainvoice.pro']
  const envEmail = (process.env.ADMIN_EMAIL || '').toLowerCase().trim()
  if (envEmail && !defaults.includes(envEmail)) defaults.push(envEmail)
  for (const key of defaults) {
    if (!users[key]) {
      const id = uuidv4()
      users[key] = {
        id,
        email: key,
        password_hash: bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, 10),
        name: 'Lab Director',
        role: 'admin',
        created_at: now(),
        updated_at: now(),
      }
      workspaces[id] = {
        data: { clients: [], invoices: [], tickets: [], settings: {} },
        version: 1,
        updated_at: now(),
      }
      console.log('[admin] seeded', key)
    } else if (users[key].role !== 'admin') {
      users[key].role = 'admin'
      users[key].updated_at = now()
      console.log('[admin] promoted', key)
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
  if (users[key]) return res.status(409).json({ error: 'Email already registered' })
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
    const wipedHint = Object.keys(users).length === 0
      ? ' (server may have restarted with empty storage — create account again, then Sync Now from your original device)'
      : ''
    return res.status(401).json({ error: 'Invalid email or password' + wipedHint })
  }
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '90d' })
  res.json({ ok: true, token, user: { id: user.id, email: user.email, name: user.name } })
})

app.get('/api/auth/me', auth, (req, res) => {
  const user = Object.values(users).find((u) => u.id === req.user.id)
  if (!user) return res.status(404).json({ error: 'User not found' })
  res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, created_at: user.created_at } })
})

app.post('/api/auth/forgot-password', loginRateLimit, (req, res) => {
  const email = safeEmail(req.body?.email) || ''
  if (!email) return res.status(400).json({ error: 'Email required' })
  const user = users[email]
  if (!user) {
    return res.json({ ok: true, message: 'If that email is registered, a recovery code was issued.', expires_in_hours: RESET_TOKEN_HOURS })
  }
  const token = crypto.randomBytes(32).toString('hex')
  const recovery_code = String(crypto.randomInt(100000, 999999))
  const expires = new Date(Date.now() + RESET_TOKEN_HOURS * 60 * 60 * 1000).toISOString()
  passwordResets[token] = { email, expires, used: false, created_at: now(), recovery_code }
  passwordResets['code:' + email + ':' + recovery_code] = { email, expires, used: false, created_at: now(), token, recovery_code }
  persistResets()
  console.log('[auth] recovery code for', email, recovery_code)
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
  if (new Date(rec.expires) < new Date()) return res.status(400).json({ error: 'Recovery code has expired — request a new one' })
  const user = users[rec.email]
  if (!user) return res.status(400).json({ error: 'User no longer exists' })
  user.password_hash = bcrypt.hashSync(password, 10)
  user.updated_at = now()
  rec.used = true
  if (rec.token && passwordResets[rec.token]) passwordResets[rec.token].used = true
  if (rec.recovery_code) {
    const ck = 'code:' + rec.email + ':' + rec.recovery_code
    if (passwordResets[ck]) passwordResets[ck].used = true
  }
  persistUsers()
  persistResets()
  const jwtToken = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '90d' })
  res.json({ ok: true, message: 'Password updated — you are signed in', token: jwtToken, user: { id: user.id, email: user.email, name: user.name } })
})

app.get('/api/workspace', auth, (req, res) => {
  const row = workspaces[req.user.id]
  if (!row) return res.status(404).json({ error: 'No workspace' })
  res.json({ ok: true, version: row.version, updated_at: row.updated_at, data: row.data })
})

app.put('/api/workspace', auth, (req, res) => {
  const { data } = req.body || {}
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data object required' })
  const current = workspaces[req.user.id] || { version: 0 }
  const newVersion = (current.version || 0) + 1
  const ts = now()
  workspaces[req.user.id] = { data, version: newVersion, updated_at: ts }
  persistWorkspaces()
  res.json({ ok: true, version: newVersion, updated_at: ts })
})

app.get('/api/workspace/history', auth, (req, res) => res.json({ ok: true, history: [] }))
app.post('/api/status/push', auth, (req, res) => res.json({ ok: true, count: 0 }))
app.get('/api/notifications', auth, (req, res) => res.json({ ok: true, count: 0, unread: 0, notifications: [] }))
app.get('/api/wa/pending', auth, (req, res) => res.json({ ok: true, count: 0, clients: [] }))

app.get('/', (req, res) => {
  res.json({
    name: 'SA Invoice Pro Sync',
    version: VERSION,
    codename: 'Git-durable sync · 5-min interval',
    features: ['cloud_auth', 'recovery_codes', 'workspace_sync', 'git_durable'],
    admin: PUBLIC_BASE + '/admin',
    git: { enabled: GIT_ENABLED },
  })
})

app.get('/admin-app.js', (_req, res) => {
  try {
    res.type('application/javascript').send(fs.readFileSync(path.join(__dirname, 'admin-app.js'), 'utf8'))
  } catch (e) {
    res.status(404).type('text').send('// admin-app.js missing')
  }
})

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    ts: now(),
    version: VERSION,
    theme: 'pinky-and-the-brain',
    git: {
      enabled: gitMeta.enabled,
      lastPullAt: gitMeta.lastPullAt,
      lastPushAt: gitMeta.lastPushAt,
      lastCommit: gitMeta.lastCommit,
      pushes: gitMeta.pushes,
      pulls: gitMeta.pulls,
      error: gitMeta.lastError,
    },
    users: Object.keys(users).length,
  })
)

for (const name of ['./portal', './admin', './wa-flow', './ar-brain', './quarters', './quarters-late', './flows']) {
  try {
    const mod = require(name)
    const fn =
      mod.mountPortal || mod.mountAdmin || mod.mountWaFlow || mod.mountArBrain ||
      mod.mountQuarters || mod.mountQuartersLate || mod.mountFlows || mod.mount
    if (typeof fn === 'function') {
      try {
        fn(app, {
          DATA_DIR, loadJson, saveJson, workspaces, auth, PUBLIC_BASE, now, users,
          persistUsers, persistWorkspaces, persistResets, JWT_SECRET,
          ADMIN_EMAIL: process.env.ADMIN_EMAIL || '',
        })
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
  app.listen(PORT, () => {
    console.log(`SAIP Sync v${VERSION} on port ${PORT} · git=${GIT_ENABLED ? 'on' : 'off'} · users=${Object.keys(users).length}`)
  })
}

boot().catch((e) => {
  console.error('boot failed', e)
  process.exit(1)
})
