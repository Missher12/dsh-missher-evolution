import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MseAdapter, parseNativeCheckerCommand, type AgentLike, type HarnessUserMessage, type ToolExecutionLike } from '../src/adapter.js'
import { EvolutionEngine } from '../src/engine.js'
import { canonicalRuleInstruction, sha256 } from '../src/lifecycle.js'
import { EvolutionStore } from '../src/store.js'
import type { EvolutionRule } from '../src/types.js'
import { checkFiles, type FileCheckRequest } from '../agent-product/src/verification-files.js'
import * as verificationFiles from '../agent-product/src/verification-files.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const request: FileCheckRequest = {
  checkerId: 'source-dates-v1', source: 'reference.json', artifact: 'output.json', key: 'id', field: 'publishedAt',
}
const quote = (value: string) => `'${value}'`
const argsFor = (input = request) => ['--checker', input.checkerId, '--source', input.source,
  '--artifact', input.artifact, '--key', input.key, '--field', input.field]
const repairPrompt = '允许修正本地产物。'
const checkingOnlyPrompts = ['只读核对原始发布时间，不修改文件。', '核对原始发布时间，只报告结果。',
  'Check source publication dates. Read-only; do not fix or modify files.',
  '不要改文件', 'Do not change any files', 'No edits', '只报告结果，不修改文件。']

