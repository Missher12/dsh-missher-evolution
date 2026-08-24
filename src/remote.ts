import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  ResetRequestSchema,
  SetEnabledRequestSchema,
  type EvolutionSnapshot,
  type RemoteResetRequest,
  type RemoteResetResult,
  type SetEnabledRequest,
} from './remote-contract.js'
import type { EvolutionStore } from './store.js'
import type { AuditEvent, EvolutionState } from './types.js'

const LOCK_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 640, 1_000] as const

export interface RemoteStore {
  load(): Promise<EvolutionState>
  update(
    expectedRevision: number,
    mutate: (state: EvolutionState) => EvolutionState,
  ): Promise<EvolutionState>
  appendAudit(event: AuditEvent): Promise<void>
  reset(input: { expectedRevision: number, confirmation: string }): Promise<{
    state: EvolutionState
    backupId: string
  }>
}

export interface MissherEvolutionRemoteOptions {
  now?: () => number
  warn?: (code: 'remote_audit_failed') => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    missherEvolution: MissherEvolutionRemote
  }
}

export class MissherEvolutionRemote extends TypertRemoteService {
  private readonly store: RemoteStore
  private readonly now: () => number
  private readonly warn: (code: 'remote_audit_failed') => void

  constructor(
    ctx: Context,
    store: RemoteStore | EvolutionStore,
    options: MissherEvolutionRemoteOptions = {},
  ) {
    super(ctx, 'missherEvolution')
    this.store = store
    this.now = options.now ?? Date.now
    this.warn = options.warn ?? (() => undefined)
  }

  @Remote('snapshot')
  async snapshot(): Promise<EvolutionSnapshot> {
    return snapshotFromState(await this.store.load())
  }

  @Remote('setEnabled')
  async setEnabled(input: SetEnabledRequest): Promise<EvolutionSnapshot> {
    const request = SetEnabledRequestSchema.parse(input)
    const state = await retryLockBusy(() =>
      this.store.update(request.expectedRevision, current => ({
        ...current,
        enabled: request.enabled,
      })))
    await this.audit({
      schemaVersion: 1,
      at: this.now(),
      kind: 'enabled_changed',
      count: request.enabled ? 1 : 0,
    })
    return snapshotFromState(state)
  }

  @Remote('reset')
  async reset(input: RemoteResetRequest): Promise<RemoteResetResult> {
    let request: RemoteResetRequest
    try {
      request = ResetRequestSchema.parse(input)
    } catch {
      throw Object.assign(new Error('invalid_reset'), { code: 'invalid_reset' })
    }
    const result = await retryLockBusy(() => this.store.reset(request))
    await this.audit({
      schemaVersion: 1,
      at: this.now(),
      kind: 'state_reset',
      reason: 'manual',
      count: 1,
    })
    return { snapshot: snapshotFromState(result.state), backupId: result.backupId }
  }

  private async audit(event: AuditEvent): Promise<void> {
    try {
      await this.store.appendAudit(event)
    } catch {
      this.warn('remote_audit_failed')
    }
  }
}

export function snapshotFromState(state: EvolutionState): EvolutionSnapshot {
  const counts = {
    candidate: 0,
    trial: 0,
    active: 0,
    suspended: 0,
    retired: 0,
  }
  for (const rule of state.rules) counts[rule.status] += 1
  return {
    schemaVersion: 1,
    revision: state.revision,
    enabled: state.enabled,
    health: state.health,
    lastMaintenanceAt: state.lastMaintenanceAt,
    counters: {
      captures: state.counters.captures,
      injections: state.counters.injections,
      rejectedCaptures: state.counters.rejectedCaptures,
      maintenanceRuns: state.counters.maintenanceRuns,
      weeklyInjections: state.counters.weeklyInjections,
      ...counts,
    },
    rules: state.rules.map(rule => ({
      id: rule.id,
      status: rule.status,
      category: rule.category,
      taskType: rule.taskType,
      instruction: rule.instruction,
      confidence: rule.confidence,
      opportunities: rule.opportunities,
      successes: rule.successes,
      failures: rule.failures,
      corrections: rule.corrections,
    })),
  }
}

async function retryLockBusy<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!hasCode(error, 'lock_busy') || attempt === LOCK_RETRY_DELAYS_MS.length) throw error
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_DELAYS_MS[attempt]))
    }
  }
  throw new Error('unreachable')
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === 'object'
    && (error as { code?: unknown }).code === code
}
