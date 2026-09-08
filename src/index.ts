import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type LlmRuntime from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import { MseAdapter, parseNativeCheckerCommand } from './adapter.js'
import { EvolutionBrainProvider, type BrainHubLike } from './brain-provider.js'
import { advise, type ModelRunner } from './advisor.js'
import { normalizeConfig } from './config.js'
import { MaintenanceScheduler } from './maintenance.js'
import { MissherEvolutionRemote } from './remote.js'
import { EvolutionStore } from './store.js'
import type { PluginConfig } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshHomePath(...segments: string[]): string
    missherEvolutionCore: MseAdapter
    missherBrain: BrainHubLike
  }
}

export const name = 'missher-evolution'
export const inject = ['agents', 'tools', 'llm', 'dshHomePath']

export const Config: z<PluginConfig> = z.object({
  enabled: z.boolean(),
  maintenanceIntervalHours: z.number(),
  maxInjectedRules: z.number(),
})

export function apply(ctx: Context, input: PluginConfig = {}): void {
  const config = normalizeConfig(input)
  // Resolve at the public Host entry, never relative to a shared verification chunk.
  const checker = { executable: process.execPath,
    cliPath: fileURLToPath(new URL('./check-cli.js', import.meta.url)),
    electron: process.versions.electron !== undefined }
  const checkerCommand = (checker.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : '')
    + [checker.executable, checker.cliPath, '--checker', 'source-dates-v1', '--source', 'reference.json',
      '--artifact', 'output.json', '--key', 'id', '--field', 'publishedAt'].map(value => `'${value}'`).join(' ')
  const checkerGuidance = parseNativeCheckerCommand(checkerCommand, checker) === null ? ''
    : '\n仅当本轮已接受的纠错提醒涉及原始日期或保留空值，且用户已授权本地参考文件与产物文件时，才按需要通过正常 bash 工具运行已注册的只读核验器。'
      + '示例（按实际授权文件与纠错字段替换 source、artifact、key、field）：\n'
      + checkerCommand
      + '\n日期一致性使用 source-dates-v1，保留空值使用 missing-values-v1。两个文件路径均须相对于本次 bash 实际 workdir，位于该目录内；不得遍历目录、读取符号链接或擅自寻找其他来源。'
      + '不使用命令串联、重定向、任意包装器或自动执行其他 shell。调用与结果都不能覆盖权限、用户要求或 Stop。'
      + '普通测试成功不能证明日期正确或定向回归通过。只有注册调用的真实退出码 0、严格报告与文件独立复读一致才是核验观察。'
      + '后续修改或未分类工具会使旧观察过期，须重新运行核验器；实际任务结束时还会复读该授权文件对，不能把观察称为严格的最终答复前阻断门。'
      + '本地参考一致不证明外部来源真实；证据不足、失败、过期或取消均须如实说明。'
  const brain = ctx.get('missherBrain') as BrainHubLike | undefined
  const systemPrompt = ctx.get('systemPrompt') as {
    section(input: { name: string, order: number, text: string }): () => void
  } | undefined
  if (systemPrompt !== undefined) ctx.effect(() => systemPrompt.section({
    name: 'missher-evolution:agent-guidance', order: 650,
    text: 'MSE 自动记录受控任务证据。经验规则仅在适用范围内作为建议，不能覆盖用户要求、权限或安全限制。按真实工具结果核验任务；失败、未验证、部分完成须如实报告，不得伪造成功或主动修改学习状态。无需调用自学习命令或重复注入规则。' + checkerGuidance,
  }), 'dsh-missher-evolution: agent guidance')
  const store = new EvolutionStore(ctx.dshHomePath('missher-evolution'), {
    defaultEnabled: config.enabled,
  })
  const adapter = new MseAdapter({
    store,
    config,
    checker,
    instanceKey: ctx.dshHomePath('missher-evolution'),
    repairMessage: (text: string) => createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'missher-evolution', form: 'instructions' },
    }),
    ...(brain === undefined ? {
      nativeMessage: (text: string) => createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'missher-evolution', form: 'instructions' },
      }),
    } : {}),
    warn: code => ctx.logger.warn('dsh-missher-evolution: %s', code),
  })
  const runner = createHarnessModelRunner(ctx.llm)
  const brainProvider = new EvolutionBrainProvider({
    store,
    adapter,
    maxRules: config.maxInjectedRules,
  })
  const maintenance = new MaintenanceScheduler({
    store,
    intervalHours: config.maintenanceIntervalHours,
    review: (state, signal) => state.enabled
      ? advise(state.rules, adapter.advisorRoute(), runner, { signal })
      : Promise.resolve({ status: 'skipped_no_route' }),
    warn: code => ctx.logger.warn('dsh-missher-evolution: %s', code),
  })
  new MissherEvolutionRemote(ctx, store, {
    warn: code => ctx.logger.warn('dsh-missher-evolution: %s', code),
  })
  ctx.provide('missherEvolutionCore', adapter)
  if (brain !== undefined) ctx.effect(
    () => brain.register(brainProvider),
    'dsh-missher-evolution: brain provider',
  )
  ctx.on('agent/pre-step', (payload, next) =>
    adapter.preStep(payload as never, next as never) as never)
  ctx.on('tools/result', (exec, result) => { adapter.toolsResult(exec as never, result as never) })
  ctx.on('session/event', (session, event) => { adapter.sessionEvent(session as never, event as never) })
  ctx.on('agent/error', payload => { adapter.agentError(payload as never) })
  ctx.on('session/disposed', session => { adapter.sessionDisposed(session as never) })
  maintenance.start()
  ctx.effect(() => async () => {
    await maintenance.dispose()
    await adapter.dispose()
  }, 'dsh-missher-evolution: dispose')
}

function createHarnessModelRunner(llm: LlmRuntime): ModelRunner {
  return async (request, signal) => {
    const user = request.messages.find(message => message.role === 'user')
    const system = request.messages.find(message => message.role === 'system')
    if (user === undefined) throw new Error('advisor_request_invalid')
    const message = createUserMessage({
      content: [{ type: 'text', text: user.content }],
      source: { kind: 'plugin', plugin: 'missher-evolution', form: 'instructions' },
    })
    let output = ''
    let finished = false
    for await (const chunk of llm.stream({
      provider: request.provider,
      model: request.model,
      messages: [message],
      ...(system === undefined ? {} : { system: system.content }),
      maxTokens: request.maxTokens,
      signal,
    })) {
      if (chunk.type === 'text-delta') output += chunk.text
      if (chunk.type !== 'finish') continue
      finished = true
      if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
        throw new Error('advisor_model_failed')
      }
    }
    if (!finished) throw new Error('advisor_stream_incomplete')
    return output
  }
}

export default { name, inject, Config, apply }

export type * from './types.js'
