#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyPackage } from './verify-package.mjs'

const pluginRoot = resolve(import.meta.dirname, '..')
const PACKAGE_NAME = 'dsh-missher-evolution'
const PLUGIN_NAME = 'missher-evolution'
const RAW_PROMPT = '修复 TypeScript 测试并运行目标测试核对结果'

async function main() {
  let temporaryHome
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
      runCli(options.cli, temporaryHome, [
        'plugin', '--profile', options.profile, 'add', options.archive,
      ])
      const dump = runCli(options.cli, temporaryHome, [
        '--profile', options.profile, '--dump-config',
      ])
      if (!dump.includes(PACKAGE_NAME) || !dump.includes(PLUGIN_NAME)) {
        throw new Error('profile_composition_invalid')
      }
      pluginEntry = join(profileDir, 'node_modules', PACKAGE_NAME, 'lib', 'index.js')
      await access(pluginEntry)
      profileInstall = true
    } else {
      const marker = join(profileDir, 'node_modules', PACKAGE_NAME)
      await mkdir(marker, { recursive: true })
      profileInstall = true
    }
    await mkdir(dirname(adjacentFile), { recursive: true })
    await writeFile(adjacentFile, 'preserve\n', 'utf8')

    const runtime = await loadRuntime(pluginEntry)
    const first = await mount(runtime, temporaryHome)
    await waitForMaintenance(first.remote)
    const startedAt = Date.now()
    for (let index = 0; index < 6; index += 1) {
      await completedCodingTurn(first.adapter, first.brainProvider, `native-${index}`, startedAt + index * 10)
    }
    const learned = await first.remote.snapshot()
    const capture = learned.counters.captures === 6 && learned.counters.active === 1
    await first.dispose()

    const reopened = await mount(runtime, temporaryHome)
    await reopened.adapter.preStep({
      agent: agent('native-restart'),
      messages: [user(RAW_PROMPT)],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages: [user(RAW_PROMPT)] }))
    const prepared = await reopened.brainProvider.prepare({
      projectKey: 'a'.repeat(64),
      sessionId: 'native-restart',
      turn: 1,
      query: RAW_PROMPT,
      signal: new AbortController().signal,
    })
    const injection = prepared.items.some(item =>
      item.providerId === 'evolution' && item.kind === 'learned-rule')
    const restart = (await reopened.remote.snapshot()).counters.active === 1
    await reopened.dispose()

    const persisted = await readFile(join(temporaryHome, PLUGIN_NAME, 'state.json'), 'utf8')
    if (persisted.includes(RAW_PROMPT) || persisted.includes(temporaryHome)) {
      throw new Error('durable_privacy_violation')
    }

    if (options.cli !== undefined) {
      runCli(options.cli, temporaryHome, [
        'plugin', '--profile', options.profile, 'remove', PACKAGE_NAME,
      ])
      const dump = runCli(options.cli, temporaryHome, [
        '--profile', options.profile, '--dump-config',
      ])
      if (dump.includes(PACKAGE_NAME)) throw new Error('profile_uninstall_invalid')
    } else {
      await rm(join(profileDir, 'node_modules', PACKAGE_NAME), { recursive: true, force: true })
    }
    const uninstall = !await exists(join(profileDir, 'node_modules', PACKAGE_NAME))
    const adjacentDataPreserved = await exists(adjacentFile)
    const statePreserved = await exists(join(temporaryHome, PLUGIN_NAME, 'state.json'))
    const result = {
      ok: profileInstall && capture && restart && injection && uninstall
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
    }
    if (!result.ok) throw new Error('acceptance_incomplete')
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch {
    process.stderr.write(`${JSON.stringify({ ok: false, code: 'native_smoke_failed' })}\n`)
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
    archive: join(pluginRoot, 'dist', 'dsh-missher-evolution-0.1.1.tgz'),
    cli: undefined,
    profile: 'mse-smoke',
  }
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]
    const value = args[index + 1]
    if (!['--platform', '--archive', '--cli', '--profile'].includes(key) || value === undefined) {
      throw new Error('arguments_invalid')
    }
    if (key === '--platform') options.platform = value
    if (key === '--archive') options.archive = resolve(value)
    if (key === '--cli') options.cli = resolve(value)
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

function runCli(cli, home, args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: pluginRoot,
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.status !== 0) throw new Error('harness_cli_failed')
  return result.stdout
}

async function loadRuntime(pluginEntry) {
  const plugin = (await import(pathToFileURL(pluginEntry).href)).default
  const require = createRequire(pluginEntry)
  const cordisEntry = require.resolve('@deepseek-ai/cordis')
  const { Context } = await import(pathToFileURL(cordisEntry).href)
  return { Context, plugin }
}

async function mount(runtime, dshHome) {
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
  ctx.provide('missherBrain', {
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
  if (brainProvider === undefined) throw new Error('brain_provider_missing')
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

async function waitForMaintenance(remote) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await remote.snapshot()).counters.maintenanceRuns >= 1) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('maintenance_timeout')
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

async function completedCodingTurn(adapter, brainProvider, sessionId, occurredAt) {
  const owner = agent(sessionId)
  const prompt = user(RAW_PROMPT)
  await adapter.preStep({
    agent: owner,
    messages: [prompt],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [prompt] }))
  const prepared = await brainProvider.prepare({
    projectKey: 'a'.repeat(64),
    sessionId,
    turn: 1,
    query: RAW_PROMPT,
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