function userMessage(text: string): HarnessUserMessage {
  return { id: 'current-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

function holdNextLoad(store: EvolutionStore, atLoad = 1) {
  const load = store.load.bind(store)
  const entered = Promise.withResolvers<void>()
  const resumed = Promise.withResolvers<void>()
  let calls = 0
  const spy = vi.spyOn(store, 'load').mockImplementation(async () => {
    if (++calls === atLoad) {
      entered.resolve()
      await resumed.promise
    }
    return load()
  })
  cleanups.push(async () => { resumed.resolve(); spy.mockRestore() })
  return { entered: entered.promise, release: () => resumed.resolve() }
}

async function fixture(kind: 'dates' | 'exit' = 'dates', accept = true, prompt?: string, brainOnly = false) {
  const root = await mkdtemp(join(tmpdir(), 'mse-native-check-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'project')
  await mkdir(cwd)
  const source = [{ id: 'a', publishedAt: null }]
  await writeFile(join(cwd, request.source), JSON.stringify(source))
  await writeFile(join(cwd, request.artifact), JSON.stringify(source))
  const store = new EvolutionStore(join(root, 'state'), { now: () => 1000 })
  const seed = new EvolutionEngine({ store, now: () => 1000 })
  const correction = kind === 'dates'
    ? '采集数据，不要再把未知日期补成今天，必须保留空值，使用原始发布时间。'
    : '之前代码的退出码检查错了，应该检查退出码并运行测试。'
  await seed.observeTurn({ sessionId: 'seed', turnId: 1, projectKey: cwd, prompt: correction })
  await seed.completeTurnPersisted({ sessionId: 'seed', turnId: 1, completed: true, outcome: 'success', occurredAt: 1000 })
  await seed.dispose()
  const ruleId = (await store.load()).rules[0]!.id
  const checker = { executable: process.execPath, cliPath: join(root, 'check-cli.js') }
  const nativeMessage = (text: string): HarnessUserMessage => ({ id: 'native-context', role: 'user',
    content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'missher-evolution' } })
  const adapter = new MseAdapter({ store, now: () => 1000, checker,
    ...(!brainOnly ? { nativeMessage } : {}), repairMessage: nativeMessage,
  })
  cleanups.push(() => adapter.dispose())
  const owner: AgentLike = { id: 'agent-native', options: {}, session: { id: 'native', header: { cwd }, events: [] } }
  const abort = new AbortController()
  const messages: HarnessUserMessage[] = [{ id: 'user-native', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: kind === 'dates' ? `采集数据并核对原始发布时间，保留空值。${prompt ?? repairPrompt}` : '修复代码并检查退出码，运行测试。' }] }]
  const decision = await adapter.preStep({ agent: owner, messages, turn: 1, step: 1, signal: abort.signal },
    async () => ({ kind: 'enter', messages }))
  async function prepare() {
    const prepared = await adapter.prepareBrainRecall({ sessionId: owner.session.id, turnId: 1,
      prompt: messages[0]!.content[0]!.text as string, projectKey: cwd })
    expect(prepared).not.toBeNull()
    return prepared!
  }
  if (brainOnly) {
    expect(decision).toEqual({ kind: 'enter', messages })
    if (accept) {
      const prepared = await prepare()
      expect(adapter.acceptBrainRecall(prepared, prepared.ruleIds)).toBe(true)
    }
  } else {
    expect(decision.kind === 'enter' && decision.messages.some(item => item.id === 'native-context')).toBe(true)
    if (accept) adapter.sessionEvent(owner.session, { type: 'user/message', time: 1010, data: { id: 'native-context' } })
  }
  let sequence = 0
  const command = (input = request) => [checker.executable, checker.cliPath, ...argsFor(input)].map(quote).join(' ')
  function call(name = 'bash', commandText = command(), extra: Partial<ToolExecutionLike> = {}) {
    const callId = `call-${++sequence}`
    owner.session.events.push({ type: 'tool/call', time: 1020, data: { turn: 1, step: 1, callId, name,
      arguments: JSON.stringify({ command: commandText }) } })
    return { agent: owner, callId, rootCallId: callId, name, arguments: { command: commandText }, ...extra }
  }
  async function report(input = request, directory = cwd) { return checkFiles(directory, input) }
  async function check(input = request) {
    const result = await report(input)
    adapter.toolsResult(call('bash', command(input)), value(result))
    return result
  }
  function end(reason = 'completed') {
    adapter.sessionEvent(owner.session, { type: 'turn/end', time: 2000, data: { turn: 1, reason: { kind: reason } } })
  }
  async function counts() { await adapter.drain(); return (await store.load()).rules.find(rule => rule.id === ruleId)?.verificationChecks }
  return { root, cwd, store, adapter, owner, abort, checker, command, call, report, check, end, counts, prepare, ruleId }
}

function value(report: unknown, exitCode: number | null = 0) {
  return { isError: false, value: { kind: 'foreground', exitCode, signal: null, timedOut: false, aborted: false,
    stdout: { text: JSON.stringify(report), truncated: false }, stderr: { text: '', truncated: false } } }
}

async function replacementBatch(f: Awaited<ReturnType<typeof fixture>>) {
  await f.adapter.drain()
  const state = await f.store.load()
  const rule: EvolutionRule = { ...state.rules[0]!, id: 'rule_replacement', constraintIds: ['preserve_unknown_values'] }
  rule.instruction = canonicalRuleInstruction(rule)
  rule.instructionHash = sha256(rule.instruction)
  await f.store.update(state.revision, current => ({ ...current, rules: [...current.rules, rule] }))
  const prepared = await f.prepare()
  expect(prepared.ruleIds).toContain(f.ruleId)
  expect(prepared.ruleIds).toContain(rule.id)
  return { prepared, ruleId: rule.id }
}

describe('native verification receipts', () => {
  test('credits an accepted exact invocation only after independently rereading unchanged local files', async () => {
    const f = await fixture()
    await f.check()
    expect(await f.counts()).toBeUndefined()
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 1, firstPass: 1, attempts: 1 })
    const persisted = JSON.stringify(await f.store.load())
    expect(persisted).not.toContain(f.cwd)
    expect(persisted).not.toContain('publishedAt')
    expect(await readFile(join(f.cwd, request.source), 'utf8')).toBe('[{"id":"a","publishedAt":null}]')
  })

  test('preserves a real failed check and credits repair only after the checker reruns', async () => {
    const f = await fixture()
    await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":"2026-09-07"}]')
    await f.check()
    await f.adapter.drain()
    await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":null}]')
    f.adapter.toolsResult(f.call('write_file', ''), { isError: false })
    await f.check()
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 1, attempts: 2, failedAttempts: 1, repaired: 1, firstPass: 0 })
  })

  test('offers one scoped repair hint on the next native step after a trusted failure', async () => {
    const f = await fixture()
    await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":"2026-09-07"}]')
    await f.check()
    const advance = (step: number) => f.adapter.preStep({ agent: f.owner, messages: [], turn: 1,
      step, signal: f.abort.signal }, async () => ({ kind: 'enter', messages: [] }))
    const next = await advance(2)
    expect(next.kind === 'enter' && next.messages).toHaveLength(1)
    const text = next.kind === 'enter' ? next.messages[0]!.content[0]!.text : ''
    expect(text).toMatch(/授权/u)
    expect(text).toMatch(/一次/u)
    expect(text).toMatch(/重新|重查|再次/u)
    expect(text).not.toContain(f.cwd)
    expect(await advance(3)).toEqual({ kind: 'enter', messages: [] })
    expect(await f.counts()).toBeUndefined()
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 0, failed: 1, repaired: 0 })
  })

  test.each([false, true])('a write before the first failure preserves one hint with drained write=%s', async drained => {
    const f = await fixture()
    await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":"2026-09-07"}]')
    const failed = await f.report()
    f.adapter.toolsResult(f.call('write_file', ''), { isError: false })
    if (drained) await f.adapter.drain()
    f.adapter.toolsResult(f.call(), value(failed))
    const advance = (step: number) => f.adapter.preStep({ agent: f.owner, messages: [], turn: 1, step,
      signal: f.abort.signal }, async () => ({ kind: 'enter', messages: [] }))
    const offered = await advance(2)
    expect(offered.kind === 'enter' && offered.messages).toHaveLength(1)
    const duplicate = await advance(3)
    expect(duplicate.kind === 'enter' && duplicate.messages).toHaveLength(0)
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 0, failed: 1, failedAttempts: 1, attempts: 1, repaired: 0 })
  })

  test.each(['not-accepted', 'cancelled', 'closed', 'changed-source', 'changed-artifact', 'tool-after-check', 'second-check'])
  ('does not offer a repair on %s evidence', async reason => {
    const f = await fixture('dates', reason !== 'not-accepted')
    await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":"2026-09-07"}]')
    await f.check()
    await f.adapter.drain()
    if (reason === 'cancelled') f.abort.abort()
    if (reason === 'closed') f.end()
    if (reason === 'changed-source') await writeFile(join(f.cwd, request.source), '[{"id":"a","publishedAt":"2026-09-06"}]')
    if (reason === 'changed-artifact') await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":null}]')
    if (reason === 'tool-after-check') f.adapter.toolsResult(f.call('write_file', ''), { isError: false })
    if (reason === 'second-check') await f.check()
    const next = await f.adapter.preStep({ agent: f.owner, messages: [], turn: 1, step: 2, signal: f.abort.signal },
      async () => ({ kind: 'enter', messages: [] }))
    expect(next).toEqual({ kind: 'enter', messages: [] })
  })

  test('a rejected native continuation does not consume the one repair hint', async () => {
    const f = await fixture()
    await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":"2026-09-07"}]')
    await f.check()
    const payload = { agent: f.owner, messages: [], turn: 1, step: 2, signal: f.abort.signal }
    expect(await f.adapter.preStep(payload, async () => ({ kind: 'reject' }))).toEqual({ kind: 'reject' })
    const next = await f.adapter.preStep(payload, async () => ({ kind: 'enter', messages: [] }))
    expect(next.kind === 'enter' && next.messages).toHaveLength(1)
  })

  test('concurrent native continuation callbacks cannot offer two repair hints', async () => {
    const f = await fixture()
    await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":"2026-09-07"}]')
    await f.check()
    const payload = { agent: f.owner, messages: [], turn: 1, step: 2, signal: f.abort.signal }
    const first = f.adapter.preStep(payload, async () => ({ kind: 'enter', messages: [] }))
    const second = f.adapter.preStep(payload, async () => ({ kind: 'enter', messages: [] }))
    const a = await first, b = await second
    expect((a.kind === 'enter' ? a.messages.length : 0) + (b.kind === 'enter' ? b.messages.length : 0)).toBe(1)
  })

  test.each([1, 2].flatMap(atLoad => ['user', 'write_file', 'unknown_tool', 'queued-tool', 'second-fail', 'second-pass']
    .map(reason => ({ reason, atLoad }))))
  ('cancels an in-flight repair after $reason while store.load #$atLoad is delayed, without losing real observations', async ({ reason, atLoad }) => {
    const f = await fixture()
    await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":"2026-09-07"}]')
    await f.check()
    await f.adapter.drain()
    const held = holdNextLoad(f.store, atLoad)
    const payload = { agent: f.owner, messages: [], turn: 1, step: 2, signal: f.abort.signal }
    const first = f.adapter.preStep(payload, async () => ({ kind: 'enter', messages: [] }))
    await held.entered
    try {
      if (reason === 'user') {
        const messages = [userMessage('只报告结果，不修改文件。')]
        expect(await f.adapter.preStep({ ...payload, messages }, async () => ({ kind: 'enter', messages })))
          .toEqual({ kind: 'enter', messages })
      } else if (reason === 'second-fail' || reason === 'second-pass') {
        if (reason === 'second-pass') {
          await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":null}]')
          f.adapter.toolsResult(f.call('write_file', ''), { isError: false })
        }
        await f.check()
        await f.adapter.drain()
      } else {
        f.adapter.toolsResult(f.call(reason === 'queued-tool' ? 'unknown_tool' : reason, ''), { isError: false })
        if (reason !== 'queued-tool') await f.adapter.drain()
      }
    } finally { held.release() }
    expect(await first).toEqual({ kind: 'enter', messages: [] })
    expect(await f.adapter.preStep({ ...payload, step: 3 }, async () => ({ kind: 'enter', messages: [] })))
      .toEqual({ kind: 'enter', messages: [] })
    f.end()
    expect(await f.counts()).toMatchObject(reason === 'second-pass'
      ? { passed: 1, attempts: 2, failedAttempts: 1, repaired: 1 }
      : reason === 'second-fail' ? { failed: 1, attempts: 2, failedAttempts: 2, repaired: 0 }
      : { failed: reason === 'user' ? 1 : 0, stale: reason === 'user' ? 0 : 1,
        attempts: 1, failedAttempts: 1, repaired: 0 })
  })

  test.each(checkingOnlyPrompts)
  ('never turns a checking-only task into a repair task: %s', async prompt => {
    const f = await fixture('dates', true, `${repairPrompt}${prompt}`)
    await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":"2026-09-07"}]')
    await f.check()
    const next = await f.adapter.preStep({ agent: f.owner, messages: [], turn: 1, step: 2, signal: f.abort.signal },
      async () => ({ kind: 'enter', messages: [] }))
    expect(next).toEqual({ kind: 'enter', messages: [] })
  })

  test.each(['', '核对来源并说明差异。', '继续处理数据。', '可以检查本地产物。',
    '不允许修正本地产物。', '允许修正本地产物吗？', '示例：允许修正本地产物。',
    '"允许修正本地产物"', '```text\n允许修正本地产物。\n```'])
  ('requires a direct affirmative local correction request, not merely absence of a denial: %s', async prompt => {
    const f = await fixture('dates', true, prompt)
    await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":"2026-09-07"}]')
    await f.check()
    const next = await f.adapter.preStep({ agent: f.owner, messages: [], turn: 1, step: 2, signal: f.abort.signal },
      async () => ({ kind: 'enter', messages: [] }))
    expect(next).toEqual({ kind: 'enter', messages: [] })
    f.end()
    expect(await f.counts()).toMatchObject({ failed: 1, failedAttempts: 1, repaired: 0 })
  })

  test('a plugin-sourced affirmative request cannot authorize local correction', async () => {
    const f = await fixture('dates', true, '')
    await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":"2026-09-07"}]')
    await f.check()
    const messages: HarnessUserMessage[] = [{ ...userMessage(repairPrompt), source: { kind: 'plugin', plugin: 'other' } }]
    expect(await f.adapter.preStep({ agent: f.owner, messages, turn: 1, step: 2, signal: f.abort.signal },
      async () => ({ kind: 'enter', messages }))).toEqual({ kind: 'enter', messages })
  })

  test('disabling learning suppresses a pending repair', async () => {
    const f = await fixture()
    await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":"2026-09-07"}]')
    await f.check()
    await f.adapter.drain()
    const state = await f.store.load()
    await f.store.update(state.revision, current => ({ ...current, enabled: false }))
    const next = await f.adapter.preStep({ agent: f.owner, messages: [], turn: 1, step: 2, signal: f.abort.signal },
      async () => ({ kind: 'enter', messages: [] }))
    expect(next).toEqual({ kind: 'enter', messages: [] })
  })

  test('removing the learned rule suppresses its pending repair hint', async () => {
    const f = await fixture()
    await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":"2026-09-07"}]')
    await f.check()
    await f.adapter.drain()
    const state = await f.store.load()
    await f.store.update(state.revision, current => ({ ...current, rules: [] }))
    const next = await f.adapter.preStep({ agent: f.owner, messages: [], turn: 1, step: 2, signal: f.abort.signal },
      async () => ({ kind: 'enter', messages: [] }))
    expect(next).toEqual({ kind: 'enter', messages: [] })
  })

  test.each(['project', 'instance'] as const)('requires the exact accepted scope when current scope changes to %s', async kind => {
    const f = await fixture()
    await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":"2026-09-07"}]')
    await f.check()
    await f.adapter.drain()
    const state = await f.store.load()
    await f.store.update(state.revision, current => ({ ...current, rules: current.rules.map(rule => ({
      ...rule, scope: { kind, keyHash: kind === 'project' ? '1'.repeat(64) : rule.scope!.keyHash },
    })) }))
    const next = await f.adapter.preStep({ agent: f.owner, messages: [], turn: 1, step: 2, signal: f.abort.signal },
      async () => ({ kind: 'enter', messages: [] }))
    expect(next).toEqual({ kind: 'enter', messages: [] })
  })

  test('a scope-less accepted snapshot remains check-only even when the current stored rule has scope', async () => {
    const f = await fixture('dates', false, repairPrompt, true)
    const prepared = await f.prepare()
    const legacy = { ...prepared, rules: prepared.rules.map(({ scope: _scope, ...rule }) => Object.freeze(rule)) }
    const accept = EvolutionEngine.prototype.acceptInjection
    // Simulate only an older SDK's missing optional snapshot field; keep real registry acceptance.
    const spy = vi.spyOn(EvolutionEngine.prototype, 'acceptInjection').mockImplementationOnce(function (this: EvolutionEngine, input, ids) {
      expect(input).toBe(legacy)
      return accept.call(this, prepared, ids)
    })
    try { expect(f.adapter.acceptBrainRecall(legacy, legacy.ruleIds)).toBe(true) }
    finally { spy.mockRestore() }
    await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":"2026-09-07"}]')
    await f.check()
    expect(await f.adapter.preStep({ agent: f.owner, messages: [], turn: 1, step: 2, signal: f.abort.signal },
      async () => ({ kind: 'enter', messages: [] }))).toEqual({ kind: 'enter', messages: [] })
    f.end()
    expect(await f.counts()).toMatchObject({ failed: 1, failedAttempts: 1, repaired: 0 })
  })

  test.each([false, true])('replaces Brain-only active plans and cancels old hints (in-flight=%s)', async inFlight => {
    const f = await fixture('dates', true, repairPrompt, true)
    await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":"2026-09-07"}]')
    await f.check()
    await f.adapter.drain()
    const { prepared: replacement, ruleId: replacementId } = await replacementBatch(f)
    const payload = { agent: f.owner, messages: [], turn: 1, step: 2, signal: f.abort.signal }
    const held = inFlight ? holdNextLoad(f.store) : undefined
    const first = inFlight ? f.adapter.preStep(payload, async () => ({ kind: 'enter', messages: [] })) : undefined
    if (held) await held.entered
    try { expect(f.adapter.acceptBrainRecall(replacement, [replacementId])).toBe(true) }
    finally { held?.release() }
    const next = first ? await first : await f.adapter.preStep(payload, async () => ({ kind: 'enter', messages: [] }))
    expect(next).toEqual({ kind: 'enter', messages: [] })
    f.end()
    expect(await f.counts()).toBeUndefined()
    expect((await f.store.load()).rules.find(rule => rule.id === replacementId)?.verificationChecks)
      .toMatchObject({ attempts: 0, repaired: 0 })
  })

  test('a Brain-only replacement also removes inactive checker file-read eligibility', async () => {
    const f = await fixture('dates', true, repairPrompt, true)
    const { prepared: replacement, ruleId: replacementId } = await replacementBatch(f)
    expect(f.adapter.acceptBrainRecall(replacement, [replacementId])).toBe(true)
    await f.adapter.drain()
    const report = await f.report()
    const reread = vi.spyOn(verificationFiles, 'checkFiles')
    try {
      f.adapter.toolsResult(f.call(), value(report))
      await f.adapter.drain()
      expect(reread).not.toHaveBeenCalled()
    } finally { reread.mockRestore() }
  })

  test('reaccepting the same Brain-only plan invalidates its old hint without resetting check attempts', async () => {
    const f = await fixture('dates', true, repairPrompt, true)
    await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":"2026-09-07"}]')
    await f.check()
    await f.adapter.drain()
    const replacement = await f.prepare()
    expect(f.adapter.acceptBrainRecall(replacement, replacement.ruleIds)).toBe(true)
    const payload = { agent: f.owner, messages: [], turn: 1, step: 2, signal: f.abort.signal }
    expect(await f.adapter.preStep(payload, async () => ({ kind: 'enter', messages: [] })))
      .toEqual({ kind: 'enter', messages: [] })
    await f.check()
    expect(await f.adapter.preStep({ ...payload, step: 3 }, async () => ({ kind: 'enter', messages: [] })))
      .toEqual({ kind: 'enter', messages: [] })
    f.end()
    expect(await f.counts()).toMatchObject({ attempts: 2, failedAttempts: 2, repaired: 0 })
  })

  test.each(checkingOnlyPrompts)('a later read-only user message overrides a pending repair hint: %s', async prompt => {
    const f = await fixture()
    await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":"2026-09-07"}]')
    await f.check()
    const messages = [userMessage(prompt)]
    const next = await f.adapter.preStep({ agent: f.owner, messages, turn: 1, step: 2, signal: f.abort.signal },
      async () => ({ kind: 'enter', messages }))
    expect(next).toEqual({ kind: 'enter', messages })
  })

  test.each([false, true])('settles a negative finding only against actual final revisions (changed=%s)', async changed => {
    const f = await fixture()
    await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":"2026-09-07"}]')
    await f.check()
    await f.adapter.drain()
    if (changed) await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":null}]')
    f.end()
    expect(await f.counts()).toMatchObject({ failed: changed ? 0 : 1, stale: changed ? 1 : 0, passed: 0, attempts: 1, failedAttempts: 1 })
  })

  test('a trusted native read keeps the checker observation valid', async () => {
    const f = await fixture()
    await f.check()
    f.adapter.toolsResult(f.call('read', ''), { isError: false })
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 1, attempts: 1 })
  })

  test('uses the executed workdir and never the prompt or a claimed stdout cwd', async () => {
    const f = await fixture()
    const subdir = join(f.cwd, 'data')
    await mkdir(subdir)
    await writeFile(join(subdir, request.source), '[{"id":"a","publishedAt":"2026-08-01"}]')
    await writeFile(join(subdir, request.artifact), '[{"id":"a","publishedAt":"2026-08-01"}]')
    f.adapter.toolsResult(f.call('bash', f.command(), { arguments: { command: f.command(), workdir: 'data' } }), value(await f.report(request, subdir)))
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 1, attempts: 1 })
  })

  test('caps a third check instead of silently reusing the earlier pass', async () => {
    const f = await fixture()
    for (let attempt = 0; attempt < 3; attempt += 1) { await f.check(); await f.adapter.drain() }
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 0, attempts: 2, insufficient: 2 })
  })

  test('a different projected field cannot reuse the first binding', async () => {
    const f = await fixture()
    const rows = '[{"id":"a","publishedAt":null,"otherDate":null}]'
    await writeFile(join(f.cwd, request.source), rows)
    await writeFile(join(f.cwd, request.artifact), rows)
    await f.check()
    await f.adapter.drain()
    await f.check({ ...request, field: 'otherDate' })
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 0, stale: 1, attempts: 1 })
  })

  test('a rejected replacement binding cancels the old failure hint even when its files are unchanged', async () => {
    const f = await fixture()
    const replacement = { ...request, source: 'replacement-reference.json', artifact: 'replacement-output.json' }
    await writeFile(join(f.cwd, replacement.source), '[{"id":"b","publishedAt":null}]')
    await writeFile(join(f.cwd, replacement.artifact), '[{"id":"b","publishedAt":null}]')
    await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":"2026-09-07"}]')
    const original = await f.check()
    await f.adapter.drain()
    const replaced = await f.check(replacement)
    await f.adapter.drain()
    expect(replaced.sourceHash).not.toBe(original.sourceHash)
    expect(replaced.bindingHash).not.toBe(original.bindingHash)
    expect(await f.report()).toEqual(original)
    const next = await f.adapter.preStep({ agent: f.owner, messages: [], turn: 1, step: 2, signal: f.abort.signal },
      async () => ({ kind: 'enter', messages: [] }))
    expect(next).toEqual({ kind: 'enter', messages: [] })
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 0, failed: 0, stale: 1, attempts: 1, failedAttempts: 1, repaired: 0 })
  })

  test.each(['artifact', 'source', 'cwd'] as const)('rejects a changed %s path under an existing source binding', async changed => {
    const f = await fixture()
    const first = await f.check()
    await f.adapter.drain()
    const other = changed === 'cwd' ? join(f.cwd, 'other') : f.cwd
    if (changed === 'cwd') await mkdir(other)
    const next = { ...request,
      source: changed === 'source' ? 'other-reference.json' : request.source,
      artifact: changed === 'artifact' ? 'other-output.json' : request.artifact }
    const rows = '[{"id":"a","publishedAt":null}]'
    await writeFile(join(other, next.source), rows)
    await writeFile(join(other, next.artifact), rows)
    const nextReport = await f.report(next, other)
    expect(nextReport.bindingHash).toBe(first.bindingHash)
    f.adapter.toolsResult(f.call('bash', f.command(next), { arguments: { command: f.command(next), workdir: other } }), value(nextReport))
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 0, stale: 1, attempts: 1, firstPass: 0 })
  })

  test('deduplicates closed checker callbacks before asynchronous observations enter the queue', async () => {
    const f = await fixture()
    const exec = f.call()
    const result = value(await f.report())
    for (let repeat = 0; repeat < 3; repeat += 1) f.adapter.toolsResult(exec, result)
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 1, attempts: 1, firstPass: 1 })
  })

  test('a duplicate closed checker callback cannot reset a later invalidation', async () => {
    const f = await fixture()
    const exec = f.call()
    const result = value(await f.report())
    f.adapter.toolsResult(exec, result)
    await f.adapter.drain()
    f.adapter.toolsResult(f.call('write', ''), { isError: false })
    f.adapter.toolsResult(exec, result)
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 0, stale: 1, attempts: 1 })
  })

  test('executes the standalone read-only CLI with real files and real process exit codes', async () => {
    const f = await fixture()
    const { build } = await import('tsdown')
    await build({ config: false, entry: { 'check-cli': fileURLToPath(new URL('../src/check-cli.ts', import.meta.url)) },
      outDir: f.root, format: 'esm', platform: 'node', target: 'es2024', dts: false, clean: false,
      fixedExtension: false, deps: { alwaysBundle: ['zod'], onlyBundle: ['zod'] }, logLevel: 'silent' })
    const run = promisify(execFile)
    const { stdout } = await run(process.execPath, [f.checker.cliPath, ...argsFor()], { cwd: f.cwd, timeout: 5000 })
    expect(JSON.parse(stdout)).toMatchObject({ status: 'pass', reason: 'matched', checked: 1 })
    f.adapter.toolsResult(f.call(), value(JSON.parse(stdout)))
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 1, attempts: 1 })
    await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":"2026-09-07"}]')
    const negative = await run(process.execPath, [f.checker.cliPath, ...argsFor()], { cwd: f.cwd, timeout: 5000 })
    expect(JSON.parse(negative.stdout)).toMatchObject({ status: 'fail', reason: 'source_value_changed', violations: 1 })
    await expect(run(process.execPath, [f.checker.cliPath, ...argsFor({ ...request, source: '../reference.json' })],
      { cwd: f.cwd, timeout: 5000 })).rejects.toMatchObject({ code: 2 })
    expect(await readFile(join(f.cwd, request.source), 'utf8')).toBe('[{"id":"a","publishedAt":null}]')
  }, 20_000)

  test.each(['source', 'artifact'] as const)('marks an externally changed %s stale at actual turn end', async file => {
    const f = await fixture()
    await f.check()
    await f.adapter.drain()
    await writeFile(join(f.cwd, request[file]), '[{"id":"a","publishedAt":"2026-09-07"}]')
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 0, stale: 1, attempts: 1 })
  })

  test.each(['write_file', 'unknown_tool', 'bash'])('invalidates a prior report after %s even when bytes are unchanged', async name => {
    const f = await fixture()
    await f.check()
    f.adapter.toolsResult(f.call(name, 'true'), { isError: false, value: { exitCode: 0 } })
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 0, stale: 1, attempts: 1 })
  })

  test('ordinary tests cannot prove dates or produce targeted regression evidence', async () => {
    const f = await fixture()
    f.adapter.toolsResult(f.call('bash', 'npm test'), value(await f.report()))
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 0, attempts: 0 })
  })

  test('does not credit an unaccepted native reminder', async () => {
    const f = await fixture('dates', false)
    await f.check()
    f.end()
    expect(await f.counts()).toBeUndefined()
  })

  test.each(['abort-signal', 'aborted-end', 'dispose-session'])('never credits capture cancellation via %s', async reason => {
    const f = await fixture()
    await f.check()
    if (reason === 'abort-signal') f.abort.abort()
    if (reason === 'dispose-session') f.adapter.sessionDisposed(f.owner.session)
    else f.end(reason === 'aborted-end' ? 'aborted' : 'completed')
    expect((await f.counts())?.passed ?? 0).toBe(0)
  })

  test.each([1, null])('does not accept a checker without a real zero exit (%s)', async code => {
    const f = await fixture()
    f.adapter.toolsResult(f.call(), value(await f.report(), code))
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 0, attempts: 0 })
  })

  test('rejects forged pass stdout with genuine hashes but false counts/status', async () => {
    const f = await fixture()
    await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":"2026-09-07"}]')
    const failed = await f.report()
    f.adapter.toolsResult(f.call(), value({ ...failed, status: 'pass', reason: 'matched', violations: 0 }))
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 0, attempts: 0 })
  })

  test('rejects a stdout snapshot that does not match the current files', async () => {
    const f = await fixture()
    const pass = await f.report()
    await writeFile(join(f.cwd, request.artifact), '[{"id":"a","publishedAt":"2026-09-07"}]')
    f.adapter.toolsResult(f.call(), value(pass))
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 0, attempts: 0 })
  })

  test.each(['truncated', 'extra-fields', 'invalid-json', 'aborted-tool', 'timeout', 'background'])('rejects %s output', async kind => {
    const f = await fixture()
    const result = value(await f.report())
    if (kind === 'truncated') result.value.stdout.truncated = true
    if (kind === 'extra-fields') result.value.stdout.text = JSON.stringify({ ...await f.report(), privatePath: f.cwd })
    if (kind === 'invalid-json') result.value.stdout.text += 'trailing text'
    if (kind === 'aborted-tool') result.value.aborted = true
    if (kind === 'timeout') result.value.timedOut = true
    if (kind === 'background') result.value.kind = 'background'
    f.adapter.toolsResult(f.call(), result)
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 0, attempts: 0 })
  })

  test('disposal drains queued file observation and end completion before disposing the engine', async () => {
    const f = await fixture()
    await f.check()
    f.end()
    await f.adapter.dispose()
    expect(await f.counts()).toMatchObject({ passed: 1, attempts: 1 })
  })
})

