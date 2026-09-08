import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { classifyError, classifyPrompt, classifyTool, containsSensitive } from '../src/classifier.js'
import { capture, selectRules, sha256, workflowFamily, workflowProjection } from '../src/lifecycle.js'
import { createEmptyState } from '../src/store.js'
import type { CaptureEvent, EvolutionRule, EvolutionState } from '../src/types.js'

interface Fixture {
  schemaVersion: 1
  documentedDifferences: Array<{ id: string, python: string, harness: string, reason: string }>
  prompts: Array<{ input: string, expected: string }>
  tools: Array<{ input: string, expected: string }>
  errors: Array<{ input: string, expected: string }>
  sensitive: Array<{ id: string, expected: boolean }>
  workflows: Array<{
    taskType: CaptureEvent['taskType']
    steps: CaptureEvent['workflowSteps']
    projection: ReturnType<typeof workflowProjection>
    family: string
  }>
  selection: {
    expectedRuleIds: string[]
    rules: Array<{ id: string, taskType: CaptureEvent['taskType'], confidence: number }>
  }
  trialLifecycle: { expectedStatuses: string[] }
  candidateThreshold: { pythonStatuses: string[], harnessStatuses: string[] }
}

const path = resolve(import.meta.dirname, 'fixtures/python-parity.json')
const fixture = JSON.parse(readFileSync(path, 'utf8')) as Fixture

const sensitiveInputs: Record<string, string> = {
  c1: '/Users/example/private',
  c2: 'https://example.test/private',
  c3: 'a@example.test',
  c4: 'api_key=not-a-real-value',
  c5: '普通的闭合规则分类',
}

function parityRule(input: Fixture['selection']['rules'][number]): EvolutionRule {
  const instruction = `处理代码任务时先检查规则 ${input.id.replace('rule_', '')} 的适用范围；完成后运行测试并核对真实输出。`
  return {
    id: input.id,
    status: 'active',
    category: 'workflow',
    taskType: input.taskType,
    workflowFamily: workflowFamily(input.taskType, ['file_ops', 'shell']),
    workflowSteps: ['file_ops', 'shell'],
    observedWorkflowSignatures: [sha256(input.id)],
    preferenceId: null,
    instruction,
    instructionHash: sha256(instruction),
    confidence: input.confidence,
    createdAt: 1,
    lastEvidenceAt: 1,
    lastSuccessAt: 1,
    expiresAt: 10_000,
    sessionHashes: [sha256(`${input.id}-session`)],
    version: 1,
    opportunities: 3,
    successes: 3,
    failures: 0,
    corrections: 0,
  }
}

function lifecycleEvent(index: number, ruleId: string): CaptureEvent {
  return {
    schemaVersion: 1,
    taskHash: sha256(`parity-task-${index}`),
    sessionHash: sha256(`parity-session-${index}`),
    occurredAt: 1_000 + index,
    taskType: 'coding',
    outcome: 'success',
    correction: false,
    complexity: 'medium',
    workflowSteps: ['file_ops', 'shell'],
    workflowSignature: sha256('parity-workflow'),
    errorKind: 'none',
    injectedRuleIds: [ruleId],
    preference: null,
  }
}

describe('current Python MSE parity', () => {
  test('matches task, tool, error and common privacy classification', () => {
    for (const item of fixture.prompts) expect(classifyPrompt(item.input).taskType).toBe(item.expected)
    for (const item of fixture.tools) expect(classifyTool(item.input)).toBe(item.expected)
    for (const item of fixture.errors) expect(classifyError(item.input)).toBe(item.expected)
    for (const item of fixture.sensitive) expect(containsSensitive(sensitiveInputs[item.id])).toBe(item.expected)
  })

  test('matches canonical workflow projections and SHA-256 families', () => {
    for (const item of fixture.workflows) {
      expect(workflowProjection(item.taskType, item.steps)).toEqual(item.projection)
      expect(workflowFamily(item.taskType, item.steps)).toBe(item.family)
    }
  })

  test('matches exact-task active-rule selection order', () => {
    const state: EvolutionState = {
      ...createEmptyState(0),
      rules: fixture.selection.rules.map(parityRule),
    }
    const selected = selectRules(state, {
      taskType: 'coding', now: 2_000, maxRules: 4, maxCodePoints: 2_000,
    })
    expect(selected.rules.map(rule => rule.id)).toEqual(fixture.selection.expectedRuleIds)
  })

  test('legacy parity fixture no longer bypasses causal promotion requirements', () => {
    const rule = parityRule({ id: 'rule_trial_parity', taskType: 'coding', confidence: 0.75 })
    rule.status = 'trial'
    rule.successes = 0
    rule.opportunities = 0
    let state: EvolutionState = { ...createEmptyState(0), rules: [rule] }
    const statuses: string[] = []
    for (const index of [1, 2, 3]) {
      state = capture(state, lifecycleEvent(index, rule.id)).state
      statuses.push(state.rules.find(candidate => candidate.id === rule.id)!.status)
    }
    expect(statuses).toEqual(['trial', 'trial', 'trial'])
  })

  test('pins every intentional Host semantic difference explicitly', () => {
    expect(fixture.documentedDifferences.map(item => item.id).sort()).toEqual([
      'candidate_session_threshold',
      'empty_error_vocabulary',
      'windows_path_privacy',
    ])
    expect(fixture.candidateThreshold.pythonStatuses).not.toEqual(fixture.candidateThreshold.harnessStatuses)
    expect(fixture.candidateThreshold.harnessStatuses).toEqual(['candidate', 'candidate', 'trial'])
  })

  test('fixture contains no durable sensitive sample text', () => {
    const raw = readFileSync(path, 'utf8')
    expect(raw).not.toMatch(/\/Users\/|\/home\/|https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|api[_-]?key\s*[:=]/iu)
  })
})
