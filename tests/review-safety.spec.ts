import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, test, vi } from 'vitest'
import plugin from '../lib/index.js'
import { capture, selectRules, sha256 } from '../src/lifecycle.js'
import { EvolutionStore, createEmptyState, evolutionStateSchema } from '../src/store.js'
import { MissherEvolutionRemote } from '../src/remote.js'
import { EvolutionBrainProvider } from '../src/brain-provider.js'
import { MseAdapter } from '../src/adapter.js'
import type { CaptureEvent, EvolutionState } from '../src/types.js'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
function event(id: string, overrides: Partial<CaptureEvent> = {}): CaptureEvent {
  return { schemaVersion: 1, taskHash: sha256(id), sessionHash: sha256(id), occurredAt: 100,
    taskType: 'coding', outcome: 'success', correction: false, complexity: 'medium',
    workflowSteps: ['shell'], workflowSignature: sha256('shell'), errorKind: 'none',
    injectedRuleIds: [], preference: null, ...overrides }
}
function trial(): EvolutionState {
  let state = createEmptyState(0)
  for (const id of ['a', 'b', 'c']) state = capture(state, event(id)).state
  return state
}
const selection = { taskType: 'coding' as const, now: 200, maxRules: 4 }
async function service() {
  const home = await mkdtemp(join(tmpdir(), 'evolution-review-home-'))
  roots.push(home)
  const store = new EvolutionStore(join(home, 'missher-evolution'), { now: () => 200 })
  await store.update(0, () => trial())
  const ctx = new Context(); contexts.push(ctx)
  return { home, store, remote: new MissherEvolutionRemote(ctx, store, { now: () => 200 }) }
}

test('old rules default to unapproved; approval and revocation persist across restart', async () => {
  const { store, remote } = await service()
  let view = await remote.snapshot()
  const id = view.rules[0]!.id
  expect(selectRules(await store.load(), selection).rules).toHaveLength(0)
  const old = trial(); delete old.rules[0]!.approvedHash; delete old.rules[0]!.trialSessionHashes
  expect(selectRules(evolutionStateSchema.parse(old), selection).rules).toHaveLength(0)
  view = await remote.reviewRule({ ruleId: id, action: 'approve', expectedRevision: view.revision, expectedVersion: view.rules[0]!.version! })
  expect(selectRules(await new EvolutionStore(store.root).load(), selection).rules).toHaveLength(1)
  await expect(remote.reviewRule({ ruleId: id, action: 'revoke', expectedRevision: 1, expectedVersion: 1 })).rejects.toMatchObject({ code: 'revision_conflict' })
  await remote.reviewRule({ ruleId: id, action: 'revoke', expectedRevision: view.revision, expectedVersion: view.rules[0]!.version! })
  expect(selectRules(await new EvolutionStore(store.root).load(), selection).rules).toHaveLength(0)
})

test('reset can be rolled back without reusing approval or revision; preserves enabled choice', async () => {
  const { store, remote } = await service()
  const before = await remote.snapshot()
  const reset = await remote.reset({ expectedRevision: before.revision, confirmation: 'RESET' })
  const disabled = await remote.setEnabled({ expectedRevision: reset.snapshot.revision, enabled: false })
  await expect(remote.restore({ expectedRevision: before.revision, backupId: reset.backupId, confirmation: 'RESTORE' })).rejects.toMatchObject({ code: 'revision_conflict' })
  const restored = await remote.restore({ expectedRevision: disabled.revision, backupId: reset.backupId, confirmation: 'RESTORE' })
  expect(restored.rules).toHaveLength(1)
  expect(restored.rules[0]!.approved).toBe(false)
  expect(restored.enabled).toBe(false)
  expect(restored.revision).toBe(disabled.revision + 1)
  expect((await store.readBackup(restored.lastBackupId!)).rules).toHaveLength(0)
  await expect(remote.restore({ expectedRevision: restored.revision, backupId: '../state', confirmation: 'RESTORE' })).rejects.toBeDefined()
})

test('same-session successes cannot promote Trial; corrections override success', () => {
  let state = trial(); const rule = state.rules[0]!; rule.approvedHash = rule.instructionHash
  for (const id of ['d', 'e', 'f']) state = capture(state, event(id, { sessionHash: sha256('same'), injectedRuleIds: [rule.id] })).state
  expect(state.rules[0]!.status).toBe('trial')
  expect(state.rules[0]!.successes).toBe(1)
  state = capture(state, event('g', { correction: true, injectedRuleIds: [rule.id] })).state
  expect(state.rules[0]!.status).toBe('suspended')
  expect(state.rules[0]!.successes).toBe(1)
})

