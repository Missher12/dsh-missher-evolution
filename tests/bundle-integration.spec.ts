import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, test, vi } from 'vitest'
import plugin from '../lib/index.js'
import type {
  AgentLike,
  HarnessUserMessage,
  MseAdapter,
  PreStepDecision,
} from '../src/adapter.js'
import type { BrainProviderLike } from '../src/brain-provider.js'
import type { MissherEvolutionRemote } from '../src/remote.js'
import type { PluginConfig } from '../src/types.js'

interface MountedPlugin {
  ctx: Context
  fiber: Fiber
  adapter: MseAdapter
  brainProvider: BrainProviderLike
  remote: MissherEvolutionRemote
}

const roots: string[] = []
const mounted: MountedPlugin[] = []

async function temporaryProfile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mse-bundle-'))
  roots.push(root)
  return root
}

async function mountBuiltPlugin(
  profileRoot: string,
  config: PluginConfig = {},
): Promise<MountedPlugin> {
  const ctx = new Context()
  let brainProvider: BrainProviderLike | undefined
  ctx.provide('agents', {})
  ctx.provide('tools', {})
  ctx.provide('dshHomePath', (...segments: string[]) => join(profileRoot, ...segments))
  ctx.provide('llm', {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  ctx.provide('missherBrain', {
    register(provider: BrainProviderLike) {
      brainProvider = provider
      return () => { brainProvider = undefined }
    },
  })
  const fiber = ctx.plugin(plugin, {
    enabled: config.enabled ?? true,
    maintenanceIntervalHours: config.maintenanceIntervalHours ?? 24,
    maxInjectedRules: config.maxInjectedRules ?? 4,
  })
  await fiber.await()
  if (brainProvider === undefined) throw new Error('brain provider was not registered')
  const result = {
    ctx,
    fiber,
    adapter: (ctx as Context & { missherEvolutionCore: MseAdapter }).missherEvolutionCore,
    brainProvider,
    remote: (ctx as Context & { missherEvolution: MissherEvolutionRemote }).missherEvolution,
  }
  mounted.push(result)
  return result
}

async function disposeMounted(target: MountedPlugin): Promise<void> {
  const index = mounted.indexOf(target)
  if (index >= 0) mounted.splice(index, 1)
  await target.fiber.dispose()
  await target.ctx.fiber.dispose()
}

function user(text: string): HarnessUserMessage {
  return {
    id: `message-${text}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function agent(sessionId: string): AgentLike {
  return {
    id: `agent-${sessionId}`,
    options: { provider: 'deepseek', model: 'deepseek-chat' },
    session: { id: sessionId, header: {}, events: [] },
  }
}

async function completedCodingTurn(
  adapter: MseAdapter,
  brainProvider: BrainProviderLike,
  sessionId: string,
  occurredAt: number,
): Promise<PreStepDecision> {
  const owner = agent(sessionId)
  const prompt = user('修复 TypeScript 测试并运行目标测试核对结果')
  const entered = { kind: 'enter' as const, messages: [prompt] }
  const decision = await adapter.preStep({
    agent: owner,
    messages: [prompt],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => entered)
  const prepared = await brainProvider.prepare({
    projectKey: 'a'.repeat(64),
    sessionId,
    turn: 1,
    query: '修复 TypeScript 测试并运行目标测试核对结果',
    signal: new AbortController().signal,
  })
  if (prepared.items.length > 0) {
    await prepared.accept(prepared.items.map(item => item.handle))
  } else {
    await prepared.cancel()
  }
  owner.session.events.push({
    type: 'tool/call',
    time: occurredAt,
    data: { turn: 1, step: 1, callId: `call-${sessionId}`, name: 'terminal' },
  })
  adapter.toolsResult(
    { agent: owner, callId: `call-${sessionId}`, name: 'terminal' },
    { isError: false },
  )
  adapter.sessionEvent(owner.session, {
    type: 'turn/end',
    time: occurredAt + 1,
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  await adapter.drain()
  return decision
}

afterEach(async () => {
  for (const target of mounted.splice(0)) {
    await target.fiber.dispose()
    await target.ctx.fiber.dispose()
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('built Harness bundle integration', () => {
  test('uses config only for first install and persists the settings remote choice', async () => {
    const profileRoot = await temporaryProfile()
    const first = await mountBuiltPlugin(profileRoot, { enabled: false })
    await vi.waitFor(async () => {
      expect((await first.remote.snapshot()).counters.maintenanceRuns).toBe(1)
    })
    const initial = await first.remote.snapshot()
    expect(initial.enabled).toBe(false)
    const enabled = await first.remote.setEnabled({
      enabled: true,
      expectedRevision: initial.revision,
    })
    expect(enabled.enabled).toBe(true)
    await disposeMounted(first)

    const reopened = await mountBuiltPlugin(profileRoot, { enabled: false })
    expect((await reopened.remote.snapshot()).enabled).toBe(true)
  })

  test('promotes repeated evidence, reloads it, and contributes through the Brain provider', async () => {
    const profileRoot = await temporaryProfile()
    const first = await mountBuiltPlugin(profileRoot)
    await vi.waitFor(async () => {
      expect((await first.remote.snapshot()).counters.maintenanceRuns).toBe(1)
    })
    const startedAt = Date.now()
    for (let index = 0; index < 3; index += 1) {
      const decision = await completedCodingTurn(
        first.adapter, first.brainProvider, `candidate-${index}`, startedAt + index * 10,
      )
      expect(decision.kind).toBe('enter')
    }
    expect((await first.remote.snapshot()).counters.trial).toBe(1)

    for (let index = 0; index < 3; index += 1) {
      const decision = await completedCodingTurn(
        first.adapter, first.brainProvider, `trial-${index}`, startedAt + 100 + index * 10,
      )
      expect(decision.kind).toBe('enter')
      if (decision.kind !== 'enter') throw new Error('expected enter')
      expect(decision.messages).toHaveLength(1)
    }
    expect((await first.remote.snapshot()).counters.active).toBe(1)
    await disposeMounted(first)

    const reopened = await mountBuiltPlugin(profileRoot)
    await reopened.adapter.preStep({
      agent: agent('restart'),
      messages: [user('修复 TypeScript 测试并运行目标测试核对结果')],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({
      kind: 'enter',
      messages: [user('修复 TypeScript 测试并运行目标测试核对结果')],
    }))
    const prepared = await reopened.brainProvider.prepare({
      projectKey: 'a'.repeat(64),
      sessionId: 'restart',
      turn: 1,
      query: '修复 TypeScript 测试并运行目标测试核对结果',
      signal: new AbortController().signal,
    })
    expect(prepared.items[0]).toMatchObject({
      providerId: 'evolution', kind: 'learned-rule', reference: expect.stringMatching(/^mse:/u),
    })
    const state = await readFile(join(profileRoot, 'missher-evolution', 'state.json'), 'utf8')
    expect(state).not.toContain('修复 TypeScript 测试并运行目标测试核对结果')
  })

  test('recovers from a valid backup and fails open when the state root is unavailable', async () => {
    const profileRoot = await temporaryProfile()
    const first = await mountBuiltPlugin(profileRoot)
    await vi.waitFor(async () => {
      expect((await first.remote.snapshot()).counters.maintenanceRuns).toBe(1)
    })
    await disposeMounted(first)
    await writeFile(join(profileRoot, 'missher-evolution', 'state.json'), '{corrupt', 'utf8')
    const recovered = await mountBuiltPlugin(profileRoot)
    expect((await recovered.remote.snapshot()).health).toBe('degraded')

    const blockedProfile = await temporaryProfile()
    await mkdir(blockedProfile, { recursive: true })
    await writeFile(join(blockedProfile, 'missher-evolution'), 'not-a-directory', 'utf8')
    const unavailable = await mountBuiltPlugin(blockedProfile)
    const entered = {
      kind: 'enter' as const,
      messages: [user('修复测试')],
    }
    const decision = await unavailable.adapter.preStep({
      agent: agent('unavailable'),
      messages: entered.messages,
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, async () => entered)
    expect(decision).toBe(entered)
  })
})
