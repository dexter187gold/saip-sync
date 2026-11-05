/**
 * SA Invoice Pro Sync v6.46.1 — portal · client login · git data · WA Cloud
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
const { resolveWorkspaceKey, isReadOnlyTeamMember, isTeamMember, filterTeamWorkspaceData, mergeTeamWorkspaceData } = require('./workspace-owner')
const { consumeRecoveryRecords } = require('./recovery-records')

const {
  mountSecurity,
  loginRateLimit,
  registerRateLimit,
  strongPassword,
  safeEmail,
} = require('./security')

const app = express()
// Render terminates TLS and appends the client address to X-Forwarded-For.
// Trust exactly that single proxy hop; rate limiting then uses Express req.ip,
// never a caller-controlled header value.
app.set('trust proxy', 1)
const PORT = process.env.PORT || 3847
const JWT_SECRET = String(process.env.JWT_SECRET || '')
const LEGACY_DEFAULT_ADMIN_PASSWORD = 'Admin@SAIP2026!'
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://saip-sync.onrender.com'
const RESET_TOKEN_HOURS = 1
const DEFAULT_ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '')
const USING_DEFAULT_ADMIN_PASSWORD = !DEFAULT_ADMIN_PASSWORD
const USING_DEFAULT_JWT = !JWT_SECRET || JWT_SECRET.length < 32 || JWT_SECRET === 'dev-secret-change-me'
const VERSION = '6.46.1'

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
    try { fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8') } catch (e2) { console.error(e2.message) }
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
function persistUsers() { saveJson(USERS_FILE, users); git.schedulePush('users') }
function persistWorkspaces() { saveJson(WORKSPACES_FILE, workspaces); git.schedulePush('workspaces') }
function persistResets() { saveJson(RESET_FILE, passwordResets); git.schedulePush('resets') }
function persistSupportTickets() { saveJson(SUPPORT_FILE, supportTickets); git.schedulePush('support-tickets') }
function currentUser(req) { return Object.values(users).find((u) => u.id === req.user?.id) || null }
function requireSupportAdmin(req, res) {
  const actor = currentUser(req)
  if (!actor || actor.role !== 'admin') { res.status(403).json({ error: 'Administrator access required' }); return null }
  return actor
}
function now() { return new Date().toISOString() }

function seedAdmin() {
  const defaults = ['admin@sainvoice.pro']
  const envEmail = (process.env.ADMIN_EMAIL || '').toLowerCase().trim()
  if (envEmail && !defaults.includes(envEmail)) defaults.push(envEmail)
  for (const key of defaults) {
    if (!users[key]) {
      const id = uuidv4()
      users[key] = { id, email: key, password_hash: bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, 10), name: 'Administrator', role: 'admin', created_at: now(), updated_at: now() }
      workspaces[id] = { data: { clients: [], invoices: [], tickets: [], settings: {} }, version: 1, updated_at: now() }
      console.log('[admin] seeded', key)
    } else {
      let changed = false
      if (users[key].role !== 'admin') { users[key].role = 'admin'; changed = true }
      if (!users[key].password_hash) { users[key].password_hash = bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, 10); changed = true }
      else if (bcrypt.compareSync(LEGACY_DEFAULT_ADMIN_PASSWORD, users[key].password_hash)) {
        users[key].password_hash = bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, 10)
        changed = true
        console.log('[admin] migrated legacy default password for', key)
      }
      if (changed) users[key].updated_at = now()
    }
  }
  persistUsers(); persistWorkspaces()
}

mountSecurity(app, {})
app.use(express.json({ limit: '8mb' }))
app.use(express.urlencoded({ extended: true, limit: '1mb' }))

function issueSessionToken(user) {
  return jwt.sign({ id: user.id, email: user.email, sv: Number(user.session_version || 0) }, JWT_SECRET, { expiresIn: '90d' })
}

function auth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Missing token' })
  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    const user = Object.values(users).find((u) => u.id === decoded.id)
    if (!user || Number(decoded.sv || 0) !== Number(user.session_version || 0)) {
      return res.status(401).json({ error: 'Session revoked. Please sign in again.' })
    }
    req.user = decoded
    next()
  } catch { return res.status(401).json({ error: 'Invalid or expired token' }) }
}

app.post('/api/auth/register', registerRateLimit, (req, res) => {
  const { password, name } = req.body || {}
  const key = safeEmail(req.body?.email)
  if (!key) return res.status(400).json({ error: 'Valid email required' })
  const pwCheck = strongPassword(password)
  if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.error })
  if (users[key]) return res.status(409).json({ error: 'This email already has a cloud account.', code: 'email_exists', exists: true })
  const id = uuidv4()
  const hash = bcrypt.hashSync(password, 10)
  const ts = now()
  users[key] = { id, email: key, password_hash: hash, name: name || null, role: 'user', created_at: ts, updated_at: ts }
  workspaces[id] = { data: { clients: [], invoices: [], tickets: [], settings: {} }, version: 1, updated_at: ts }
  persistUsers(); persistWorkspaces()
  const token = issueSessionToken(users[key])
  res.json({ ok: true, token, user: { id, email: key, name: name || null } })
})

app.post('/api/auth/login', loginRateLimit, (req, res) => {
  const password = req.body?.password
  const key = safeEmail(req.body?.email)
  if (!key || !password) return res.status(400).json({ error: 'Email and password required' })
  const user = users[key]
  const ok = user && bcrypt.compareSync(password, user.password_hash)
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' })
  const token = issueSessionToken(user)
  res.json({ ok: true, token, user: { id: user.id, email: user.email, name: user.name } })
})

app.get('/api/auth/me', auth, (req, res) => {
  const user = Object.values(users).find((u) => u.id === req.user.id)
  if (!user) return res.status(404).json({ error: 'User not found' })
  res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name } })
})

app.post('/api/auth/logout', auth, (req, res) => {
  const user = Object.values(users).find((u) => u.id === req.user.id)
  if (!user) return res.status(401).json({ error: 'Account not found' })
  user.session_version = Number(user.session_version || 0) + 1
  user.updated_at = now()
  persistUsers()
  res.json({ ok: true, message: 'Session revoked. Sign in again to continue.' })
})

async function deliverRecoveryCode(email, code) {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim()
  const from = String(process.env.RESEND_FROM_EMAIL || '').trim()
  if (!apiKey || !from) return false
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [email],
      subject: 'SA Invoice Pro password recovery',
      text: 'Your SA Invoice Pro recovery code is ' + code + '. It expires in one hour. If you did not request this, ignore this email.',
    }),
  })
  return response.ok
}

app.post('/api/auth/forgot-password', loginRateLimit, async (req, res) => {
  const email = safeEmail(req.body?.email) || ''
  if (!email) return res.status(400).json({ error: 'Email required' })
  const genericRecoveryResponse = () => ({ ok: true, message: 'If the account exists, recovery instructions will be sent.', expires_in_hours: RESET_TOKEN_HOURS })
  const user = users[email]
  if (!user) return res.json(genericRecoveryResponse())
  const token = crypto.randomBytes(32).toString('hex')
  const recovery_code = String(crypto.randomInt(100000, 999999))
  const expires = new Date(Date.now() + RESET_TOKEN_HOURS * 60 * 60 * 1000).toISOString()
  let delivered = false
  try { delivered = await deliverRecoveryCode(email, recovery_code) } catch (e) { console.warn('[auth] recovery email delivery failed', e.message) }
  if (!delivered) return res.json(genericRecoveryResponse())
  const codeHash = crypto.createHash('sha256').update(recovery_code).digest('hex')
  passwordResets[token] = { email, expires, used: false, created_at: now(), recovery_code_hash: codeHash }
  passwordResets['code:' + email + ':' + codeHash] = { email, expires, used: false, created_at: now(), token, recovery_code_hash: codeHash }
  persistResets()
  res.json({ ok: true, message: 'If the account exists, recovery instructions will be sent.', expires_in_hours: RESET_TOKEN_HOURS })
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
  else if (emailKey && recovery_code) { const codeHash = crypto.createHash('sha256').update(recovery_code).digest('hex'); rec = passwordResets['code:' + emailKey + ':' + codeHash] }
  if (!rec || rec.used) return res.status(400).json({ error: 'Invalid or already used recovery code' })
  if (new Date(rec.expires) < new Date()) return res.status(400).json({ error: 'Recovery code expired' })
  const user = users[rec.email]
  if (!user) return res.status(400).json({ error: 'User no longer exists' })
  user.password_hash = bcrypt.hashSync(password, 10)
  user.session_version = Number(user.session_version || 0) + 1
  user.updated_at = now()
  consumeRecoveryRecords(passwordResets, rec)
  persistUsers(); persistResets()
  const jwtToken = issueSessionToken(user)
  res.json({ ok: true, message: 'Password updated', token: jwtToken, user: { id: user.id, email: user.email, name: user.name } })
})

app.get('/api/workspace', auth, (req, res) => {
  const me = Object.values(users).find((u) => u.id === req.user.id)
  const ownerId = resolveWorkspaceKey({ user: me, tokenUser: req.user, workspaces })
  const row = ownerId ? workspaces[ownerId] : null
  if (!row) return res.status(404).json({ error: 'No workspace' })
  const data = isTeamMember(me) ? filterTeamWorkspaceData(row.data, me.teamRole) : row.data
  res.json({ ok: true, version: row.version, updated_at: row.updated_at, data, ownerId })
})

app.put('/api/workspace', auth, (req, res) => {
  const { data } = req.body || {}
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data object required' })
  const me = Object.values(users).find((u) => u.id === req.user.id)
  if (isReadOnlyTeamMember(me)) {
    return res.status(403).json({ error: 'This workspace role is read-only' })
  }
  const ownerId = resolveWorkspaceKey({ user: me, tokenUser: req.user, workspaces }) || req.user.id
  const current = workspaces[ownerId] || { version: 0, data: {} }
  const newVersion = (current.version || 0) + 1
  const ts = now()
  const savedData = isTeamMember(me) ? mergeTeamWorkspaceData(current.data, data, me.teamRole) : data
  workspaces[ownerId] = { data: savedData, version: newVersion, updated_at: ts }
  persistWorkspaces()
  res.json({ ok: true, version: newVersion, updated_at: ts, ownerId })
})

app.get('/api/support/tickets', auth, (req, res) => {
  res.json({ ok: true, tickets: supportTickets.filter((t) => t.userId === req.user.id).slice(0, 100) })
})
app.post('/api/support/tickets', auth, loginRateLimit, (req, res) => {
  const subject = String(req.body?.subject || '').trim().slice(0, 120)
  const details = String(req.body?.details || '').trim().slice(0, 4000)
  if (subject.length < 4 || details.length < 10) return res.status(400).json({ error: 'Subject and details required' })
  const actor = currentUser(req)
  if (!actor) return res.status(401).json({ error: 'Account missing' })
  const id = uuidv4()
  const ticket = { id, number: 'SAIP-' + id.slice(0, 6).toUpperCase(), userId: actor.id, userEmail: actor.email, subject, details, status: 'open', createdAt: now(), updatedAt: now(), replies: [] }
  supportTickets.unshift(ticket); persistSupportTickets()
  res.status(201).json({ ok: true, ticket })
})
app.get('/api/admin/support/tickets', auth, (req, res) => {
  if (!requireSupportAdmin(req, res)) return
  res.json({ ok: true, tickets: supportTickets.slice(0, 200) })
})
app.patch('/api/admin/support/tickets/:id', auth, (req, res) => {
  if (!requireSupportAdmin(req, res)) return
  const ticket = supportTickets.find((t) => t.id === req.params.id)
  if (!ticket) return res.status(404).json({ error: 'Not found' })
  if (req.body?.status) ticket.status = String(req.body.status)
  ticket.updatedAt = now(); persistSupportTickets()
  res.json({ ok: true, ticket })
})

app.get('/api/workspace/history', auth, (req, res) => res.json({ ok: true, history: [] }))
app.post('/api/status/push', auth, (req, res) => res.json({ ok: true, count: 0 }))
app.get('/api/wa/pending', auth, (req, res) => res.json({ ok: true, count: 0, clients: [] }))

app.get('/', (req, res) => {
  res.json({
    name: 'SA Invoice Pro Sync',
    version: VERSION,
    codename: '6.46.1 · health · WA dual paths',
    features: ['cloud_auth', 'workspace_sync', 'team_workspace', 'client_portal', 'payfast_itn', 'wa_cloud'],
    admin: PUBLIC_BASE + '/admin',
    health: PUBLIC_BASE + '/health',
    apiHealth: PUBLIC_BASE + '/api/health',
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

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: VERSION, ts: now(), service: 'saip-sync' })
})

app.get('/health', (_req, res) => {
  const warnings = []
  if (USING_DEFAULT_JWT) warnings.push('JWT_SECRET is missing or weak')
  if (USING_DEFAULT_ADMIN_PASSWORD) warnings.push('ADMIN_PASSWORD is missing')
  res.json({ ok: true, version: VERSION, ts: now(), users: Object.keys(users).length, warnings, git: { enabled: gitMeta.enabled, lastPushAt: gitMeta.lastPushAt } })
})

app.get('/ready', (_req, res) => {
  const gitOk = !GIT_ENABLED || !gitMeta.lastError
  res.status(gitOk ? 200 : 503).json({ ok: gitOk, version: VERSION, users: Object.keys(users).length })
})

app.post('/api/admin/git-flush', auth, (req, res) => {
  if (!requireSupportAdmin(req, res)) return
  git.flushPush('manual').then((r) => res.json({ ok: !!r.ok, result: r })).catch((e) => res.status(500).json({ error: e.message }))
})

for (const name of ['./authRecover', './payfastItn', './portal', './client-portal-auth', './extras', './oauth', './team', './admin', './wa-flow', './wa-cloud', './ar-brain', './quarters', './quarters-late', './flows', './workspace-reset', './devops']) {
  try {
    const mod = require(name)
    const fn = mod.mountAuthRecover || mod.mountPayfastItn || mod.mountPortal || mod.mountClientPortal || mod.mountExtras || mod.mountOAuth || mod.mountTeam || mod.mountAdmin || mod.mountWaFlow || mod.mountWaCloud || mod.mountArBrain || mod.mountQuarters || mod.mountQuartersLate || mod.mountFlows || mod.mountWorkspaceReset || mod.mountDevops || mod.mount
    if (typeof fn === 'function') {
      try {
        fn(app, { DATA_DIR, loadJson, saveJson, workspaces, auth, PUBLIC_BASE, now, users, passwordResets, persistUsers, persistWorkspaces, persistResets, JWT_SECRET, loginRateLimit, strongPassword, safeEmail, ADMIN_EMAIL: process.env.ADMIN_EMAIL || '', git, gitMeta })
        console.log('[optional]', name)
      } catch (e) { console.warn('[optional]', name, e.message) }
    }
  } catch (_) {}
}

async function boot() {
  if (USING_DEFAULT_JWT) throw new Error('Refusing to start: configure a random JWT_SECRET of at least 32 characters')
  if (USING_DEFAULT_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD.length < 12) throw new Error('Refusing to start: configure ADMIN_PASSWORD with at least 12 characters')
  console.log(`[saip-sync] v${VERSION} starting…`)
  await git.initOrPull()
  reloadFromDisk()
  seedAdmin()
  git.startInterval(10 * 60 * 1000)
  app.listen(PORT, () => console.log(`[saip-sync] listening on ${PORT}`))
}

boot().catch((e) => { console.error(e); process.exit(1) })
