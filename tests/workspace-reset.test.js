const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { mountWorkspaceReset } = require('../workspace-reset')
const bcrypt = require('bcryptjs')

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saip-workspace-reset-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const users = {
    'owner@example.com': { id: 'owner-1', email: 'owner@example.com', role: 'user', password_hash: bcrypt.hashSync('owner-password', 4) },
    'member@example.com': { id: 'member-1', email: 'member@example.com', linkedWorkspaceOwnerId: 'owner-1', teamRole: 'front_desk' },
    'other@example.com': { id: 'owner-2', email: 'other@example.com', role: 'user' },
  }
  const workspaces = {
    'owner-1': { version: 4, data: { clients: [{ id: 'c1' }], invoices: [{ id: 'i1' }], settings: { company: 'Owner' } } },
    'owner-1::branch-a': { version: 2, data: { tickets: [{ id: 't1' }] } },
    'member-1': { version: 1, data: { clients: [] } },
    'owner-2': { version: 3, data: { invoices: [{ id: 'private-other' }] } },
  }
  const seed = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value))
  seed('users.json', users)
  seed('workspaces.json', workspaces)
  seed('client_portal_accounts.json', {
    'owner-1::client@example.com': { workspaceOwnerId: 'owner-1', email: 'client@example.com' },
    'owner-2::client@example.com': { workspaceOwnerId: 'owner-2', email: 'client@example.com' },
  })
  seed('portals.json', {
    ownLink: { userId: 'owner-1', clientId: 'c1' },
    otherLink: { userId: 'owner-2', clientId: 'c2' },
  })
  seed('portal_decisions.json', [
    { id: 'own-decision', userId: 'owner-1' },
    { id: 'other-decision', userId: 'owner-2' },
  ])
  seed('team_invites.json', {
    own: { ownerId: 'owner-1' },
    other: { ownerId: 'owner-2' },
  })
  seed('support-tickets.json', [
    { id: 'own-ticket', userId: 'owner-1' },
    { id: 'member-ticket', userId: 'member-1' },
    { id: 'other-ticket', userId: 'owner-2' },
  ])
  const routes = new Map()
  const app = { post(route, ...handlers) { routes.set('POST ' + route, handlers) } }
  const pushes = []
  mountWorkspaceReset(app, {
    users, workspaces, DATA_DIR: dir,
    auth: (_req, _res, next) => next(),
    now: () => '2026-10-30T12:00:00.000Z',
    git: { schedulePush: (reason) => pushes.push(reason) },
  })
  async function call(route, body = {}, actorId = 'owner-1') {
    const handlers = routes.get('POST ' + route)
    assert.ok(handlers, 'route registered: ' + route)
    const req = { user: { id: actorId }, body }
    let statusCode = 200
    let payload
    const res = {
      status(code) { statusCode = code; return this },
      json(value) { payload = value; return this },
    }
    for (const handler of handlers) {
      let nextCalled = false
      await handler(req, res, () => { nextCalled = true })
      if (!nextCalled) break
    }
    return { statusCode, payload }
  }
  return { call, users, workspaces, dir, pushes }
}

test('linked team member cannot set or execute a workspace reset', async (t) => {
  const h = harness(t)
  const result = await h.call('/api/workspace/reset-pin', { pin: '123456', confirmPin: '123456', currentPassword: 'owner-password' }, 'member-1')
  assert.equal(result.statusCode, 403)
  assert.equal(h.users['owner@example.com'].workspaceResetPinHash, undefined)
})

test('reset PIN requires owner password reauthentication', async (t) => {
  const h = harness(t)
  const denied = await h.call('/api/workspace/reset-pin', { pin: '123456', confirmPin: '123456', currentPassword: 'wrong-password' })
  assert.equal(denied.statusCode, 401)
  assert.equal(h.users['owner@example.com'].workspaceResetPinHash, undefined)
})

test('reset PIN requires 6–12 digits and confirmation', async (t) => {
  const h = harness(t)
  assert.equal((await h.call('/api/workspace/reset-pin', { pin: '1234', confirmPin: '1234', currentPassword: 'owner-password' })).statusCode, 400)
  assert.equal((await h.call('/api/workspace/reset-pin', { pin: '123456', confirmPin: '654321', currentPassword: 'owner-password' })).statusCode, 400)
  const saved = await h.call('/api/workspace/reset-pin', { pin: '123456', confirmPin: '123456' })
  assert.equal(saved.statusCode, 200)
  assert.equal(saved.payload.ok, true)
  assert.ok(h.users['owner@example.com'].workspaceResetPinHash)
  const diskUsers = JSON.parse(fs.readFileSync(path.join(h.dir, 'users.json'), 'utf8'))
  assert.ok(diskUsers['owner@example.com'].workspaceResetPinHash)
})

test('reset requires correct PIN and exact confirmation; then clears only this tenant', async (t) => {
  const h = harness(t)
  await h.call('/api/workspace/reset-pin', { pin: '246810', confirmPin: '246810', currentPassword: 'owner-password' })
  const wrong = await h.call('/api/workspace/reset', { pin: '111111', confirmation: 'RESET MY WORKSPACE' })
  assert.equal(wrong.statusCode, 401)
  assert.equal(h.workspaces['owner-1'].data.invoices.length, 1)

  const phrase = await h.call('/api/workspace/reset', { pin: '246810', confirmation: 'RESET' })
  assert.equal(phrase.statusCode, 400)
  assert.equal(h.workspaces['owner-1'].data.invoices.length, 1)

  const done = await h.call('/api/workspace/reset', { pin: '246810', confirmation: 'RESET MY WORKSPACE' })
  assert.equal(done.statusCode, 200)
  assert.equal(done.payload.ownerLoginPreserved, true)
  assert.equal(done.payload.removed.teamMembers, 1)
  assert.equal(done.payload.removed.clientPortalAccounts, 1)
  assert.deepEqual(h.workspaces['owner-1'].data.clients, [])
  assert.deepEqual(h.workspaces['owner-1'].data.invoices, [])
  assert.equal(h.workspaces['owner-1'].version, 5)
  assert.equal(h.users['owner@example.com'].id, 'owner-1')
  assert.equal(h.users['member@example.com'], undefined)
  assert.ok(h.workspaces['owner-2'].data.invoices[0].id === 'private-other')
  assert.equal(h.workspaces['owner-1::branch-a'], undefined)
  const portals = JSON.parse(fs.readFileSync(path.join(h.dir, 'client_portal_accounts.json'), 'utf8'))
  assert.equal(Object.keys(portals).length, 1)
  assert.equal(portals['owner-2::client@example.com'].workspaceOwnerId, 'owner-2')
  const quotePortals = JSON.parse(fs.readFileSync(path.join(h.dir, 'portals.json'), 'utf8'))
  assert.equal(Object.keys(quotePortals).length, 1)
  assert.ok(quotePortals.otherLink)
  const decisions = JSON.parse(fs.readFileSync(path.join(h.dir, 'portal_decisions.json'), 'utf8'))
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].userId, 'owner-2')
  const snapshots = JSON.parse(fs.readFileSync(path.join(h.dir, 'workspace_reset_snapshots.json'), 'utf8'))
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].workspaces['owner-1'].data.invoices[0].id, 'i1')
  const audit = JSON.parse(fs.readFileSync(path.join(h.dir, 'workspace_reset_audit.json'), 'utf8'))
  assert.equal(audit[0].action, 'workspace.reset')
  assert.ok(h.pushes.includes('workspace-reset'))
})
