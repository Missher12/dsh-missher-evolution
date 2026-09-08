import { describe, expect, test, vi } from 'vitest'
import {
  HARNESS_ADAPTER_DESCRIPTOR,
  MseAdapter,
  type AgentLike,
  type HarnessUserMessage,
} from '../src/adapter.js'
import { workflowFamily, sha256 } from '../src/lifecycle.js'
import { createEmptyState } from '../src/store.js'
import type { AuditEvent, EvolutionRule, EvolutionState } from '../src/types.js'

function user(text: string, source: HarnessUserMessage['source'] = { kind: 'user' }): HarnessUserMessage {
  return {
    id: `message-${text}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  }
}

function rule(): EvolutionRule {
  const instruction = '处理代码任务时先检查目标实现，再执行最小修改；完成后运行测试并核对真实结果。'
  return {
    id: 'rule_verified',
    status: 'active',
    category: 'workflow',
    taskType: 'coding',
    workflowFamily: workflowFamily('coding', ['file_ops', 'shell']),
    workflowSteps: ['file_ops', 'shell'],
    observedWorkflowSignatures: [sha256('file_ops,shell')],
    preferenceId: null,
    instruction,
    instructionHash: sha256(instruction),
    confidence: 0.9,
    createdAt: 1,
    lastEvidenceAt: 1,
    lastSuccessAt: 1,
    expiresAt: 1_000_000,
    sessionHashes: [sha256('session-old')],
    version: 1,
    opportunities: 3,
    successes: 3,
    failures: 0,
    corrections: 0,
  }
}

class MemoryStore {
  state: EvolutionState
  readonly audits: AuditEvent[] = []
  failure = false

  constructor(state: EvolutionState = createEmptyState(0)) {
    this.state = structuredClone(state)
  }

  async load(): Promise<EvolutionState> {
    if (this.failure) throw new Error('private path should not be logged')
    return structuredClone(this.state)
  }

  async update(
    expectedRevision: number,
    mutate: (state: EvolutionState) => EvolutionState,
  ): Promise<EvolutionState> {
    if (this.failure) throw new Error('private path should not be logged')
    if (expectedRevision !== this.state.revision) {
      throw Object.assign(new Error('revision_conflict'), { code: 'revision_conflict' })
    }
    this.state = {
      ...mutate(structuredClone(this.state)),
      revision: this.state.revision + 1,
    }
    return structuredClone(this.state)
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    this.audits.push(structuredClone(event))
  }
}

function agent(overrides: Partial<AgentLike['session']['header']> = {}): AgentLike {
  return {
    id: 'session-a',
    options: { provider: 'deepseek', model: 'deepseek-chat' },
    session: {
      id: 'session-a',
      header: { ...overrides },
      events: [],
    },
  }
}

describe('MseAdapter', () => {
  test('native bash nonzero exit is negative evidence even when tool transport succeeded', async () => {
    const owner = agent()
    owner.session.events.push({ type: 'tool/call', time: 105, data: { turn: 1, callId: 'bash-exit' } })
    const store = new MemoryStore()
    const adapter = new MseAdapter({ store, now: () => 100 })
    const messages = [user('修复 TypeScript 测试')]
    await adapter.preStep({ agent: owner, messages, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }))
    adapter.toolsResult({ agent: owner, callId: 'bash-exit', name: 'bash' }, { isError: false, value: { exitCode: 1, stdout: 'private output' } })
    adapter.sessionEvent(owner.session, { type: 'turn/end', time: 120, data: { turn: 1, reason: { kind: 'completed' } } })
    await adapter.drain()
    expect(store.audits.find(item => item.kind === 'capture_applied')?.outcomeQuality).toBe('contradicted')
    expect(JSON.stringify(store.state)).not.toContain('private output')
    await adapter.dispose()
  })

  test('native recall uses authoritative header cwd and only credits persisted context', async () => {
    const owner = agent({ cwd: '/fixture/project' })
    const store = new MemoryStore({ ...createEmptyState(0), rules: [{ ...rule(), scope: { kind: 'project', keyHash: sha256('/fixture/project') } }] })
    const adapter = new MseAdapter({ store, now: () => 100, nativeMessage: text => ({ ...user(text, { kind: 'plugin', plugin: 'missher-evolution' }), id: 'native-context' }) })
    const messages = [user('修复 TypeScript 测试')]
    const decision = await adapter.preStep({ agent: owner, messages, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }))
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('fixture')
    expect(decision.messages).toHaveLength(2)
    await adapter.drain()
    expect(store.state.counters.injections).toBe(0)
    adapter.sessionEvent(owner.session, { type: 'user/message', time: 110, data: decision.messages[1] as unknown as Record<string, unknown> })
    await adapter.drain()
    expect(store.state.counters.injections).toBe(1)
    expect(JSON.stringify(store.state)).not.toContain('/fixture/project')
    await adapter.dispose()
  })

  test('uncommitted native context is canceled on turn end', async () => {
    const owner = agent()
    const store = new MemoryStore({ ...createEmptyState(0), rules: [rule()] })
    const adapter = new MseAdapter({ store, now: () => 100, nativeMessage: text => user(text, { kind: 'plugin' }) })
    const messages = [user('修复 TypeScript 测试')]
    await adapter.preStep({ agent: owner, messages, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }))
    adapter.sessionEvent(owner.session, { type: 'turn/end', time: 120, data: { turn: 1, reason: { kind: 'aborted' } } })
    await adapter.drain()
    expect(store.state.counters.injections).toBe(0)
    expect(store.state.rules[0]?.opportunities).toBe(3)
    await adapter.dispose()
  })

  test('current host eventAt log records tool failure without a legacy events array', async () => {
    const owner = agent()
    const events = [{ type: 'tool/call', time: 110, data: { turn: 1, callId: 'current-call' } }]
    Object.assign(owner.session, { events: undefined, seq: 1, eventAt: (index: number) => events[index] })
    const store = new MemoryStore()
    const adapter = new MseAdapter({ store, now: () => 100 })
    const messages = [user('修复 TypeScript 测试')]
    await adapter.preStep({ agent: owner, messages, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }))
    adapter.toolsResult({ agent: owner, callId: 'current-call', name: 'terminal' }, { isError: true, error: { name: 'TimeoutError' } })
    adapter.sessionEvent(owner.session, { type: 'turn/end', time: 120, data: { turn: 1, reason: { kind: 'completed' } } })
    await adapter.drain()
    expect(store.audits.find(item => item.kind === 'capture_applied')?.outcomeQuality).toBe('contradicted')
    await adapter.dispose()
  })

  test('declares the Harness reference adapter capabilities', () => {
    expect(HARNESS_ADAPTER_DESCRIPTOR).toEqual({
      schemaVersion: 1,
      id: 'deepseek-harness',
      displayName: 'DeepSeek Harness',
      version: '0.7.0',
      capabilities: [
        'turns',
        'tools',
        'assistant-outcome',
        'errors',
        'session-dispose',
        'model-route',
      ],
    })
    expect(Object.isFrozen(HARNESS_ADAPTER_DESCRIPTOR)).toBe(true)
  })

  test('observes step 1 and leaves all injection to Brain Hub', async () => {
    const store = new MemoryStore({ ...createEmptyState(0), rules: [rule()] })
    const adapter = new MseAdapter({ store, now: () => 100 })
    const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [user('修复 TypeScript 测试')] }))
    const decision = await adapter.preStep({
      agent: agent(),
      messages: [user('修复 TypeScript 测试')],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, next)
    expect(next).toHaveBeenCalledOnce()
    expect(decision).toMatchObject({ kind: 'enter' })
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages).toEqual([user('修复 TypeScript 测试')])
    expect(adapter.registry.size).toBe(1)
    await adapter.drain()
    expect(store.state.counters.injections).toBe(0)
  })

  test('remembers only the latest direct foreground model route for maintenance', async () => {
    const adapter = new MseAdapter({ store: new MemoryStore(), now: () => 100 })
    await adapter.preStep({
      agent: agent(), messages: [user('修复测试')], turn: 1, step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages: [user('修复测试')] }))
    expect(adapter.advisorRoute()).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    const child = agent({ origin: 'subagent', delegationDepth: 1 })
    Object.assign(child.options, { provider: 'private-child', model: 'private-child-model' })
    await adapter.preStep({
      agent: child, messages: [user('修复测试')], turn: 1, step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages: [user('修复测试')] }))
    expect(adapter.advisorRoute()).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  test('preserves downstream rejection when selection succeeds', async () => {
    const rejection = { kind: 'reject' as const }
    const store = new MemoryStore({ ...createEmptyState(0), rules: [rule()] })
    const adapter = new MseAdapter({
      store,
      now: () => 100,
    })
    const decision = await adapter.preStep({
      agent: agent(), messages: [user('修复测试')], turn: 1, step: 1,
      signal: new AbortController().signal,
    }, async () => rejection)
    expect(decision).toBe(rejection)
    await adapter.drain()
    expect(store.state.counters.injections).toBe(0)
  })

  test('does not inject on tool continuation or subagent sessions', async () => {
    const store = new MemoryStore({ ...createEmptyState(0), rules: [rule()] })
    const adapter = new MseAdapter({ store, now: () => 100 })
    const entered = { kind: 'enter' as const, messages: [user('修复测试')] }
    const continuation = await adapter.preStep({
      agent: agent(), messages: [], turn: 1, step: 2,
      signal: new AbortController().signal,
    }, async () => entered)
    const child = await adapter.preStep({
      agent: agent({ origin: 'subagent', delegationDepth: 1 }),
      messages: [user('修复测试')], turn: 1, step: 1,
      signal: new AbortController().signal,
    }, async () => entered)
    expect(continuation).toBe(entered)
    expect(child).toBe(entered)
  })

  test('fails open when the store throws and logs only a closed code', async () => {
    const store = new MemoryStore({ ...createEmptyState(0), rules: [rule()] })
    store.failure = true
    const warnings: string[] = []
    const adapter = new MseAdapter({ store, now: () => 100, warn: code => warnings.push(code) })
    const entered = { kind: 'enter' as const, messages: [user('修复测试')] }
    const decision = await adapter.preStep({
      agent: agent(), messages: entered.messages, turn: 1, step: 1,
      signal: new AbortController().signal,
    }, async () => entered)
    expect(decision).toBe(entered)
    expect(warnings).toEqual(['state_unavailable'])
    expect(JSON.stringify(warnings)).not.toContain('private path')
  })

  test('observes authoritative tool result and captures once at turn end', async () => {
    const store = new MemoryStore()
    const adapter = new MseAdapter({ store, now: () => 100 })
    const owner = agent()
    await adapter.preStep({
      agent: owner, messages: [user('修复 TypeScript 测试')], turn: 3, step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages: [user('修复 TypeScript 测试')] }))
    owner.session.events.push({
      type: 'tool/call', time: 101, data: { turn: 3, step: 1, callId: 'call-a', name: 'terminal' },
    })
    adapter.toolsResult(
      { agent: owner, callId: 'call-a', name: 'terminal' },
      { isError: false },
    )
    adapter.sessionEvent(owner.session, {
      type: 'turn/end', time: 102, data: { turn: 3, reason: { kind: 'completed' } },
    })
    adapter.sessionEvent(owner.session, {
      type: 'turn/end', time: 103, data: { turn: 3, reason: { kind: 'completed' } },
    })
    await adapter.drain()
    expect(store.state.counters.captures).toBe(1)
    expect(store.state.rules).toEqual([])
  })
})
