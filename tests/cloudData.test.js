import assert from 'node:assert/strict'
import test from 'node:test'
import { dataForAccount, mergeCloudRecords } from '../src/cloudData.js'

test('cloud records win duplicate IDs while local-only records are retained', () => {
  const result = mergeCloudRecords(
    [{ id: 'shared', title: 'Local version' }, { id: 'local-only', title: 'Local task' }],
    [{ id: 'shared', deleted: false, payload: { id: 'shared', title: 'Cloud version' } }],
  )

  assert.deepEqual(result, [
    { id: 'shared', title: 'Cloud version' },
    { id: 'local-only', title: 'Local task' },
  ])
})

test('cloud tombstones prevent deleted local records from returning', () => {
  const result = mergeCloudRecords(
    [{ id: 'removed', title: 'Old local task' }, { id: 'kept', title: 'Local task' }],
    [{ id: 'removed', deleted: true }],
  )

  assert.deepEqual(result, [{ id: 'kept', title: 'Local task' }])
})

test('account switches use that account cache instead of another account local data', () => {
  const localData = { tasks: [{ id: 'account-a' }], notes: [], xp: 0, history: [], logbook: [] }
  const accountBData = { tasks: [{ id: 'account-b' }], notes: [], xp: 3, history: [], logbook: [] }

  assert.equal(dataForAccount('user-a', 'user-b', localData, accountBData), accountBData)
  assert.deepEqual(dataForAccount('user-a', 'user-c', localData, null), {
    tasks: [],
    notes: [],
    xp: 0,
    history: [],
    logbook: [],
  })
  assert.equal(dataForAccount(null, 'user-a', localData, accountBData), localData)
})
