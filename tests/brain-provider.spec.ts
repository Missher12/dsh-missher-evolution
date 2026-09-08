import { describe, expect, test } from 'vitest'
import { MseAdapter, type HarnessUserMessage } from '../src/adapter.js'
import { EvolutionBrainProvider } from '../src/brain-provider.js'
import { sha256, workflowFamily } from '../src/lifecycle.js'
import { createEmptyState } from '../src/store.js'
import type { AuditEvent, EvolutionRule, EvolutionState } from '../src/types.js'

function user(text: string): HarnessUserMessage {
  return {
    id: `message-${sha256(text).slice(0, 8)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function rule(id: string, projectKey: string, instruction: string): EvolutionRule {
  return {
    id, status: 'active', category: 'guardrail', taskType: 'coding',
    workflowFamily: workflowFamily('coding', []), workflowSteps: [],
    observedWorkflowSignatures: [sha256(`signature-${id}`)], preferenceId: null,
    instruction, instructionHash: sha256(instruction), confidence: 0.9,
    createdAt: 1, lastEvidenceAt: 90, lastSuccessAt: 90, expiresAt: 1_000_000,
    sessionHashes: [sha256(`session-${id}`)], version: 2, opportunities: 3, successes: 3,
    failures: 0, corrections: 0,
    scope: { kind: 'project', keyHash: sha256(projectKey) },
    semanticKey: sha256(`semantic-${id}`), intentIds: [], constraintIds: [],
    verificationIds: [], noveltyScore: 0.8,
  }
}

class MemoryStore {
  state: EvolutionState
  readonly audits: AuditEvent[] = []

  constructor() {
    this.state = {
      ...createEmptyState(0),
      rules: [
        rule(
          'rule_matching',
          'project-a',
          '处理代码任务时保留未知字段并禁止推测补值；完成前检查来源并核对真实结果。',
        ),
        rule(
          'rule_other',
          'project-b',
          '处理代码任务时按项目要求执行限定步骤；完成前运行测试并核对真实结果。',
        ),
      ],
    }
  }

  async load(): Promise<EvolutionState> { return structuredClone(this.state) }
  async update(
    expectedRevision: number,
    mutate: (state: EvolutionState) => EvolutionState,
  ): Promise<EvolutionState> {
    if (expectedRevision !== this.state.revision) throw new Error('revision_conflict')
    this.state = { ...mutate(structuredClone(this.state)), revision: this.state.revision + 1 }
    return structuredClone(this.state)
  }
  async appendAudit(event: AuditEvent): Promise<void> { this.audits.push(structuredClone(event)) }
}

class ChangingStore extends MemoryStore {
  loads = 0
  override async load(): Promise<EvolutionState> {
    this.loads += 1
    const snapshot = await super.load()
    if (this.loads === 1) {
      const changed = this.state.rules.find(item => item.id === 'rule_matching')
      if (changed !== undefined) {
        changed.instruction = '这一条是在选择完成后才出现的并发改写，不得进入当前 Brain 批次。'
        changed.instructionHash = sha256(changed.instruction)
        changed.version += 1
      }
    }
    return snapshot
  }
}

function payload(messages: HarnessUserMessage[], sessionId = 'session-a') {
  return {
    agent: {
      id: sessionId,
      options: { provider: 'deepseek', model: 'deepseek-chat' },
      session: { id: sessionId, header: {}, events: [] },
    },
    messages,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }
}

describe('EvolutionBrainProvider', () => {
  test('pre-step observes the turn but never injects its own prompt message', async () => {
    const store = new MemoryStore()
    const adapter = new MseAdapter({ store, now: () => 100 })
    const entered = { kind: 'enter' as const, messages: [user('修复 TypeScript 测试')] }

    const decision = await adapter.preStep(payload(entered.messages), async () => entered)

    expect(decision).toEqual(entered)
    expect(decision.kind === 'enter' ? decision.messages : []).toHaveLength(1)
    expect(store.state.counters.injections).toBe(0)
  })

  test('uses project scope and attributes only handles accepted by Brain Hub', async () => {
    const store = new MemoryStore()
    const adapter = new MseAdapter({ store, now: () => 100 })
    const query = '修复 TypeScript 测试'
    const entered = { kind: 'enter' as const, messages: [user(query)] }
    await adapter.preStep(payload(entered.messages), async () => entered)
    const provider = new EvolutionBrainProvider({ store, adapter, now: () => 100, maxRules: 4 })

    const prepared = await provider.prepare({
      projectKey: 'project-a', sessionId: 'session-a', turn: 1, query,
      signal: new AbortController().signal,
    })

    expect(prepared.items.map(item => item.handle)).toEqual(['rule_matching'])
    expect(prepared.items[0]).toMatchObject({
      providerId: 'evolution',
      kind: 'learned-rule',
      reference: 'mse:rule_matching@2',
    })
    expect(store.state.counters.injections).toBe(0)

    await prepared.accept(['rule_matching'])
    await adapter.drain()
    expect(store.state.counters.injections).toBe(1)
    expect(adapter.registry.claimCapture('session-a', 1)?.injectedRuleIds).toEqual(['rule_matching'])
  })

  test('cancellation is mutation-free and an unknown project sees no scoped rule', async () => {
    const store = new MemoryStore()
    const adapter = new MseAdapter({ store, now: () => 100 })
    const query = '修复 TypeScript 测试'
    const entered = { kind: 'enter' as const, messages: [user(query)] }
    await adapter.preStep(payload(entered.messages, 'session-cancel'), async () => entered)
    const provider = new EvolutionBrainProvider({ store, adapter, now: () => 100, maxRules: 4 })

    const prepared = await provider.prepare({
      projectKey: 'project-unknown', sessionId: 'session-cancel', turn: 1, query,
      signal: new AbortController().signal,
    })
    expect(prepared.items).toEqual([])
    await prepared.cancel()
    await adapter.drain()

    expect(store.state.counters.injections).toBe(0)
    await expect(provider.status()).resolves.toEqual({ state: 'ready', count: 2 })
  })

  test('offers the exact selected snapshot instead of re-reading a changed rule', async () => {
    const store = new ChangingStore()
    const adapter = new MseAdapter({ store, now: () => 100 })
    const provider = new EvolutionBrainProvider({ store, adapter, now: () => 100, maxRules: 4 })

    const prepared = await provider.prepare({
      projectKey: 'project-a', sessionId: 'session-race', turn: 1,
      query: '修复 TypeScript 测试', signal: new AbortController().signal,
    })

    expect(store.loads).toBe(1)
    expect(prepared.items).toHaveLength(1)
    expect(prepared.items[0]?.reference).toBe('mse:rule_matching@2')
    expect(prepared.items[0]?.text).toContain('保留未知字段')
    expect(prepared.items[0]?.text).not.toContain('并发改写')
  })
})
