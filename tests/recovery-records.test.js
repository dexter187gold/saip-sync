const test = require('node:test')
const assert = require('node:assert/strict')
const { consumeRecoveryRecords } = require('../recovery-records')

test('consuming a recovery token also invalidates its paired code record', () => {
  const records = {
    tokenA: { email: 'a@example.com', used: false },
    'code:a@example.com:hashA': { email: 'a@example.com', token: 'tokenA', used: false },
    tokenB: { email: 'a@example.com', used: false },
    'code:a@example.com:hashB': { email: 'a@example.com', token: 'tokenB', used: false },
    tokenOther: { email: 'b@example.com', used: false },
  }
  consumeRecoveryRecords(records, records.tokenA)
  assert.equal(records.tokenA.used, true)
  assert.equal(records['code:a@example.com:hashA'].used, true)
  assert.equal(records.tokenB.used, false)
  assert.equal(records['code:a@example.com:hashB'].used, false)
  assert.equal(records.tokenOther.used, false)
})

test('consuming a recovery code invalidates the paired token and code', () => {
  const records = {
    tokenA: { email: 'a@example.com', used: false },
    'code:a@example.com:hashA': { email: 'a@example.com', token: 'tokenA', used: false },
  }
  consumeRecoveryRecords(records, records['code:a@example.com:hashA'])
  assert.equal(records.tokenA.used, true)
  assert.equal(records['code:a@example.com:hashA'].used, true)
})
