/**
 * Owner-verified, PIN-protected workspace reset.
 *
 * Resets only the authenticated owner's tenant. It deliberately preserves the
 * owner login and all unrelated tenants. A private server-side snapshot is
 * written before any mutation so the operation is auditable and recoverable.
 */
const bcrypt = require('bcryptjs')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

function mountWorkspaceReset(app, ctx) {
  const {
    users, workspaces, auth, persistUsers, persistWorkspaces,
    DATA_DIR, loadJson, saveJson, git, now,
    loginRateLimit = (_req, _res, next) => next(),
  } = ctx

  const SNAPSHOTS_FILE = path.join(DATA_DIR, 'workspace_reset_snapshots.json')
  const AUDIT_FILE = path.join(DATA_DIR, 'workspace_reset_audit.json')
  const PORTAL_ACCOUNTS_FILE = path.join(DATA_DIR, 'client_portal_accounts.json')
  const TEAM_INVITES_FILE = path.join(DATA_DIR, 'team_invites.json')

  const timestamp = () => typeof now === 'function' ? now() : new Date().toISOString()
  const read = (file, fallback) => typeof loadJson === 'function' ? loadJson(file, fallback) : fallback
  const write = (file, value) => {
    if (typeof saveJson === 'function') saveJson(file, value)
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
      fs.renameSync(tmp, file)
    }
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

  app.post('/api/workspace/reset-pin', auth, loginRateLimit, (req, res) => {
    const actor = owner(req, res)
    if (!actor) return
    const pin = String(req.body?.pin || '')
    const confirmPin = String(req.body?.confirmPin || '')
    if (!/^\\d{6,12}$/.test(pin)) return res.status(400).json({ error: 'Recovery PIN must be 6–12 digits' })
    if (pin !== confirmPin) return res.status(400).json({ error: 'PIN entries do not match' })
    actor.workspaceResetPinHash = bcrypt.hashSync(pin, 12)
    actor.workspaceResetPinUpdatedAt = timestamp()
    persistUsers()
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

    const portalAccounts = read(PORTAL_ACCOUNTS_FILE, {})
    const ownedPortalAccounts = Object.fromEntries(Object.entries(portalAccounts || {}).filter(([, value]) =>
      value?.workspaceOwnerId === ownerId
    ))
    const invites = read(TEAM_INVITES_FILE, {})
    const ownedInvites = Object.fromEntries(Object.entries(invites || {}).filter(([, value]) =>
      value?.ownerId === ownerId
    ))
    const ticketsFile = path.join(DATA_DIR, 'support-tickets.json')
    const tickets = read(ticketsFile, [])
    const affectedUserIds = new Set([ownerId, ...memberIds])
    const ownedTickets = Array.isArray(tickets) ? tickets.filter((ticket) => affectedUserIds.has(ticket?.userId)) : []

    const snapshotId = crypto.randomUUID()
    const createdAt = timestamp()
    const snapshots = read(SNAPSHOTS_FILE, [])
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
    write(SNAPSHOTS_FILE, [...(Array.isArray(snapshots) ? snapshots : []), snapshot].slice(-3))

    // All validation and the recovery snapshot complete before the first mutation.
    for (const member of linkedMembers) {
      delete users[member.email]
      delete workspaces[member.id]
    }
    for (const key of workspaceKeys) {
      if (key !== ownerId) delete workspaces[key]
    }
    const current = workspaces[ownerId] || { version: 0 }
    workspaces[ownerId] = {
      ...current,
      data: {
        clients: [], invoices: [], quotes: [], tickets: [], payments: [],
        products: [], services: [], expenses: [], settings: {},
      },
      version: (Number(current.version) || 0) + 1,
      updated_at: createdAt,
    }

    for (const [key, value] of Object.entries(portalAccounts || {})) {
      if (value?.workspaceOwnerId === ownerId) delete portalAccounts[key]
    }
    for (const [key, value] of Object.entries(invites || {})) {
      if (value?.ownerId === ownerId) delete invites[key]
    }
    const remainingTickets = Array.isArray(tickets)
      ? tickets.filter((ticket) => !affectedUserIds.has(ticket?.userId))
      : []
    write(PORTAL_ACCOUNTS_FILE, portalAccounts)
    write(TEAM_INVITES_FILE, invites)
    write(ticketsFile, remainingTickets)
    persistUsers()
    persistWorkspaces()

    const audit = read(AUDIT_FILE, [])
    write(AUDIT_FILE, [...(Array.isArray(audit) ? audit : []), {
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
    }].slice(-500))
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
