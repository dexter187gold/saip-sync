/**
 * Team workspace linking — invite codes + shared workspace ownership.
 */
const crypto = require('crypto')

function mountTeam(app, ctx) {
  const { users, workspaces, persistUsers, persistWorkspaces, auth, now } = ctx
  const invites = global.__saip_invites || (global.__saip_invites = {})

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
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.teamRole || (u.id === ownerId ? 'owner' : 'member'),
        isOwner: u.id === ownerId,
        linkedAt: u.linkedAt || null,
      }))
    res.json({
      ok: true,
      owner: owner ? { id: owner.id, email: owner.email, name: owner.name } : null,
      linkedWorkspaceOwnerId: me?.linkedWorkspaceOwnerId || null,
      isOwner: me?.id === ownerId,
      members,
    })
  })

  app.post('/api/team/invite', auth, (req, res) => {
    const me = userById(req.user.id)
    if (!me) return res.status(404).json({ error: 'User not found' })
    if (me.linkedWorkspaceOwnerId) {
      return res.status(403).json({ error: 'Only the workspace owner can create invites' })
    }
    const role = String(req.body?.role || 'tech').slice(0, 32)
    const code = crypto.randomBytes(4).toString('hex')
    const expires = new Date(Date.now() + 7 * 86400000).toISOString()
    invites[code] = {
      ownerId: me.id,
      ownerEmail: me.email,
      role,
      expires,
      createdAt: typeof now === 'function' ? now() : new Date().toISOString(),
    }
    res.json({
      ok: true,
      code,
      expires,
      role,
      message: 'Share this code with a teammate. They sign in then enter the code under Team.',
    })
  })

  app.post('/api/team/join', auth, (req, res) => {
    const code = String(req.body?.code || '').trim().toLowerCase()
    if (!code || !invites[code]) return res.status(400).json({ error: 'Invalid invite code' })
    const inv = invites[code]
    if (inv.expires && new Date(inv.expires) < new Date()) {
      delete invites[code]
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
    const owner = userById(inv.ownerId)
    res.json({
      ok: true,
      linkedWorkspaceOwnerId: inv.ownerId,
      ownerEmail: owner?.email || inv.ownerEmail,
      role: me.teamRole,
      message: 'Linked to team workspace. Pull cloud data to load the shared profile.',
    })
  })

  app.post('/api/team/leave', auth, (req, res) => {
    const me = userById(req.user.id)
    if (!me) return res.status(404).json({ error: 'User not found' })
    if (!me.linkedWorkspaceOwnerId) {
      return res.status(400).json({ error: 'You are not linked to another workspace' })
    }
    me.linkedWorkspaceOwnerId = null
    me.teamRole = null
    me.linkedAt = null
    me.updated_at = typeof now === 'function' ? now() : new Date().toISOString()
    if (typeof persistUsers === 'function') persistUsers()
    res.json({ ok: true, message: 'Left team workspace' })
  })

  app.post('/api/team/remove', auth, (req, res) => {
    const me = userById(req.user.id)
    if (!me || me.linkedWorkspaceOwnerId) {
      return res.status(403).json({ error: 'Only the workspace owner can remove members' })
    }
    const member = userById(req.body?.userId)
    if (!member || member.linkedWorkspaceOwnerId !== me.id) {
      return res.status(404).json({ error: 'Member not found in your team' })
    }
    member.linkedWorkspaceOwnerId = null
    member.teamRole = null
    member.linkedAt = null
    if (typeof persistUsers === 'function') persistUsers()
    res.json({ ok: true })
  })

  app.get('/api/workspace/team', auth, (req, res) => {
    const ownerId = workspaceOwnerId(req.user)
    const row = workspaces[ownerId]
    if (!row) return res.status(404).json({ error: 'No workspace' })
    res.json({ ok: true, version: row.version, updated_at: row.updated_at, data: row.data, ownerId, shared: ownerId !== req.user.id })
  })

  app.put('/api/workspace/team', auth, (req, res) => {
    const { data } = req.body || {}
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data object required' })
    const ownerId = workspaceOwnerId(req.user)
    const current = workspaces[ownerId] || { version: 0 }
    const newVersion = (current.version || 0) + 1
    const ts = typeof now === 'function' ? now() : new Date().toISOString()
    workspaces[ownerId] = { data, version: newVersion, updated_at: ts }
    if (typeof persistWorkspaces === 'function') persistWorkspaces()
    res.json({ ok: true, version: newVersion, updated_at: ts, ownerId, shared: ownerId !== req.user.id })
  })

  console.log('[team] workspace linking · invites mounted')
}

module.exports = { mountTeam }
