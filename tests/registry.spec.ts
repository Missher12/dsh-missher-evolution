import { describe, expect, test } from 'vitest'
import { TurnRegistry, type OpenTurnInput } from '../src/registry.js'

function baseTurn(overrides: Partial<OpenTurnInput> = {}): OpenTurnInput {
  return {
    taskHash: 'a'.repeat(64),
    taskType: 'coding',
    correction: false,
    preference: null,
    ...overrides,
  }
}

describe('TurnRegistry', () => {
  test('claims one capture and bounds workflow steps', () => {
    const registry = new TurnRegistry({ maxEntries: 2, ttlMs: 60_000, now: () => 10 })
    registry.open('session-a', 1, baseTurn())
    for (let i = 0; i < 20; i += 1) {
      registry.observeTool('session-a', 1, i % 2 ? 'shell' : 'file_ops', 'none')
    }
    expect(registry.claimCapture('session-a', 1)?.workflowSteps).toHaveLength(12)
    expect(registry.claimCapture('session-a', 1)).toBeUndefined()
  })

  test('deduplicates adjacent steps and retains the last classified error', () => {
    const registry = new TurnRegistry()
    registry.open('session-a', 'turn-a', baseTurn())
    registry.observeTool('session-a', 'turn-a', 'shell', 'none')
    registry.observeTool('session-a', 'turn-a', 'shell', 'none')
    registry.observeTool('session-a', 'turn-a', 'file_ops', 'tool_error')
    expect(registry.claimCapture('session-a', 'turn-a')).toMatchObject({
      workflowSteps: ['shell', 'file_ops'],
      errorKind: 'tool_error',
    })
  })

  test('filters subagents and expires untouched entries', () => {
    let now = 1
    const registry = new TurnRegistry({ maxEntries: 2, ttlMs: 10, now: () => now })
    registry.markSubagent('child')
    registry.open('child', 1, baseTurn())
    expect(registry.isSubagent('child')).toBe(true)
    expect(registry.markFiltered('child', 1)).toBe(true)
    expect(registry.claimCapture('child', 1)).toBeUndefined()
    now = 20
    expect(registry.cleanup()).toBe(2)
    expect(registry.isSubagent('child')).toBe(false)
    expect(registry.size).toBe(0)
  })

  test('does not evict live open turns when capacity is exhausted', () => {
    let now = 1
    const registry = new TurnRegistry({ maxEntries: 2, ttlMs: 100, now: () => now })
    expect(registry.open('a', 1, baseTurn())).toBeDefined()
    now += 1
    expect(registry.open('b', 1, baseTurn())).toBeDefined()
    now += 1
    expect(registry.open('c', 1, baseTurn())).toBeUndefined()
    expect(registry.size).toBe(2)
  })

  test('evicts a closed turn before admitting a new one', () => {
    let now = 1
    const registry = new TurnRegistry({ maxEntries: 2, ttlMs: 100, now: () => now })
    registry.open('a', 1, baseTurn())
    registry.claimCapture('a', 1)
    now += 1
    registry.open('b', 1, baseTurn())
    now += 1
    expect(registry.open('c', 1, baseTurn())).toBeDefined()
    expect(registry.claimCapture('a', 1)).toBeUndefined()
  })

  test('copies returned arrays and discards complete sessions', () => {
    const registry = new TurnRegistry()
    registry.open('a', 1, baseTurn())
    registry.open('a', 2, baseTurn())
    registry.setInjectedRules('a', 1, ['rule_one'])
    const capture = registry.claimCapture('a', 1)
    capture?.injectedRuleIds.push('rule_mutation')
    expect(registry.discardSession('a')).toBe(2)
    expect(registry.size).toBe(0)
  })
})
