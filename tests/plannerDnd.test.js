import assert from 'node:assert/strict'
import test from 'node:test'
import { prioritizePlannerCollisions } from '../src/plannerDnd.js'

function collision(id) {
  return { id }
}

function container(id, kind) {
  return { id, data: { current: { kind } } }
}

test('Quest Deck wins collisions with calendar targets beneath it', () => {
  const pool = collision('task-pool')
  const day = collision('day')
  const targetItem = collision('item')
  const results = prioritizePlannerCollisions(
    [day, targetItem, pool],
    [
      container('task-pool', 'pool'),
      container('day', 'day'),
      container('item', 'item'),
    ],
  )

  assert.equal(results[0], pool)
})

test('item targets remain preferred over their regular task container', () => {
  const regularTask = collision('regular-task')
  const targetItem = collision('item')
  const results = prioritizePlannerCollisions(
    [regularTask, targetItem],
    [
      container('regular-task', 'regular-task'),
      container('item', 'item'),
    ],
  )

  assert.equal(results[0], targetItem)
})
