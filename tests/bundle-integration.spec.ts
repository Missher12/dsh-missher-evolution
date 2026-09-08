import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
import type { MissherEvolutionRemote } from '../src/remote.js'
import type { BrainProviderLike } from '../src/brain-provider.js'
import type { PluginConfig } from '../src/types.js'

interface MountedPlugin {
  ctx: Context
  fiber: Fiber
  adapter: MseAdapter
  remote: MissherEvolutionRemote
  brain: BrainProviderLike
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
  let brain: BrainProviderLike | undefined
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
      brain = provider
      return () => { if (brain === provider) brain = undefined }
    },
  })
  const fiber = ctx.plugin(plugin, {
    enabled: config.enabled ?? true,
    maintenanceIntervalHours: config.maintenanceIntervalHours ?? 24,
    maxInjectedRules: config.maxInjectedRules ?? 4,
  })
  await fiber.await()
  if (brain === undefined) throw new Error('brain_provider_missing')
  const result = {
    ctx,
    fiber,
    adapter: (ctx as Context & { missherEvolutionCore: MseAdapter }).missherEvolutionCore,
    remote: (ctx as Context & { missherEvolution: MissherEvolutionRemote }).missherEvolution,
    brain,
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

async function completedScopedTurn(
  target: Pick<MountedPlugin, 'adapter' | 'brain'>,
  sessionId: string,
  occurredAt: number,
  reason: 'completed' | 'error' = 'completed',
): Promise<{ decision: PreStepDecision, offered: number }> {
  const owner = agent(sessionId)
  const prompt = user('小红书没有发布时间时不要写成今天，必须保持未知并核对来源字段。')
  const entered = { kind: 'enter' as const, messages: [prompt] }
  const decision = await target.adapter.preStep({
    agent: owner,
    messages: [prompt],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => entered)
  const batch = await target.brain.prepare({
    projectKey: 'media-project',
    sessionId,
    turn: 1,
    query: String((prompt.content[0] as { text: string }).text),
    signal: new AbortController().signal,
  })
  if (batch.items.length > 0) await batch.accept(batch.items.map(item => item.handle))
  else await batch.cancel()
  owner.session.events.push({
    type: 'tool/call',
    time: occurredAt,
    data: { turn: 1, step: 1, callId: `call-${sessionId}`, name: 'terminal' },
  })
  target.adapter.toolsResult(
    { agent: owner, callId: `call-${sessionId}`, name: 'terminal' },
    { isError: reason === 'error', ...(reason === 'error' ? { error: { name: 'TaskError' } } : {}) },
  )
  target.adapter.sessionEvent(owner.session, {
    type: 'turn/end',
    time: occurredAt + 1,
    data: { turn: 1, reason: { kind: reason } },
  })
  await target.adapter.drain()
  return { decision, offered: batch.items.length }
}

async function completedCausalTurn(
  target: Pick<MountedPlugin, 'adapter' | 'brain'>,
  sessionId: string,
  occurredAt: number,
): Promise<{ decision: PreStepDecision, treatment: boolean }> {
  const owner = agent(sessionId)
  const prompt = user('小红书没有发布时间时不要写成今天，必须保持未知并核对来源字段。')
  const entered = { kind: 'enter' as const, messages: [prompt] }
  const decision = await target.adapter.preStep({
    agent: owner,
    messages: [prompt],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => entered)
  const batch = await target.brain.prepare({
    projectKey: 'media-project',
    sessionId,
    turn: 1,
    query: String((prompt.content[0] as { text: string }).text),
    signal: new AbortController().signal,
  })
  const treatment = batch.items.length > 0
  if (treatment) await batch.accept(batch.items.map(item => item.handle))
  else await batch.accept([])
  owner.session.events.push({
    type: 'tool/call',
    time: occurredAt,
    data: { turn: 1, step: 1, callId: `call-${sessionId}`, name: 'terminal' },
  })
  target.adapter.toolsResult(
    { agent: owner, callId: `call-${sessionId}`, name: 'terminal' },
    {
      isError: !treatment,
      ...(!treatment ? { error: { name: 'TaskError' } } : {}),
    },
  )
  target.adapter.sessionEvent(owner.session, {
    type: 'turn/end',
    time: occurredAt + 1,
    data: { turn: 1, reason: { kind: treatment ? 'completed' : 'error' } },
  })
  await target.adapter.drain()
  return { decision, treatment }
}

afterEach(async () => {
  for (const target of mounted.splice(0)) {
    await target.fiber.dispose()
    await target.ctx.fiber.dispose()
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('built Harness bundle integration', () => {
  test('contains no runtime import that escapes to the SDK source tree', async () => {
    const lib = new URL('../lib/', import.meta.url)
    const files = (await readdir(lib)).filter(file => /\.(?:js|d\.ts)$/u.test(file))
    const output = (await Promise.all(files.map(file => readFile(new URL(file, lib), 'utf8')))).join('\n')
    expect(output).not.toMatch(/(?:from\s+|import\s*\()["']\.\.\/\.\.\/agent-product/u)
    expect(output).not.toMatch(/(?:\/Users\/|[A-Za-z]:\\)[^\r\n"']*Missher Evolution/u)
  })

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

  test('promotes only after causal uplift, persists scope, and recalls through Brain Hub', async () => {
    const profileRoot = await temporaryProfile()
    const first = await mountBuiltPlugin(profileRoot)
    await vi.waitFor(async () => {
      expect((await first.remote.snapshot()).counters.maintenanceRuns).toBe(1)
    })
    const startedAt = Date.now()
    for (let index = 0; index < 3; index += 1) {
      const turn = await completedScopedTurn(first, `candidate-${index}`, startedAt + index * 10)
      expect(turn.decision.kind).toBe('enter')
      expect(turn.offered).toBe(0)
    }
    expect((await first.remote.snapshot()).counters.trial).toBe(1)

    let treatments = 0
    let controls = 0
    for (let index = 0; index < 100 && (treatments < 3 || controls < 2); index += 1) {
      const turn = await completedCausalTurn(first, `trial-${index}`, startedAt + 100 + index * 10)
      expect(turn.decision.kind).toBe('enter')
      if (turn.treatment) treatments += 1
      else controls += 1
    }
    expect(treatments).toBeGreaterThanOrEqual(3)
    expect(controls).toBeGreaterThanOrEqual(2)
    expect((await first.remote.snapshot()).counters.active).toBe(1)
    await disposeMounted(first)

    const reopened = await mountBuiltPlugin(profileRoot)
    const restartPrompt = user('核对小红书发布时间来源字段。')
    const decision = await reopened.adapter.preStep({
      agent: agent('restart'),
      messages: [restartPrompt],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages: [restartPrompt] }))
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages).toEqual([restartPrompt])
    const recalled = await reopened.brain.prepare({
      projectKey: 'media-project',
      sessionId: 'restart',
      turn: 1,
      query: '核对小红书发布时间来源字段。',
      signal: new AbortController().signal,
    })
    expect(recalled.items).toHaveLength(1)
    expect(recalled.items[0]?.text).toContain('发布时间')
    await recalled.accept(recalled.items.map(item => item.handle))
    await reopened.adapter.drain()
    const state = await readFile(join(profileRoot, 'missher-evolution', 'state.json'), 'utf8')
    expect(state).not.toContain('小红书没有发布时间时不要写成今天')
    expect(state).not.toContain('media-project')
  }, 15_000)

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
