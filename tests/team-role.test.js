const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { mountTeam } = require('../team')

function harness({ actorId = 'owner-1' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saip-team-role-'))
  const users = {
    'owner@example.com': { id: 'owner-1', email: 'owner@example.com', role: 'user' },
    'desk@example.com': { id: 'member-1', email: 'desk@example.com', linkedWorkspaceOwnerId: 'owner-1', teamRole: 'front_desk' },
    'other-owner@example.com': { id: 'owner-2', email: 'other-owner@example.com', role: 'user' },
    'other-member@example.com': { id: 'member-2', email: 'other-member@example.com', linkedWorkspaceOwnerId: 'owner-2', teamRole: 'tech' },
  }
  const routes = {}
  const app = {
    get: (route, ...handlers) => { routes['GET ' + route] = handlers },
    post: (route, ...handlers) => { routes['POST ' + route] = handlers },
  }
  mountTeam(app, {
    users,
    workspaces: {},
    persistUsers: () => {},
    persistWorkspaces: () => {},
    auth: (_req, _res, next) => next(),
    now: () => '2026-10-29T12:00:00.000Z',
    DATA_DIR: dir,
  })
  return {
    users, routes, dir,
    async call(route, body = {}) {
      const handlers = routes['POST ' + route]
      assert.ok(handlers, 'route registered: ' + route)
      const handler = handlers[handlers.length - 1]
      let statusCode = 200
      let payload
      const res = {
        status(code) { statusCode = code; return this },
        json(value) { payload = value; return this },
      }
      handler({ user: { id: actorId }, body }, res)
      return { statusCode, payload }
    },
  }
}

test('workspace owner can change a linked member role and audit the change', async (t) => {
  const h = harness()
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }))
  const result = await h.call('/api/team/member-role', { userId: 'member-1', role: 'manager' })
  assert.equal(result.statusCode, 200)
  assert.equal(h.users['desk@example.com'].teamRole, 'manager')
  assert.equal(result.payload.previousRole, 'front_desk')
  const audit = JSON.parse(fs.readFileSync(path.join(h.dir, 'team_audit.json'), 'utf8'))
  assert.equal(audit[0].action, 'team.member_role_changed')
  assert.equal(audit[0].newRole, 'manager')
})

test('team member cannot change roles', async (t) => {
  const h = harness({ actorId: 'member-1' })
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }))
  const result = await h.call('/api/team/member-role', { userId: 'member-1', role: 'admin' })
  assert.equal(result.statusCode, 403)
})

test('owner cannot grant owner role through member-role endpoint', async (t) => {
  const h = harness()
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }))
  const result = await h.call('/api/team/member-role', { userId: 'member-1', role: 'owner' })
  assert.equal(result.statusCode, 400)
  assert.equal(h.users['desk@example.com'].teamRole, 'front_desk')
})

test('owner cannot alter a member of another workspace', async (t) => {
  const h = harness()
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }))
  const result = await h.call('/api/team/member-role', { userId: 'member-2', role: 'admin' })
  assert.equal(result.statusCode, 404)
})
