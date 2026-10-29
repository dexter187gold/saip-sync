/**
 * Team workspace linking — disk-persisted invite codes.
 */
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')

function mountTeam(app, ctx) {
  const { users, workspaces, persistUsers, persistWorkspaces, auth, now, DATA_DIR } = ctx
  const INVITES_FILE = path.join(DATA_DIR || path.join(__dirname, 'data'), 'team_invites.json')

  function loadInvites() {
    try {
      if (fs.existsSync(INVITES_FILE)) return JSON.parse(fs.readFileSync(INVITES_FILE, 'utf8'))
    } catch (e) {
      console.warn('[team] load invites', e.message)
    }
    return {}
  }
  function saveInvites(obj) {
    try {
      fs.mkdirSync(path.dirname(INVITES_FILE), { recursive: true })
      const tmp = INVITES_FILE + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
      fs.renameSync(tmp, INVITES_FILE)
    } catch (e) {
      console.warn('[team] save invites', e.message)
    }
  }

  let invites = loadInvites()

  function userById(id) {
    return Object.values(users).find((u) => u.id === id) || null
  }
  function workspaceOwnerId(reqUser) {
    const u = userById(reqUser.id) || users[reqUser.email]
    if (u?.linkedWorkspaceOwnerId) return u.linkedWorkspaceOwnerId
    return reqUser.id
  }

  app.get('/api/team', auth, (req, res) => {
    const me = userById(req.user.id)
    const ownerId = workspaceOwnerId(req.user)
    const owner = userById(ownerId)
    const members = Object.values(users)
      .filter((u) => u.id === ownerId || u.linkedWorkspaceOwnerId === ownerId)
      .map((u) => ({
        id: u.id, email: u.email, name: u.name,
        role: u.teamRole || (u.id === ownerId ? 'owner' : 'member'),
        isOwner: u.id === ownerId, linkedAt: u.linkedAt || null,
      }))
    const myInvites = Object.entries(invites)
      .filter(([, v]) => v.ownerId === ownerId)
      .map(([code, v]) => ({ code, role: v.role, expires: v.expires, createdAt: v.createdAt }))
    res.json({
      ok: true,
      owner: owner ? { id: owner.id, email: owner.email, name: owner.name } : null,
      linkedWorkspaceOwnerId: me?.linkedWorkspaceOwnerId || null,
      isOwner: me?.id === ownerId,
      members,
      openInvites: me?.id === ownerId ? myInvites : [],
    })
  })

  app.post('/api/team/invite', auth, (req, res) => {
    const me = userById(req.user.id)
    if (!me) return res.status(404).json({ error: 'User not found' })
    if (me.linkedWorkspaceOwnerId) return res.status(403).json({ error: 'Only the workspace owner can create invites' })
    const role = String(req.body?.role || 'tech').slice(0, 32)
    const code = crypto.randomBytes(4).toString('hex')
    const expires = new Date(Date.now() + 7 * 86400000).toISOString()
    invites[code] = {
      ownerId: me.id, ownerEmail: me.email, role, expires,
      createdAt: typeof now === 'function' ? now() : new Date().toISOString(),
    }
    saveInvites(invites)
    res.json({ ok: true, code, expires, role, message: 'Share code with teammate after they sign in.' })
  })

  app.post('/api/team/join', auth, (req, res) => {
    const code = String(req.body?.code || '').trim().toLowerCase()
    invites = loadInvites()
    if (!code || !invites[code]) return res.status(400).json({ error: 'Invalid invite code' })
    const inv = invites[code]
    if (inv.expires && new Date(inv.expires) < new Date()) {
      delete invites[code]; saveInvites(invites)
      return res.status(410).json({ error: 'Invite code expired' })
    }
    const me = userById(req.user.id)
    if (!me) return res.status(404).json({ error: 'User not found' })
    if (me.id === inv.ownerId) return res.status(400).json({ error: 'You already own this workspace' })
    me.linkedWorkspaceOwnerId = inv.ownerId
    me.teamRole = inv.role || 'member'
    me.linkedAt = typeof now === 'function' ? now() : new Date().toISOString()
    me.updated_at = me.linkedAt
    if (typeof persistUsers === 'function') persistUsers()
    delete invites[code]
    saveInvites(invites)
    const owner = userById(inv.ownerId)
    res.json({
      ok: true, linkedWorkspaceOwnerId: inv.ownerId,
      ownerEmail: owner?.email || inv.ownerEmail, role: me.teamRole,
      message: 'Linked to team workspace. Pull cloud to load shared profile.',
    })
  })

  app.post('/api/team/leave', auth, (req, res) => {
    const me = userById(req.user.id)
    if (!me) return res.status(404).json({ error: 'User not found' })
    if (!me.linkedWorkspaceOwnerId) return res.status(400).json({ error: 'Not linked to another workspace' })
    me.linkedWorkspaceOwnerId = null
    me.teamRole = null
    me.linkedAt = null
    if (typeof persistUsers === 'function') persistUsers()
    res.json({ ok: true })
  })

  app.post('/api/team/member-role', auth, (req, res) => {
    const me = userById(req.user.id)
    if (!me || me.linkedWorkspaceOwnerId) return res.status(403).json({ error: 'Only the workspace owner can change member roles' })

    const member = userById(req.body?.userId)
    if (!member || member.linkedWorkspaceOwnerId !== me.id) return res.status(404).json({ error: 'Workspace member not found' })
    if (member.id === me.id) return res.status(400).json({ error: 'Owner role cannot be changed through member management' })

    const allowedRoles = new Set(['admin', 'manager', 'front_desk', 'helpdesk', 'tech', 'accountant', 'viewer'])
    const role = String(req.body?.role || '').trim().toLowerCase()
    if (!allowedRoles.has(role)) return res.status(400).json({ error: 'Invalid team role' })

    const previousRole = member.teamRole || 'member'
    member.teamRole = role
    member.updated_at = typeof now === 'function' ? now() : new Date().toISOString()
    if (typeof persistUsers === 'function') persistUsers()

    // Best-effort append-only audit trail; never include passwords or tokens.
    try {
      const auditFile = path.join(DATA_DIR || path.join(__dirname, 'data'), 'team_audit.json')
      let events = []
      try { if (fs.existsSync(auditFile)) events = JSON.parse(fs.readFileSync(auditFile, 'utf8')) } catch {}
      events.push({
        action: 'team.member_role_changed',
        actorId: me.id,
        actorEmail: me.email,
        targetId: member.id,
        targetEmail: member.email,
        previousRole,
        newRole: role,
        at: typeof now === 'function' ? now() : new Date().toISOString(),
      })
      fs.mkdirSync(path.dirname(auditFile), { recursive: true })
      const tmp = auditFile + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(events.slice(-1000), null, 2), 'utf8')
      fs.renameSync(tmp, auditFile)
    } catch (e) {
      console.warn('[team] role audit write failed', e.message)
    }

    res.json({ ok: true, userId: member.id, role, previousRole })
  })

  app.post('/api/team/remove', auth, (req, res) => {
    const me = userById(req.user.id)
    if (!me || me.linkedWorkspaceOwnerId) return res.status(403).json({ error: 'Owner only' })
    const member = userById(req.body?.userId)
    if (!member || member.linkedWorkspaceOwnerId !== me.id) return res.status(404).json({ error: 'Member not found' })
    member.linkedWorkspaceOwnerId = null
    member.teamRole = null
    if (typeof persistUsers === 'function') persistUsers()
    res.json({ ok: true })
  })

  console.log('[team] disk-persisted invites')
}

module.exports = { mountTeam }
