import { describe, expect, test } from 'vitest'
import { MseAdapter, type HarnessUserMessage } from '../src/adapter.js'
import { EvolutionBrainProvider } from '../src/brain-provider.js'
import { workflowFamily, sha256 } from '../src/lifecycle.js'
import { createEmptyState } from '../src/store.js'
import type { AuditEvent, EvolutionRule, EvolutionState } from '../src/types.js'

function user(text: string): HarnessUserMessage {
  return {
    id: `message-${text}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function rule(): EvolutionRule {
  const instruction = '处理代码任务时先检查目标实现，再执行最小修改；完成后运行测试并核对真实结果。'
  return {
    id: 'rule_verified', status: 'active', category: 'workflow', taskType: 'coding',
    workflowFamily: workflowFamily('coding', ['file_ops', 'shell']),
    workflowSteps: ['file_ops', 'shell'], observedWorkflowSignatures: [sha256('file_ops,shell')],
    preferenceId: null, instruction, instructionHash: sha256(instruction), confidence: 0.9,
    createdAt: 1, lastEvidenceAt: 90, lastSuccessAt: 90, expiresAt: 1_000_000,
    sessionHashes: [sha256('session-old')], version: 1, opportunities: 3, successes: 3,
    failures: 0, corrections: 0,
  }
}

class MemoryStore {
  state: EvolutionState
  readonly audits: AuditEvent[] = []

  constructor() {
    this.state = { ...createEmptyState(0), rules: [rule()] }
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

const request = {
  projectKey: 'a'.repeat(64),
  sessionId: 'session-a',
  turn: 1,
  query: '修复 TypeScript 测试',
  signal: new AbortController().signal,
}

describe('EvolutionBrainProvider', () => {
  test('prepares learned rules without mutation and attributes only accepted handles', async () => {
    const store = new MemoryStore()
    const adapter = new MseAdapter({ store, now: () => 100 })
    const entered = { kind: 'enter' as const, messages: [user(request.query)] }
    await adapter.preStep({
      agent: {
        id: request.sessionId,
        options: { provider: 'deepseek', model: 'deepseek-chat' },
        session: { id: request.sessionId, header: {}, events: [] },
      },
      messages: entered.messages,
      turn: request.turn,
      step: 1,
      signal: request.signal,
    }, async () => entered)
    const provider = new EvolutionBrainProvider({ store, adapter, now: () => 100, maxRules: 4 })

    const prepared = await provider.prepare(request)
    expect(prepared.items).toEqual([expect.objectContaining({
      handle: 'rule_verified',
      providerId: 'evolution',
      kind: 'learned-rule',
      text: rule().instruction,
      reference: 'mse:rule_verified@1',
    })])
    expect(store.state.counters.injections).toBe(0)

    await prepared.accept(['rule_verified'])
    await adapter.drain()
    expect(store.state.counters.injections).toBe(1)
    expect(adapter.registry.claimCapture(request.sessionId, request.turn)?.injectedRuleIds)
      .toEqual(['rule_verified'])
  })

  test('cancellation is mutation-free and status counts only injectable rules', async () => {
    const store = new MemoryStore()
    const adapter = new MseAdapter({ store, now: () => 100 })
    const provider = new EvolutionBrainProvider({ store, adapter, now: () => 100, maxRules: 4 })
    const prepared = await provider.prepare(request)

    await prepared.cancel()
    await adapter.drain()
    expect(store.state.counters.injections).toBe(0)
    await expect(provider.status()).resolves.toEqual({ state: 'ready', count: 1 })
  })
})
