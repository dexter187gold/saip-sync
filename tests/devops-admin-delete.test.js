const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const jwt = require('jsonwebtoken')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { mountDevops } = require('../devops')

function setup(t) {
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'saip-dev-admin-delete-'))
  t.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }))
  const users = {
    'admin@example.test': { id: 'admin-1', email: 'admin@example.test', name: 'Admin', role: 'admin' },
    'user@example.test': { id: 'user-1', email: 'user@example.test', name: 'User', role: 'user' },
    'sainvoicepro@gmail.com': { id: 'owner-1', email: 'sainvoicepro@gmail.com', name: 'Developer', role: 'admin' },
  }
  const workspaces = {
    'admin-1': { data: { invoices: [{ id: 'invoice-1' }] } },
    'admin-1::branch-1': { data: { invoices: [] } },
    'user-1': { data: { invoices: [] } },
  }
  const passwordResets = {
    reset1: { email: 'admin@example.test', expires: '2099-01-01T00:00:00Z' },
    reset2: { email: 'user@example.test', expires: '2099-01-01T00:00:00Z' },
  }
  const counts = { users: 0, workspaces: 0, resets: 0 }
  const app = express()
  app.use(express.json())
  mountDevops(app, {
    DATA_DIR,
    JWT_SECRET: 'test-jwt-secret-with-more-than-32-characters',
    users,
    workspaces,
    passwordResets,
    persistUsers: () => { counts.users++ },
    persistWorkspaces: () => { counts.workspaces++ },
    persistResets: () => { counts.resets++ },
    safeEmail: value => String(value || '').trim().toLowerCase(),
    strongPassword: value => ({ ok: String(value || '').length >= 12 }),
    now: () => '2026-11-18T00:00:00.000Z',
    git: { schedulePush: () => {} },
  })
  const token = jwt.sign(
    { email: 'sainvoicepro@gmail.com', developer_portal: true, role: 'developer' },
    'test-jwt-secret-with-more-than-32-characters',
    { expiresIn: '5m', issuer: 'saip-sync', audience: 'saip-developer-portal' },
  )
  return { app, users, workspaces, passwordResets, counts, DATA_DIR, token }
}

test('developer can permanently delete an administrator account and its workspaces', async t => {
  const state = setup(t)
  const response = await require('supertest')(state.app)
    .delete('/api/dev/users/admin-1')
    .set('Authorization', 'Bearer ' + state.token)
    .send({ confirmation: 'DELETE admin@example.test' })

  assert.equal(response.status, 200)
  assert.match(response.body.message, /Administrator account/)
  assert.equal(state.users['admin@example.test'], undefined)
  assert.equal(state.workspaces['admin-1'], undefined)
  assert.equal(state.workspaces['admin-1::branch-1'], undefined)
  assert.ok(state.users['user@example.test'])
  assert.ok(state.workspaces['user-1'])
  assert.equal(state.passwordResets.reset1, undefined)
  assert.ok(state.passwordResets.reset2)
  const tombstones = JSON.parse(fs.readFileSync(path.join(state.DATA_DIR, 'deleted-admin-accounts.json'), 'utf8'))
  assert.deepEqual(tombstones, ['admin@example.test'])
  assert.ok(state.counts.users > 0 && state.counts.workspaces > 0 && state.counts.resets > 0)
})

test('developer deletion requires exact confirmation and protects primary developer identity', async t => {
  const state = setup(t)
  const request = require('supertest')
  const missingConfirmation = await request(state.app)
    .delete('/api/dev/users/admin-1')
    .set('Authorization', 'Bearer ' + state.token)
    .send({ confirmation: 'DELETE wrong@example.test' })
  assert.equal(missingConfirmation.status, 400)
  assert.ok(state.users['admin@example.test'])

  const ownerDelete = await request(state.app)
    .delete('/api/dev/users/owner-1')
    .set('Authorization', 'Bearer ' + state.token)
    .send({ confirmation: 'DELETE sainvoicepro@gmail.com' })
  assert.equal(ownerDelete.status, 403)
  assert.ok(state.users['sainvoicepro@gmail.com'])
})

test('developer can still delete a standard user account', async t => {
  const state = setup(t)
  const response = await require('supertest')(state.app)
    .delete('/api/dev/users/user-1')
    .set('Authorization', 'Bearer ' + state.token)
    .send({ confirmation: 'DELETE user@example.test' })
  assert.equal(response.status, 200)
  assert.equal(state.users['user@example.test'], undefined)
  assert.equal(state.workspaces['user-1'], undefined)
  assert.equal(fs.existsSync(path.join(state.DATA_DIR, 'deleted-admin-accounts.json')), false)
})
