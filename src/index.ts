import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type LlmRuntime from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import { MseAdapter } from './adapter.js'
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
export const inject = ['agents', 'tools', 'llm', 'dshHomePath', 'missherBrain']

export const Config: z<PluginConfig> = z.object({
  enabled: z.boolean(),
  maintenanceIntervalHours: z.number(),
  maxInjectedRules: z.number(),
})

export function apply(ctx: Context, input: PluginConfig = {}): void {
  const config = normalizeConfig(input)
  const store = new EvolutionStore(ctx.dshHomePath('missher-evolution'), {
    defaultEnabled: config.enabled,
  })
  const adapter = new MseAdapter({
    store,
    config,
    warn: code => ctx.logger.warn('dsh-missher-evolution: %s', code),
  })
  const brainProvider = new EvolutionBrainProvider({
    store,
    adapter,
    maxRules: config.maxInjectedRules,
  })
  const runner = createHarnessModelRunner(ctx.llm)
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
  ctx.effect(() => ctx.missherBrain.register(brainProvider), 'dsh-missher-evolution: brain provider')
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
