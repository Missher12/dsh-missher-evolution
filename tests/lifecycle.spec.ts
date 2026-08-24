import { describe, expect, test } from 'vitest'
import {
  capture,
  maintain,
  selectRules,
  sha256,
  workflowFamily,
} from '../src/lifecycle.js'
import { createEmptyState } from '../src/store.js'
import type { CaptureEvent, EvolutionRule, EvolutionState } from '../src/types.js'

const DAY = 24 * 60 * 60 * 1_000

function event(overrides: Partial<CaptureEvent> = {}): CaptureEvent {
  return {
    schemaVersion: 1,
    taskHash: sha256(`task-${overrides.sessionHash ?? 'a'}`),
    sessionHash: sha256('session-a'),
    occurredAt: 1_000,
    taskType: 'coding',
    outcome: 'success',
    correction: false,
    complexity: 'medium',
    workflowSteps: ['file_ops', 'shell'],
    workflowSignature: sha256('file_ops,shell'),
    errorKind: 'none',
    injectedRuleIds: [],
    preference: null,
    ...overrides,
  }
}

function emptyState(now = 0): EvolutionState {
  return createEmptyState(now)
}

function activeRule(overrides: Partial<EvolutionRule> = {}): EvolutionRule {
  const now = 1_000
  return {
    id: 'rule_active',
    status: 'active',
    category: 'workflow',
    taskType: 'coding',
    workflowFamily: workflowFamily('coding', ['file_ops', 'shell']),
    workflowSteps: ['file_ops', 'shell'],
    observedWorkflowSignatures: [sha256('file_ops,shell')],
    preferenceId: null,
    instruction: '处理代码任务时先检查目标实现，再执行最小修改；完成后运行测试并核对真实结果。',
    instructionHash: sha256('active instruction'),
    confidence: 0.9,
    createdAt: now,
    lastEvidenceAt: now,
    lastSuccessAt: now,
    expiresAt: now + 90 * DAY,
    sessionHashes: [sha256('s1')],
    version: 1,
    opportunities: 3,
    successes: 3,
    failures: 0,
    corrections: 0,
    ...overrides,
  }
}

describe('deterministic lifecycle', () => {
  test('promotes only after three independent session hashes', () => {
    let state = emptyState(0)
    state = capture(state, event({ sessionHash: sha256('a'), taskHash: sha256('ta') })).state
    state = capture(state, event({ sessionHash: sha256('b'), taskHash: sha256('tb') })).state
    expect(state.rules[0]?.status).toBe('candidate')
    state = capture(state, event({ sessionHash: sha256('c'), taskHash: sha256('tc') })).state
    expect(state.rules[0]?.status).toBe('trial')
  })

  test('promotes a trial only after three attributed successful injections', () => {
    let state = emptyState(0)
    for (const id of ['a', 'b', 'c']) {
      state = capture(state, event({ sessionHash: sha256(id), taskHash: sha256(`t-${id}`) })).state
    }
    const ruleId = state.rules[0]?.id
    expect(ruleId).toBeDefined()
    for (const id of ['d', 'e', 'f']) {
      state = capture(state, event({
        sessionHash: sha256(id),
        taskHash: sha256(`t-${id}`),
        injectedRuleIds: [ruleId as string],
      })).state
    }
    expect(state.rules.find(rule => rule.id === ruleId)).toMatchObject({
      status: 'active',
      opportunities: 3,
      successes: 3,
      failures: 0,
    })
  })

  test('suspends an attributed active rule on explicit correction', () => {
    const rule = activeRule()
    const state = { ...emptyState(0), rules: [rule] }
    const result = capture(state, event({
      correction: true,
      outcome: 'corrected',
      injectedRuleIds: [rule.id],
      occurredAt: 2_000,
    }))
    expect(result.state.rules.find(item => item.id === rule.id)).toMatchObject({
      status: 'suspended',
      corrections: 1,
    })
  })

  test('retires expired and low-value rules during maintenance', () => {
    const expired = activeRule({ expiresAt: DAY, lastEvidenceAt: DAY })
    const noTool = activeRule({
      id: 'rule_no_tool',
      taskType: 'general',
      workflowSteps: [],
      workflowFamily: workflowFamily('general', []),
      observedWorkflowSignatures: [sha256('no-tool')],
    })
    const result = maintain({ ...emptyState(0), rules: [expired, noTool] }, 100 * DAY)
    expect(result.state.rules.every(rule => rule.status === 'retired')).toBe(true)
    expect(result.transitions).toHaveLength(2)
  })

  test('does not create a rule for low-value general no-tool success', () => {
    const result = capture(emptyState(0), event({
      taskType: 'general',
      workflowSteps: [],
      workflowSignature: sha256('none'),
    }))
    expect(result.state.rules).toEqual([])
    expect(result.state.counters.captures).toBe(1)
  })

  test('maps predefined preferences without retaining source text', () => {
    const result = capture(emptyState(0), event({
      preference: 'respond_simplified_chinese',
      correction: true,
      outcome: 'corrected',
    }))
    expect(result.state.rules).toHaveLength(1)
    expect(result.state.rules[0]).toMatchObject({ category: 'preference' })
    expect(JSON.stringify(result.state)).not.toContain('以后都用中文')
  })

  test('normalizes equivalent alternating workflows to one family', () => {
    expect(workflowFamily('coding', ['shell', 'file_ops', 'shell']))
      .toBe(workflowFamily('coding', ['file_ops', 'shell', 'file_ops']))
    expect(workflowFamily('coding', [])).not.toBe(workflowFamily('coding', ['other']))
  })

  test('selects exact rules first and bounds count and context', () => {
    const exact = activeRule({ id: 'rule_exact' })
    const global = activeRule({
      id: 'rule_global',
      category: 'general',
      taskType: 'general',
      workflowFamily: workflowFamily('general', ['shell']),
      workflowSteps: ['shell'],
      observedWorkflowSignatures: [sha256('global')],
      instruction: '处理通用任务时先检查目标和约束，再执行限定步骤；完成后核对结果与请求是否一致。',
    })
    const preference = activeRule({
      id: 'rule_preference',
      category: 'preference',
      preferenceId: 'respond_simplified_chinese',
      instruction: '使用简体中文回答；发送前检查正文语言并确认没有无必要的英文段落。',
    })
    const result = selectRules(
      { ...emptyState(0), rules: [global, preference, exact] },
      { taskType: 'coding', now: 2_000, maxRules: 2, maxCodePoints: 2_000 },
    )
    expect(result.rules.map(rule => rule.id)).toEqual(['rule_preference', 'rule_exact'])
    expect(result.rules).toHaveLength(2)
    expect(result.instruction).toContain('<missher-evolution-rules>')
    expect([...result.instruction].length).toBeLessThanOrEqual(2_000)
  })
})
