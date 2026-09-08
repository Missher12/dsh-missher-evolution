import type { MseAdapter, StoreLike } from './adapter.js'
import type { PreparedTurn } from './engine.js'

export interface BrainContributionLike {
  handle: string
  providerId: string
  kind: 'learned-rule'
  text: string
  reference: string
  recordedAt: string
  score: number
  pinned: boolean
}

export interface PreparedBrainBatchLike {
  readonly items: readonly BrainContributionLike[]
  accept(handles: readonly string[]): Promise<void>
  cancel(): Promise<void>
}

export interface BrainPrepareInputLike {
  projectKey: string
  sessionId: string
  turn: number
  query: string
  signal: AbortSignal
}

export interface BrainProviderLike {
  readonly protocolVersion: 1
  readonly id: string
  readonly byteBudget: number
  prepare(input: BrainPrepareInputLike): Promise<PreparedBrainBatchLike>
  status(): Promise<{ state: 'ready' | 'disabled' | 'unavailable', count: number }>
}

export interface BrainHubLike {
  register(provider: BrainProviderLike): () => void
}

export interface EvolutionBrainProviderOptions {
  store: StoreLike
  adapter: MseAdapter
  maxRules: number
  now?: () => number
}

export class EvolutionBrainProvider implements BrainProviderLike {
  readonly protocolVersion = 1 as const
  readonly id = 'evolution'
  readonly byteBudget = 2_000
  private readonly store: StoreLike
  private readonly adapter: MseAdapter
  private readonly maxRules: number
  private readonly now: () => number

  constructor(options: EvolutionBrainProviderOptions) {
    this.store = options.store
    this.adapter = options.adapter
    this.maxRules = Math.max(1, Math.min(4, Math.trunc(options.maxRules)))
    this.now = options.now ?? Date.now
  }

  async prepare(input: BrainPrepareInputLike): Promise<PreparedBrainBatchLike> {
    input.signal.throwIfAborted()
    const prepared = await this.adapter.prepareBrainRecall({
      sessionId: input.sessionId,
      turnId: input.turn,
      prompt: input.query,
      projectKey: input.projectKey,
    })
    input.signal.throwIfAborted()
    const items = (prepared?.rules ?? []).slice(0, this.maxRules).map(rule => ({
        handle: rule.id,
        providerId: this.id,
        kind: 'learned-rule' as const,
        text: rule.status === 'guardrail' ? `[纠错提醒] ${rule.instruction}` : rule.instruction,
        reference: `mse:${rule.id}@${rule.version}`,
        recordedAt: new Date(rule.lastEvidenceAt).toISOString(),
        score: Math.min(2, (rule.status === 'guardrail' ? 1.5 : rule.status === 'active' ? 1 : 0.5) + rule.confidence),
        pinned: false,
      }))
    return this.batch(prepared, items)
  }

  async status(): Promise<{ state: 'ready' | 'disabled' | 'unavailable', count: number }> {
    try {
      const state = await this.store.load()
      return {
        state: state.enabled ? 'ready' : 'disabled',
        count: state.rules.filter(rule => rule.status === 'active' || rule.status === 'trial' || rule.status === 'guardrail').length,
      }
    } catch {
      return { state: 'unavailable', count: 0 }
    }
  }

  private batch(
    prepared: PreparedTurn | null,
    items: readonly BrainContributionLike[],
  ): PreparedBrainBatchLike {
    const offered = new Set(items.map(item => item.handle))
    let settled = false
    return {
      items,
      accept: async handles => {
        if (settled) throw new Error('brain_batch_settled')
        if (
          prepared === null
          || (handles.length === 0 && prepared.ruleIds.length > 0)
          || new Set(handles).size !== handles.length
          || handles.some(handle => !offered.has(handle))
        ) throw new Error('brain_handles_invalid')
        if (!this.adapter.acceptBrainRecall(prepared, handles)) {
          throw new Error('brain_attribution_unavailable')
        }
        settled = true
      },
      cancel: async () => {
        if (settled) return
        if (prepared !== null) this.adapter.cancelBrainRecall(prepared)
        settled = true
      },
    }
  }
}
