const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveWorkspaceKey } = require('../workspace-owner')

test('prefers the authenticated user ID when its workspace exists', () => {
  assert.equal(resolveWorkspaceKey({
    user: { id: 'u-1', email: 'a@example.com' },
    tokenUser: { id: 'u-1', email: 'a@example.com' },
    workspaces: { 'u-1': { data: {} }, 'a@example.com': { data: { legacy: true } } },
  }), 'u-1')
})

test('preserves an explicit team workspace owner link', () => {
  assert.equal(resolveWorkspaceKey({
    user: { id: 'member-2', email: 'member@example.com', linkedWorkspaceOwnerId: 'owner-1' },
    tokenUser: { id: 'member-2', email: 'member@example.com' },
    workspaces: { 'owner-1': { data: {} } },
  }), 'owner-1')
})

test('finds legacy email-keyed profiles for the authenticated email', () => {
  assert.equal(resolveWorkspaceKey({
    user: { id: 'u-3', email: 'owner@example.com' },
    tokenUser: { id: 'u-3', email: 'owner@example.com' },
    workspaces: { 'owner@example.com': { data: { clients: [{ id: 1 }] } } },
  }), 'owner@example.com')
})

test('matches legacy email keys case-insensitively without changing the stored key', () => {
  assert.equal(resolveWorkspaceKey({
    user: { id: 'u-4', email: 'owner@example.com' },
    tokenUser: { id: 'u-4', email: 'owner@example.com' },
    workspaces: { 'Owner@Example.com': { data: {} } },
  }), 'Owner@Example.com')
})

test('returns the user ID when no workspace exists yet', () => {
  assert.equal(resolveWorkspaceKey({
    user: { id: 'new-user', email: 'new@example.com' },
    tokenUser: { id: 'new-user', email: 'new@example.com' },
    workspaces: {},
  }), 'new-user')
})
