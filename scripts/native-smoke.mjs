#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyPackage } from './verify-package.mjs'

const pluginRoot = resolve(import.meta.dirname, '..')
const pluginVersion = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8')).version
const PACKAGE_NAME = 'dsh-missher-evolution'
const PLUGIN_NAME = 'missher-evolution'
const RAW_PROMPT = '小红书发布时间缺失时不要写成今天，必须保持未知并核对原始来源字段。'
const PROJECT_KEY = 'native-media-project'

async function main() {
  let temporaryHome
  let stage = 'verify'
  try {
    const options = parseArgs(process.argv.slice(2))
    assertCurrentPlatform(options.platform)
    await verifyPackage(options.archive)
    temporaryHome = await mkdtemp(join(tmpdir(), 'dsh-mse-native-'))
    const profileDir = join(temporaryHome, 'profiles', options.profile)
    const adjacentFile = join(profileDir, 'adjacent-data.keep')
    let pluginEntry = join(pluginRoot, 'lib', 'index.js')
    let profileInstall = false

    if (options.cli !== undefined) {
      stage = 'install'
      runCli(options.cli, temporaryHome, [
        'plugin', '--profile', options.profile, 'add', options.archive,
      ], options.runtime)
      stage = 'composition'
      const dump = runCli(options.cli, temporaryHome, [
        '--profile', options.profile, '--dump-config',
      ], options.runtime)
      if (!dump.includes(PACKAGE_NAME) || !dump.includes(PLUGIN_NAME)) {
        throw new Error('profile_composition_invalid')
      }
      pluginEntry = join(profileDir, 'node_modules', PACKAGE_NAME, 'lib', 'index.js')
      await access(pluginEntry)
      // Use the same installation dependency projection as a real host boot.
      const hostRequire = createRequire(options.cli)
      const boot = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-app-boot')).href)
      if (typeof boot.healProfilesModuleFallback === 'function') {
        stage = 'host-dependencies'
        await boot.healProfilesModuleFallback(resolve(dirname(options.cli), '../package.json'), temporaryHome)
      }
      profileInstall = true
    } else {
      const marker = join(profileDir, 'node_modules', PACKAGE_NAME)
      await mkdir(marker, { recursive: true })
      profileInstall = false
    }
    await mkdir(dirname(adjacentFile), { recursive: true })
    await writeFile(adjacentFile, 'preserve\n', 'utf8')

    stage = 'load-runtime'
    const runtime = await loadRuntime(pluginEntry)
    stage = 'native-lifecycle'
    const nativeAdapter = await nativeLifecycleSmoke(runtime, join(temporaryHome, 'native-adapter'))
    stage = 'correction-recall'
    const correctionRecall = await correctionRecallSmoke(runtime, join(temporaryHome, 'correction-adapter'))
    stage = 'verification-repair'
    const verificationRepair = await verificationRepairSmoke(runtime, join(temporaryHome, 'verification-adapter'))
    stage = 'brain-lifecycle'
    const first = await mount(runtime, temporaryHome)
    await waitForMaintenance(first.remote)
    const startedAt = Date.now()
    for (let index = 0; index < 3; index += 1) {
      await completedProjectTurn(
        first.adapter,
        first.brainProvider,
        `native-learn-${index}`,
        startedAt + index * 10,
        'success',
      )
    }
    for (let index = 0; index < 100; index += 1) {
      const snapshot = await first.remote.snapshot()
      if (snapshot.counters.active >= 1) break
      await completedProjectTurn(
        first.adapter,
        first.brainProvider,
        `native-trial-${index}`,
        startedAt + 100 + index * 10,
        'causal',
      )
    }
    const learned = await first.remote.snapshot()
    const capture = learned.counters.captures >= 8 && learned.counters.active >= 1
    await first.dispose()

    const reopened = await mount(runtime, temporaryHome)
    await reopened.adapter.preStep({
      agent: agent('native-restart'),
      messages: [user(RAW_PROMPT)],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages: [user(RAW_PROMPT)] }))
    const recalled = await reopened.brainProvider.prepare({
      projectKey: PROJECT_KEY,
      sessionId: 'native-restart',
      turn: 1,
      query: RAW_PROMPT,
      signal: new AbortController().signal,
    })
    const acceptedHandles = recalled.items.map(item => item.handle)
    const injection = recalled.items.some(item =>
      item.providerId === 'evolution' && item.kind === 'learned-rule')
    if (acceptedHandles.length > 0) await recalled.accept(acceptedHandles)
    else await recalled.cancel()
    const restart = (await reopened.remote.snapshot()).counters.active >= 1
    await reopened.dispose()

    const persisted = await readFile(join(temporaryHome, PLUGIN_NAME, 'state.json'), 'utf8')
    if (persisted.includes(RAW_PROMPT) || persisted.includes(temporaryHome)) {
      throw new Error('durable_privacy_violation')
    }

    if (options.cli !== undefined) {
      stage = 'uninstall'
      runCli(options.cli, temporaryHome, [
        'plugin', '--profile', options.profile, 'remove', PACKAGE_NAME,
      ], options.runtime)
      const dump = runCli(options.cli, temporaryHome, [
        '--profile', options.profile, '--dump-config',
      ], options.runtime)
      if (dump.includes(PACKAGE_NAME)) throw new Error('profile_uninstall_invalid')
    } else {
      await rm(join(profileDir, 'node_modules', PACKAGE_NAME), { recursive: true, force: true })
    }
    const uninstall = !await exists(join(profileDir, 'node_modules', PACKAGE_NAME))
    const adjacentDataPreserved = await exists(adjacentFile)
    const statePreserved = await exists(join(temporaryHome, PLUGIN_NAME, 'state.json'))
    const result = {
      ok: nativeAdapter.ok && correctionRecall.ok && verificationRepair.ok && (options.cli === undefined || profileInstall) && capture && restart && injection && uninstall
        && adjacentDataPreserved && statePreserved,
      platform: process.platform,
      arch: process.arch,
      profileInstall,
      capture,
      captures: learned.counters.captures,
      restart,
      injection,
      uninstall,
      adjacentDataPreserved,
      statePreserved,
      nativeAdapter,
      correctionRecall,
      verificationRepair,
      lifecycleEvidence: 'controlled-adapter-events',
    }
    if (!result.ok) throw Object.assign(new Error('acceptance_incomplete'), { diagnostic: result })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    const reason = /^[a-zA-Z_]{1,80}$/u.test(error?.code ?? '') ? error.code
      : /^[a-z_]{1,80}$/u.test(error?.message ?? '') ? error.message : 'runtime_error'
    const missingPackage = error?.message?.match(/Cannot find (?:package|module) ['"](@[a-z0-9-]+\/[a-z0-9-]+|zod)['"]/iu)?.[1]
    process.stderr.write(`${JSON.stringify({ ok: false, code: 'native_smoke_failed', stage, reason, missingPackage, ...(error?.diagnostic === undefined ? {} : { diagnostic: error.diagnostic }) })}\n`)
    process.exitCode = 1
  } finally {
    if (temporaryHome !== undefined) {
      await rm(temporaryHome, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

function parseArgs(args) {
  const options = {
    platform: 'current',
    archive: join(pluginRoot, 'dist', `dsh-missher-evolution-${pluginVersion}.tgz`),
    cli: undefined,
    runtime: undefined,
    profile: 'mse-smoke',
  }
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]
    const value = args[index + 1]
    if (!['--platform', '--archive', '--cli', '--runtime', '--profile'].includes(key) || value === undefined) {
      throw new Error('arguments_invalid')
    }
    if (key === '--platform') options.platform = value
    if (key === '--archive') options.archive = resolve(value)
    if (key === '--cli') options.cli = resolve(value)
    if (key === '--runtime') options.runtime = resolve(value)
    if (key === '--profile') options.profile = value
    index += 1
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(options.profile)) throw new Error('profile_invalid')
  return options
}

function assertCurrentPlatform(requested) {
  const current = `${process.platform}-${process.arch}`
  const supported = new Set(['darwin-x64', 'darwin-arm64', 'win32-x64'])
  if (!supported.has(current) || (requested !== 'current' && requested !== current)) {
    throw new Error('platform_unsupported')
  }
}

function runCli(cli, home, args, runtime) {
  const packagedRuntime = runtime !== undefined
  const result = spawnSync(runtime ?? process.execPath, [
    ...(packagedRuntime ? ['--expose-internals'] : []),
    cli,
    ...args,
  ], {
    cwd: pluginRoot,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
      ...(packagedRuntime ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    throw Object.assign(new Error('harness_cli_failed'), { diagnostic: {
      exitCode: result.status,
      signal: result.signal,
      errorCode: output.match(/\bERR_[A-Z_]+\b/u)?.[0] ?? result.error?.code ?? null,
      missingPackage: output.match(/Cannot find (?:package|module) ['"](@[a-z0-9-]+\/[a-z0-9-]+)['"]/iu)?.[1] ?? null,
    } })
  }
  return result.stdout
}

async function loadRuntime(pluginEntry) {
  pluginEntry = await realpath(pluginEntry)
  const plugin = (await import(pathToFileURL(pluginEntry).href)).default
  const require = createRequire(pluginEntry)
  const cordisEntry = require.resolve('@deepseek-ai/cordis')
  const { Context } = await import(pathToFileURL(cordisEntry).href)
  return { Context, plugin, checkerPath: join(dirname(pluginEntry), 'check-cli.js') }
}

async function mount(runtime, dshHome, withBrain = true) {
  const ctx = new runtime.Context()
  let brainProvider
  ctx.provide('agents', {})
  ctx.provide('tools', {})
  ctx.provide('dshHomePath', (...segments) => join(dshHome, ...segments))
  ctx.provide('llm', {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  if (withBrain) ctx.provide('missherBrain', {
    register(provider) {
      brainProvider = provider
      return () => { brainProvider = undefined }
    },
  })
  const fiber = ctx.plugin(runtime.plugin, {
    enabled: true,
    maintenanceIntervalHours: 24,
    maxInjectedRules: 4,
  })
  await fiber.await()
  if (withBrain && brainProvider === undefined) throw new Error('brain_provider_missing')
  return {
    adapter: ctx.missherEvolutionCore,
    brainProvider,
    remote: ctx.missherEvolution,
    async dispose() {
      await fiber.dispose()
      await ctx.fiber.dispose()
    },
  }
}

async function nativeLifecycleSmoke(runtime, home) {
  const mounted = await mount(runtime, home, false)
  await waitForMaintenance(mounted.remote)
  const run = async (target, index, causal = false) => {
    const events = []
    const owner = agent(`native-compat-${index}`)
    owner.session = { id: owner.session.id, header: { cwd: join(home, 'project') },
      get seq() { return events.length }, eventAt: index => events[index] }
    const prompt = user(RAW_PROMPT)
    const decision = await target.adapter.preStep({ agent: owner, messages: [prompt], turn: 1, step: 1,
      signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [prompt] }))
    const treatment = decision.messages.some(message => message.source.plugin === 'missher-evolution')
    for (const message of decision.messages) target.adapter.sessionEvent(owner.session, { type: 'user/message', time: Date.now(), data: message })
    events.push({ type: 'tool/call', time: Date.now(), data: { turn: 1, callId: 'call', name: 'browser' } })
    target.adapter.toolsResult({ agent: owner, callId: 'call', name: 'browser' }, { isError: false })
    target.adapter.sessionEvent(owner.session, { type: 'turn/end', time: Date.now(), data: {
      turn: 1, reason: { kind: causal && !treatment ? 'error' : 'completed' },
    } })
    await target.adapter.drain()
    return treatment
  }
  let learned
  try {
    for (let i = 0; i < 3; i++) await run(mounted, i)
    for (let i = 3; i < 103; i++) {
      if ((await mounted.remote.snapshot()).counters.active > 0) break
      await run(mounted, i, true)
    }
    learned = await mounted.remote.snapshot()
  } finally { await mounted.dispose() }
  const reopened = await mount(runtime, home, false)
  let recalled
  try { recalled = await run(reopened, 'restart') }
  finally { await reopened.dispose() }
  return { ok: learned.counters.active > 0 && recalled, captures: learned.counters.captures, restartInjection: recalled, brainRequired: false }
}

async function waitForMaintenance(remote) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await remote.snapshot()).counters.maintenanceRuns >= 1) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('maintenance_timeout')
}

async function correctionRecallSmoke(runtime, home) {
  const first = await mount(runtime, home)
  try {
    await waitForMaintenance(first.remote)
    await completedProjectTurn(first.adapter, first.brainProvider, 'correction-source', Date.now(), 'success',
      '之前时区代码错了，应该用明确的 IANA 时区并运行测试核对。')
  } finally { await first.dispose() }
  const second = await mount(runtime, home)
  try {
    const recalled = await completedProjectTurn(second.adapter, second.brainProvider, 'correction-reuse', Date.now(), 'success',
      '检查代码的时区解析。')
    const snapshot = await second.remote.snapshot()
    return { ok: recalled && snapshot.counters.guardrail === 1 && snapshot.counters.active === 0
      && snapshot.diagnostics.correctionUses === 1 && snapshot.diagnostics.inconclusiveCorrectionReuses === 1,
    restartRecall: recalled, reminders: snapshot.counters.guardrail,
    verifiedReuses: snapshot.diagnostics.verifiedCorrectionReuses,
    inconclusive: snapshot.diagnostics.inconclusiveCorrectionReuses }
  } finally { await second.dispose() }
}

async function verificationRepairSmoke(runtime, home) {
  const mounted = await mount(runtime, home, false)
  const cwd = join(home, 'project')
  await mkdir(cwd, { recursive: true })
  const source = '[{"id":"a","publishedAt":null,"other":"preserved"}]'
  await writeFile(join(cwd, 'reference.json'), source)
  await writeFile(join(cwd, 'output.json'), '[{"id":"a","publishedAt":"2026-09-08","other":"preserved"}]')
  const signal = new AbortController().signal
  const start = async (id, text) => {
    const owner = agent(id)
    owner.session.header.cwd = cwd
    const messages = [user(text)]
    const decision = await mounted.adapter.preStep({ agent: owner, messages, turn: 1, step: 1, signal },
      async () => ({ kind: 'enter', messages }))
    for (const message of decision.messages) {
      mounted.adapter.sessionEvent(owner.session, { type: 'user/message', time: Date.now(), data: message })
    }
    return owner
  }
  const finish = async owner => {
    mounted.adapter.sessionEvent(owner.session, { type: 'turn/end', time: Date.now(),
      data: { turn: 1, reason: { kind: 'completed' } } })
    await mounted.adapter.drain()
  }
  try {
    await waitForMaintenance(mounted.remote)
    await finish(await start('verification-seed',
      '采集数据时不要再把未知日期补成今天，必须保留空值，使用原始发布时间。'))
    const owner = await start('verification-repair',
      '采集数据并核对原始发布时间，保留空值。允许修正本地产物。')
    const args = [runtime.checkerPath, '--checker', 'source-dates-v1', '--source', 'reference.json',
      '--artifact', 'output.json', '--key', 'id', '--field', 'publishedAt']
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`
    const command = [process.execPath, ...args].map(quote).join(' ')
    let actualCheckerExecutions = 0
    const check = async () => {
      const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 128 * 1024 })
      if (result.status !== 0) throw new Error('checker_execution_failed')
      const report = JSON.parse(result.stdout)
      const callId = `verification-${++actualCheckerExecutions}`
      owner.session.events.push({ type: 'tool/call', time: Date.now(), data: {
        turn: 1, step: 1, callId, name: 'bash', arguments: JSON.stringify({ command }),
      } })
      mounted.adapter.toolsResult({ agent: owner, callId, name: 'bash', arguments: { command } }, {
        isError: false, value: { kind: 'foreground', exitCode: 0, signal: null, timedOut: false, aborted: false,
          stdout: { text: result.stdout, truncated: false }, stderr: { text: '', truncated: false } },
      })
      await mounted.adapter.drain()
      return report.status
    }
    const firstStatus = await check()
    const advance = step => mounted.adapter.preStep({ agent: owner, messages: [], turn: 1, step, signal },
      async () => ({ kind: 'enter', messages: [] }))
    const offered = await advance(2)
    const duplicate = await advance(3)
    const oneHint = offered.messages.length === 1 && duplicate.messages.length === 0
      && JSON.stringify(offered.messages).includes('recheck')
    // This local fixture mutation tests adapter plumbing, never model efficacy.
    await writeFile(join(cwd, 'output.json'), source)
    mounted.adapter.toolsResult({ agent: owner, callId: 'fixture-write', name: 'write_file' }, { isError: false })
    const secondStatus = await check()
    await finish(owner)
    const state = JSON.parse(await readFile(join(home, PLUGIN_NAME, 'state.json'), 'utf8'))
    const repairedCases = state.rules.flatMap(rule => rule.improvement?.cases ?? [])
      .filter(item => item.repair?.reason === 'matched' && item.repair.violations === 0).length
    const sourceUnchanged = await readFile(join(cwd, 'reference.json'), 'utf8') === source
    return { ok: firstStatus === 'fail' && secondStatus === 'pass' && oneHint && repairedCases > 0 && sourceUnchanged,
      actualCheckerExecutions, statuses: [firstStatus, secondStatus], oneHint, repairedCases,
      sourceUnchanged, controlledLocalFixtureRepair: true, realModel: false }
  } finally { await mounted.dispose() }
}

function user(text) {
  return {
    id: `message-${text}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function agent(sessionId) {
  return {
    id: `agent-${sessionId}`,
    options: { provider: 'deepseek', model: 'deepseek-chat' },
    session: { id: sessionId, header: {}, events: [] },
  }
}

async function completedProjectTurn(
  adapter,
  brainProvider,
  sessionId,
  occurredAt,
  mode,
  promptText = RAW_PROMPT,
) {
  const owner = agent(sessionId)
  const prompt = user(promptText)
  await adapter.preStep({
    agent: owner,
    messages: [prompt],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [prompt] }))
  const prepared = await brainProvider.prepare({
    projectKey: PROJECT_KEY,
    sessionId,
    turn: 1,
    query: promptText,
    signal: new AbortController().signal,
  })
  const handles = prepared.items.map(item => item.handle)
  const treatment = handles.length > 0
  if (treatment) await prepared.accept(handles)
  else if (mode === 'causal') await prepared.accept([])
  const outcome = mode === 'causal' && !treatment ? 'failure' : 'success'
  if (outcome === 'success') {
    owner.session.events.push({
      type: 'tool/call',
      time: occurredAt,
      data: { turn: 1, step: 1, callId: `call-${sessionId}`, name: 'browser' },
    })
    adapter.toolsResult(
      { agent: owner, callId: `call-${sessionId}`, name: 'browser' },
      { isError: false },
    )
  }
  adapter.sessionEvent(owner.session, {
    type: 'turn/end',
    time: occurredAt + 1,
    data: {
      turn: 1,
      reason: { kind: outcome === 'success' ? 'completed' : 'error' },
    },
  })
  await adapter.drain()
  return treatment
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

await main()