test('failures do not create successful workflows, expired and retired rules do not revive', () => {
  expect(capture(createEmptyState(0), event('bad', { errorKind: 'tool_error' })).state.rules).toHaveLength(0)
  let state = trial(); state.rules[0]!.expiresAt = 150
  state = capture(state, event('expired', { occurredAt: 200 })).state
  expect(state.rules[0]!.status).toBe('retired')
  state = capture(state, event('again', { occurredAt: 201 })).state
  expect(state.rules).toHaveLength(1)
  expect(state.rules[0]!.status).toBe('retired')
})

test('selection stays within task category, resolves workflow competitors and honors disable', () => {
  const state = trial(); const rule = state.rules[0]!; rule.approvedHash = rule.instructionHash
  state.rules.push({ ...rule, id: 'rule_competing', instruction: '执行之前核对目标，完成后检查结果。' })
  expect(selectRules(state, selection).rules).toHaveLength(1)
  expect(selectRules(state, { ...selection, taskType: 'research' }).rules).toHaveLength(0)
  state.enabled = false
  expect(selectRules(state, selection).rules).toHaveLength(0)
  expect(capture(state, event('disabled')).state.counters.captures).toBe(3)
})

test('capacity and retired identity remain valid in the durable schema', () => {
  const state = trial()
  state.rules = Array.from({ length: 200 }, (_, i) => ({ ...state.rules[0]!, id: `rule_${i}`, workflowFamily: sha256(`family-${i}`) }))
  const result = capture(state, event('capacity')).state
  expect(result.rules).toHaveLength(200)
  expect(evolutionStateSchema.safeParse(result).success).toBe(true)
})

test('prepared contribution is rejected after approval is revoked or request is aborted', async () => {
  const { store, remote } = await service()
  const view = await remote.snapshot()
  const approved = await remote.reviewRule({ ruleId: view.rules[0]!.id, expectedRevision: view.revision, expectedVersion: view.rules[0]!.version!, action: 'approve' })
  const adapter = new MseAdapter({ store })
  const provider = new EvolutionBrainProvider({ store, adapter, now: () => 200, maxRules: 4 })
  const controller = new AbortController()
  const request = { projectKey: sha256('project'), sessionId: 's', turn: 1, query: '修复测试', signal: controller.signal }
  const batch = await provider.prepare(request)
  await remote.reviewRule({ ruleId: approved.rules[0]!.id, expectedRevision: approved.revision, expectedVersion: approved.rules[0]!.version!, action: 'revoke' })
  await expect(batch.accept([view.rules[0]!.id])).rejects.toThrow('brain_batch_stale')
  controller.abort()
  await expect(provider.prepare(request)).rejects.toBeDefined()
  await adapter.dispose()
})

test('built host runs local management without Brain Hub and registers when it appears', async () => {
  const home = await mkdtemp(join(tmpdir(), 'evolution-no-brain-')); roots.push(home)
  const ctx = new Context(); contexts.push(ctx)
  ctx.provide('agents', {}); ctx.provide('tools', {})
  ctx.provide('dshHomePath', (...segments: string[]) => join(home, ...segments))
  ctx.provide('llm', { async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } } })
  const fiber = ctx.plugin(plugin, {})
  await fiber.await()
  expect(ctx.missherEvolutionCore).toBeDefined()
  await vi.waitFor(async () => expect((await ctx.missherEvolution.snapshot()).counters.maintenanceRuns).toBe(1))
  const register = vi.fn(() => vi.fn())
  ctx.provide('missherBrain', { register })
  await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1))
  const unregister = register.mock.results[0]!.value
  await fiber.dispose()
  expect(unregister).toHaveBeenCalledTimes(1)
})

test('an old contribution cannot supply evidence after the rule is re-reviewed', () => {
  const state = trial(); const rule = state.rules[0]!
  rule.approvedHash = rule.instructionHash
  const oldVersion = rule.version; rule.version += 1
  const result = capture(state, event('stale-attribution', {
    injectedRuleIds: [rule.id], injectedRuleVersions: { [rule.id]: oldVersion },
  })).state
  expect(result.rules[0]!.successes).toBe(0)
})