describe('native terminal identity and exit aggregation', () => {
  test('deduplicates closed terminal call IDs without merging distinct nested calls under one root', async () => {
    const f = await fixture('exit')
    const root = f.call('run_code', 'tools.bash(...)')
    const first = { agent: f.owner, name: 'bash', callId: 'child-a', rootCallId: root.callId,
      parent: Symbol('host-token'), arguments: { command: 'npm test' } }
    const second = { ...first, callId: 'child-b' }
    f.adapter.toolsResult(first, value({}, 1))
    f.adapter.toolsResult(first, value({}, 1))
    f.adapter.toolsResult(second, value({}, 0))
    f.adapter.toolsResult(second, value({}, 0))
    await f.adapter.drain()
    const snapshot = f.adapter.registry.claimCapture(f.owner.session.id, 1)
    expect(snapshot?.exitCodes).toEqual([1, 0])
    expect(snapshot?.failedToolCount).toBe(1)
    expect(snapshot?.successfulToolCount).toBe(1)
  })

  test('closed call ID deduplication is scoped to the turn', async () => {
    const f = await fixture('exit')
    const exec = f.call('bash', 'true')
    f.adapter.toolsResult(exec, value({}))
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 1, attempts: 1 })
    const messages: HarnessUserMessage[] = [{ id: 'user-two', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '修复代码并检查退出码，运行测试。' }] }]
    await f.adapter.preStep({ agent: f.owner, messages, turn: 2, step: 1, signal: f.abort.signal }, async () => ({ kind: 'enter', messages }))
    f.adapter.sessionEvent(f.owner.session, { type: 'user/message', time: 2010, data: { id: 'native-context' } })
    f.owner.session.events.push({ type: 'tool/call', time: 2020, data: { turn: 2, callId: exec.callId, name: 'bash' } })
    f.adapter.toolsResult(exec, value({}))
    f.adapter.sessionEvent(f.owner.session, { type: 'turn/end', time: 2100, data: { turn: 2, reason: { kind: 'completed' } } })
    expect(await f.counts()).toMatchObject({ passed: 2, attempts: 2 })
  })

  test('stops credit when bounded closed-call identity capacity is exhausted', async () => {
    const f = await fixture('exit')
    const root = f.call('run_code', 'tools.bash(...)')
    const parent = Symbol('host-token')
    for (let index = 0; index <= 1000; index += 1) {
      f.adapter.toolsResult({ agent: f.owner, name: 'bash', callId: `child-${index}`, rootCallId: root.callId,
        parent, arguments: { command: 'true' } }, value({}))
    }
    f.end()
    expect(await f.counts()).toBeUndefined()
  })

  test('an unresolved background command cannot be hidden by an earlier zero', async () => {
    const f = await fixture('exit')
    f.adapter.toolsResult(f.call('bash', 'npm test'), value({}))
    f.adapter.toolsResult(f.call('bash', 'npm test', { arguments: { command: 'npm test', run_in_background: true } }),
      { isError: false, value: { kind: 'background', jobId: 'job-a' } })
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 0, insufficient: 1 })
  })

  test('a nested nonzero exit is still a failure when a later root command succeeds', async () => {
    const f = await fixture('exit')
    const root = f.call('run_code', 'tools.bash(...)')
    f.adapter.toolsResult({ agent: f.owner, name: 'bash', callId: 'nested-exit', rootCallId: root.callId,
      parent: Symbol('host-token'), arguments: { command: 'npm test' } }, value({}, 1))
    f.adapter.toolsResult(f.call('bash', 'true'), value({}))
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 0, failed: 1, attempts: 1 })
  })

  test('a later unclassified root transport invalidates nested file evidence too', async () => {
    const f = await fixture()
    const root = f.call('run_code', 'tools.bash(...)')
    f.adapter.toolsResult({ agent: f.owner, name: 'bash', callId: 'child', rootCallId: root.callId,
      parent: Symbol('host-token'), arguments: { command: f.command() } }, value(await f.report()))
    f.adapter.toolsResult(root, { isError: false, value: {} })
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 0, stale: 1, attempts: 1 })
  })
  test.each([{ codes: [0], passed: 1, failed: 0, insufficient: 0 },
    { codes: [1, 0], passed: 0, failed: 1, insufficient: 0 },
    { codes: [null, 0], passed: 0, failed: 0, insufficient: 1 }])('settles all real Bash exits: $codes', async row => {
    const f = await fixture('exit')
    for (const code of row.codes) f.adapter.toolsResult(f.call('bash', 'npm test'), value({}, code))
    f.end()
    expect(await f.counts()).toMatchObject({ passed: row.passed, failed: row.failed, insufficient: row.insufficient, attempts: 1 })
  })

  test('binds a nested Bash receipt to the trusted same-agent root session event', async () => {
    const f = await fixture()
    const root = f.call('run_code', 'tools.bash(...)')
    f.adapter.toolsResult({ agent: f.owner, name: 'bash', callId: 'child', rootCallId: root.callId,
      parent: Symbol('host-token'), arguments: { command: f.command() } }, value(await f.report()))
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 1, attempts: 1 })
  })

  test.each(['missing-root', 'wrong-agent', 'wrong-session', 'subagent', 'fake-parent'])('ignores an unbound nested receipt: %s', async kind => {
    const f = await fixture()
    const root = f.call('run_code', 'tools.bash(...)')
    let owner = f.owner
    if (kind === 'wrong-agent') owner = { ...f.owner, id: 'other-agent' }
    if (kind === 'wrong-session') owner = { ...f.owner, session: { ...f.owner.session, id: 'other-session' } }
    if (kind === 'subagent') owner = { ...f.owner, session: { ...f.owner.session, header: { cwd: f.cwd, origin: 'subagent' } } }
    f.adapter.toolsResult({ agent: owner, name: 'bash', callId: 'child', rootCallId: kind === 'missing-root' ? 'absent' : root.callId,
      parent: kind === 'fake-parent' ? {} : Symbol('host-token'), arguments: { command: f.command() } }, value(await f.report()))
    f.end()
    expect(await f.counts()).toMatchObject({ passed: 0, attempts: 0 })
  })
})

