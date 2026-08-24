import { classifyPrompt } from './classifier.js'
import { selectRules } from './lifecycle.js'
import type { MseAdapter, StoreLike } from './adapter.js'

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
    this.maxRules = options.maxRules
    this.now = options.now ?? Date.now
  }

  async prepare(input: BrainPrepareInputLike): Promise<PreparedBrainBatchLike> {
    input.signal.throwIfAborted()
    const state = await this.store.load()
    input.signal.throwIfAborted()
    const selection = state.enabled
      ? selectRules(state, {
          taskType: classifyPrompt(input.query).taskType,
          now: this.now(),
          maxRules: this.maxRules,
          maxCodePoints: 2_000,
        })
      : { rules: [], instruction: '' }
    const byId = new Map(state.rules.map(rule => [rule.id, rule]))
    const items = selection.rules.flatMap(selected => {
      const rule = byId.get(selected.id)
      if (rule === undefined) return []
      return [{
        handle: rule.id,
        providerId: this.id,
        kind: 'learned-rule' as const,
        text: rule.instruction,
        reference: `mse:${rule.id}@${rule.version}`,
        recordedAt: new Date(rule.lastEvidenceAt).toISOString(),
        score: (rule.status === 'active' ? 1 : 0) + rule.confidence,
        pinned: false,
      }]
    })
    const offered = new Set(items.map(item => item.handle))
    let settled = false
    return {
      items,
      accept: async handles => {
        if (settled) throw new Error('brain_batch_settled')
        if (
          handles.length === 0
          || new Set(handles).size !== handles.length
          || handles.some(handle => !offered.has(handle))
        ) throw new Error('brain_handles_invalid')
        if (!this.adapter.acceptInjectedRules(input.sessionId, input.turn, handles)) {
          throw new Error('brain_attribution_unavailable')
        }
        settled = true
      },
      cancel: async () => { settled = true },
    }
  }

  async status(): Promise<{ state: 'ready' | 'disabled' | 'unavailable', count: number }> {
    try {
      const state = await this.store.load()
      return {
        state: state.enabled ? 'ready' : 'disabled',
        count: state.rules.filter(rule => rule.status === 'active' || rule.status === 'trial').length,
      }
    } catch {
      return { state: 'unavailable', count: 0 }
    }
  }
}
