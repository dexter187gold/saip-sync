/**
 * Owner-verified, PIN-protected workspace reset.
 * Resets only the authenticated owner's tenant; preserves owner login and
 * unrelated tenants. A private snapshot is committed before the reset.
 */
const bcrypt = require('bcryptjs')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

function mountWorkspaceReset(app, ctx) {
  const {
    users, workspaces, auth, DATA_DIR, git, now,
    loginRateLimit = (_req, _res, next) => next(),
  } = ctx

  const files = {
    users: path.join(DATA_DIR, 'users.json'),
    workspaces: path.join(DATA_DIR, 'workspaces.json'),
    snapshots: path.join(DATA_DIR, 'workspace_reset_snapshots.json'),
    audit: path.join(DATA_DIR, 'workspace_reset_audit.json'),
    portals: path.join(DATA_DIR, 'client_portal_accounts.json'),
    invites: path.join(DATA_DIR, 'team_invites.json'),
    tickets: path.join(DATA_DIR, 'support-tickets.json'),
  }
  const timestamp = () => typeof now === 'function' ? now() : new Date().toISOString()
  const read = (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
  }
  const push = (reason) => {
    if (git && typeof git.schedulePush === 'function') git.schedulePush(reason)
  }

  function owner(req, res) {
    const actor = Object.values(users).find((u) => u.id === req.user?.id)
    if (!actor) {
      res.status(401).json({ error: 'Cloud account no longer exists' })
      return null
    }
    if (actor.linkedWorkspaceOwnerId) {
      res.status(403).json({ error: 'Only the verified workspace owner can reset this workspace' })
      return null
    }
    return actor
  }

  // Stage every JSON file first, then rename. If a rename fails, restore the
  // previous file contents before returning an error.
  function commitFiles(nextByName) {
    const staged = []
    const previous = new Map()
    try {
      for (const [name, value] of Object.entries(nextByName)) {
        const file = files[name]
        fs.mkdirSync(path.dirname(file), { recursive: true })
        previous.set(file, fs.existsSync(file) ? fs.readFileSync(file) : null)
        const temp = file + '.reset-' + crypto.randomUUID() + '.tmp'
        fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
        // Validate the staged JSON before it can replace a live file.
        JSON.parse(fs.readFileSync(temp, 'utf8'))
        staged.push({ file, temp })
      }
      for (const item of staged) fs.renameSync(item.temp, item.file)
    } catch (error) {
      for (const item of staged) {
        try { if (fs.existsSync(item.temp)) fs.unlinkSync(item.temp) } catch {}
      }
      for (const [file, bytes] of previous.entries()) {
        try {
          if (bytes == null) {
            if (fs.existsSync(file)) fs.unlinkSync(file)
          } else {
            const rollback = file + '.rollback.tmp'
            fs.writeFileSync(rollback, bytes)
            fs.renameSync(rollback, file)
          }
        } catch (rollbackError) {
          console.error('[workspace-reset] rollback failed', file, rollbackError.message)
        }
      }
      throw error
    }
  }

  app.post('/api/workspace/reset-pin', auth, loginRateLimit, (req, res) => {
    const actor = owner(req, res)
    if (!actor) return
    const pin = String(req.body?.pin || '')
    const confirmPin = String(req.body?.confirmPin || '')
    if (!/^\\d{6,12}$/.test(pin)) return res.status(400).json({ error: 'Recovery PIN must be 6–12 digits' })
    if (pin !== confirmPin) return res.status(400).json({ error: 'PIN entries do not match' })
    actor.workspaceResetPinHash = bcrypt.hashSync(pin, 12)
    actor.workspaceResetPinUpdatedAt = timestamp()
    const nextUsers = { ...users, [actor.email]: actor }
    commitFiles({ users: nextUsers })
    Object.assign(users, nextUsers)
    push('workspace-reset-pin')
    res.json({ ok: true, message: 'Workspace reset PIN saved. It is never returned by the server.' })
  })

  app.post('/api/workspace/reset', auth, loginRateLimit, (req, res) => {
    const actor = owner(req, res)
    if (!actor) return
    const pin = String(req.body?.pin || '')
    if (!/^\\d{6,12}$/.test(pin)) return res.status(400).json({ error: 'Enter the 6–12 digit recovery PIN' })
    if (!actor.workspaceResetPinHash) return res.status(409).json({ error: 'Set a workspace reset PIN before continuing' })
    let pinOk = false
    try { pinOk = bcrypt.compareSync(pin, actor.workspaceResetPinHash) } catch {}
    if (!pinOk) return res.status(401).json({ error: 'Incorrect recovery PIN' })
    if (req.body?.confirmation !== 'RESET MY WORKSPACE') {
      return res.status(400).json({ error: 'Type RESET MY WORKSPACE exactly to confirm' })
    }

    const ownerId = actor.id
    const linkedMembers = Object.values(users).filter((u) => u.linkedWorkspaceOwnerId === ownerId)
    const memberIds = new Set(linkedMembers.map((u) => u.id))
    const workspaceKeys = Object.keys(workspaces).filter((key) =>
      key === ownerId || key.startsWith(ownerId + '::') || memberIds.has(key)
    )
    const workspaceSnapshot = {}
    for (const key of workspaceKeys) workspaceSnapshot[key] = workspaces[key]

    const portalAccounts = read(files.portals, {})
    const ownedPortalAccounts = Object.fromEntries(Object.entries(portalAccounts || {}).filter(([, value]) =>
      value?.workspaceOwnerId === ownerId
    ))
    const invites = read(files.invites, {})
    const ownedInvites = Object.fromEntries(Object.entries(invites || {}).filter(([, value]) =>
      value?.ownerId === ownerId
    ))
    const tickets = read(files.tickets, [])
    const affectedUserIds = new Set([ownerId, ...memberIds])
    const ownedTickets = Array.isArray(tickets) ? tickets.filter((ticket) => affectedUserIds.has(ticket?.userId)) : []

    const snapshotId = crypto.randomUUID()
    const createdAt = timestamp()
    const snapshot = {
      id: snapshotId,
      createdAt,
      owner: { id: actor.id, email: actor.email, name: actor.name },
      workspaces: workspaceSnapshot,
      teamMembers: linkedMembers,
      portalAccounts: ownedPortalAccounts,
      teamInvites: ownedInvites,
      supportTickets: ownedTickets,
    }
    const snapshots = read(files.snapshots, [])
    const nextSnapshots = [...(Array.isArray(snapshots) ? snapshots : []), snapshot].slice(-3)

    const nextUsers = { ...users }
    for (const member of linkedMembers) delete nextUsers[member.email]

    const nextWorkspaces = { ...workspaces }
    for (const key of workspaceKeys) if (key !== ownerId) delete nextWorkspaces[key]
    const current = nextWorkspaces[ownerId] || { version: 0 }
    nextWorkspaces[ownerId] = {
      ...current,
      data: {
        clients: [], invoices: [], quotes: [], tickets: [], payments: [],
        products: [], services: [], expenses: [], settings: {},
      },
      version: (Number(current.version) || 0) + 1,
      updated_at: createdAt,
    }

    const nextPortalAccounts = { ...(portalAccounts || {}) }
    for (const [key, value] of Object.entries(nextPortalAccounts)) {
      if (value?.workspaceOwnerId === ownerId) delete nextPortalAccounts[key]
    }
    const nextInvites = { ...(invites || {}) }
    for (const [key, value] of Object.entries(nextInvites)) {
      if (value?.ownerId === ownerId) delete nextInvites[key]
    }
    const nextTickets = Array.isArray(tickets)
      ? tickets.filter((ticket) => !affectedUserIds.has(ticket?.userId))
      : []
    const audit = read(files.audit, [])
    const nextAudit = [...(Array.isArray(audit) ? audit : []), {
      id: snapshotId,
      at: createdAt,
      action: 'workspace.reset',
      actorId: ownerId,
      actorEmail: actor.email,
      removedTeamMembers: linkedMembers.length,
      removedWorkspaces: workspaceKeys.length - 1,
      removedPortalAccounts: Object.keys(ownedPortalAccounts).length,
      removedSupportTickets: ownedTickets.length,
      ownerLoginPreserved: true,
    }].slice(-500)

    try {
      // Snapshot and all replacement data are committed together before memory changes.
      commitFiles({
        snapshots: nextSnapshots,
        users: nextUsers,
        workspaces: nextWorkspaces,
        portals: nextPortalAccounts,
        invites: nextInvites,
        tickets: nextTickets,
        audit: nextAudit,
      })
    } catch (error) {
      console.error('[workspace-reset] file commit failed', error.message)
      return res.status(500).json({ error: 'Reset could not be committed. No in-memory workspace changes were applied.' })
    }

    for (const key of Object.keys(users)) delete users[key]
    Object.assign(users, nextUsers)
    for (const key of Object.keys(workspaces)) delete workspaces[key]
    Object.assign(workspaces, nextWorkspaces)
    push('workspace-reset')

    res.json({
      ok: true,
      snapshotId,
      resetAt: createdAt,
      ownerLoginPreserved: true,
      removed: {
        teamMembers: linkedMembers.length,
        branchWorkspaces: Math.max(0, workspaceKeys.length - 1),
        clientPortalAccounts: Object.keys(ownedPortalAccounts).length,
        supportTickets: ownedTickets.length,
      },
      message: 'Workspace reset complete. Your owner login and recovery PIN remain active.',
    })
  })

  console.log('[workspace-reset] owner-only reset routes mounted')
}

module.exports = { mountWorkspaceReset }