describe('exact registered checker command', () => {
  const registration = { executable: '/runtime/Node Bin/node', cliPath: '/plugins/MSE/lib/check-cli.js' }
  const command = [registration.executable, registration.cliPath, ...argsFor()].map(quote).join(' ')
  test('accepts exactly ten CLI arguments and only the fixed Electron environment prefix', () => {
    expect(parseNativeCheckerCommand(command, registration)).toEqual(request)
    expect(parseNativeCheckerCommand(`ELECTRON_RUN_AS_NODE=1 ${command}`, { ...registration, electron: true })).toEqual(request)
    expect(parseNativeCheckerCommand(command, { ...registration, electron: true })).toBeNull()
  })
  test.each([
    (cmd: string) => `env ${cmd}`,
    (cmd: string) => `NODE_OPTIONS=--require=evil ${cmd}`,
    (cmd: string) => `ELECTRON_RUN_AS_NODE=1 env ${cmd}`,
    (cmd: string) => `${cmd}; true`,
    (cmd: string) => `${cmd} && true`,
    (cmd: string) => `${cmd} | cat`,
    (cmd: string) => `${cmd} > output.json`,
    (cmd: string) => `${cmd}\ntrue`,
    (cmd: string) => cmd.replace("' '--checker'", "'\n'--checker'"),
    (cmd: string) => `${cmd} --extra x`,
    (cmd: string) => cmd.replace(registration.executable, 'node'),
    (cmd: string) => cmd.replace(registration.cliPath, '/tmp/check-cli.js'),
  ])('rejects wrappers, expansions, extra argv and compound commands (%#)', transform => {
    expect(parseNativeCheckerCommand(transform(command), registration)).toBeNull()
  })
})
