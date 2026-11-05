const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveWorkspaceKey, filterTeamWorkspaceData, mergeTeamWorkspaceData } = require('../workspace-owner')

test('authenticated owners resolve only to their own workspace identity', () => {
  const workspaces = {
    'owner-a': { data: { clients: [{ id: 'a-private' }] } },
    'owner-b': { data: { clients: [{ id: 'b-private' }] } },
  }
  assert.equal(resolveWorkspaceKey({ user: { id: 'owner-a', email: 'a@example.com' }, tokenUser: { id: 'owner-a', email: 'a@example.com' }, workspaces }), 'owner-a')
  assert.equal(resolveWorkspaceKey({ user: { id: 'owner-b', email: 'b@example.com' }, tokenUser: { id: 'owner-b', email: 'b@example.com' }, workspaces }), 'owner-b')
})

test('front desk reads only permitted workspace collections and never owner settings', () => {
  const result = filterTeamWorkspaceData({ clients: [{ id: 'c1' }], invoices: [{ id: 'i1' }], expenses: [{ id: 'e1' }], settings: { privateApiKey: 'secret' }, bankTransactions: [{ id: 'bank1' }] }, 'front_desk')
  assert.deepEqual(Object.keys(result).sort(), ['clients', 'invoices'])
  assert.equal(result.settings, undefined)
  assert.equal(result.expenses, undefined)
})

test('front desk writes cannot overwrite protected collections or owner settings', () => {
  const current = { clients: [{ id: 'old-client' }], invoices: [{ id: 'old-invoice' }], expenses: [{ id: 'protected-expense' }], settings: { privateApiKey: 'secret' } }
  const result = mergeTeamWorkspaceData(current, { clients: [{ id: 'new-client' }], invoices: [{ id: 'new-invoice' }], expenses: [], settings: {}, ownerOnlyFlag: true }, 'front_desk')
  assert.deepEqual(result.clients, [{ id: 'new-client' }])
  assert.deepEqual(result.invoices, [{ id: 'new-invoice' }])
  assert.deepEqual(result.expenses, [{ id: 'protected-expense' }])
  assert.deepEqual(result.settings, { privateApiKey: 'secret' })
  assert.equal(result.ownerOnlyFlag, undefined)
})

test('viewer can read permitted data but has no writable collections', () => {
  const current = { clients: [{ id: 'c1' }], invoices: [{ id: 'i1' }], settings: { owner: true } }
  const filtered = filterTeamWorkspaceData(current, 'viewer')
  assert.deepEqual(filtered.clients, [{ id: 'c1' }])
  const merged = mergeTeamWorkspaceData(current, { clients: [], invoices: [] }, 'viewer')
  assert.deepEqual(merged, current)
})

test('unknown team role fails closed', () => {
  const current = { clients: [{ id: 'c1' }], settings: { owner: true } }
  assert.deepEqual(filterTeamWorkspaceData(current, 'unexpected'), {})
  assert.deepEqual(mergeTeamWorkspaceData(current, { clients: [] }, 'unexpected'), current)
})


test('account switching cannot redirect a populated account to another email-keyed tenant', () => {
  const workspaces = {
    'owner-a': { data: { clients: [{ id: 'a-client' }] } },
    'b@example.com': { data: { clients: [{ id: 'b-client' }] } },
  }
  const resolved = resolveWorkspaceKey({
    user: { id: 'owner-a', email: 'a@example.com' },
    tokenUser: { id: 'owner-a', email: 'b@example.com' },
    workspaces,
  })
  assert.equal(resolved, 'owner-a')
  assert.deepEqual(workspaces[resolved].data.clients, [{ id: 'a-client' }])
})
