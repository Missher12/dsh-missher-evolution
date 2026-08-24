import type { AdvisorResult } from './advisor.js'
import { maintain, sha256 } from './lifecycle.js'
import type { AuditEvent, EvolutionState } from './types.js'

const HOUR_MS = 60 * 60 * 1_000

export interface MaintenanceStore {
  load(): Promise<EvolutionState>
  update(
    expectedRevision: number,
    mutate: (state: EvolutionState) => EvolutionState,
  ): Promise<EvolutionState>
  backup(reason: 'maintenance'): Promise<string>
  appendAudit(event: AuditEvent): Promise<void>
}

export type MaintenanceStatus =
  | { kind: 'completed', transitions: number, reviewed: boolean }
  | { kind: 'not_due' }
  | { kind: 'skipped_lock_busy' }
  | { kind: 'disposed' }
  | { kind: 'failed' }

export type MaintenanceWarningCode = 'maintenance_failed' | 'maintenance_audit_failed'

export interface MaintenanceSchedulerOptions {
  store: MaintenanceStore
  intervalHours: number
  now?: () => number
  schedule?: (handler: () => void, intervalMs: number) => () => void
  review?: (state: EvolutionState, signal: AbortSignal) => Promise<AdvisorResult>
  warn?: (code: MaintenanceWarningCode) => void
}

export class MaintenanceScheduler {
  private readonly store: MaintenanceStore
  private readonly intervalMs: number
  private readonly now: () => number
  private readonly schedule: (handler: () => void, intervalMs: number) => () => void
  private readonly review?: MaintenanceSchedulerOptions['review']
  private readonly warn: (code: MaintenanceWarningCode) => void
  private inFlight: Promise<MaintenanceStatus> | undefined
  private cancelTimer: (() => void) | undefined
  private reviewController: AbortController | undefined
  private started = false
  private disposed = false

  constructor(options: MaintenanceSchedulerOptions) {
    this.store = options.store
    this.intervalMs = Math.trunc(options.intervalHours) * HOUR_MS
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? defaultSchedule
    this.review = options.review
    this.warn = options.warn ?? (() => undefined)
  }

  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.cancelTimer = this.schedule(() => {
      void this.runIfDue('timer')
    }, HOUR_MS)
    void this.runIfDue('startup')
  }

  runIfDue(reason: 'startup' | 'timer'): Promise<MaintenanceStatus> {
    if (this.disposed) return Promise.resolve({ kind: 'disposed' })
    if (this.inFlight !== undefined) return this.inFlight
    const tracked = this.execute(reason).finally(() => {
      if (this.inFlight === tracked) this.inFlight = undefined
    })
    this.inFlight = tracked
    return tracked
  }

  async drain(): Promise<void> {
    await this.inFlight
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      await this.drain()
      return
    }
    this.disposed = true
    this.cancelTimer?.()
    this.cancelTimer = undefined
    this.reviewController?.abort('maintenance_disposed')
    await this.drain()
  }

  private async execute(reason: 'startup' | 'timer'): Promise<MaintenanceStatus> {
    try {
      const snapshot = await this.store.load()
      const now = this.now()
      if (!isDue(snapshot.lastMaintenanceAt, now, this.intervalMs)) return { kind: 'not_due' }

      let backupId: string
      try {
        backupId = await this.store.backup('maintenance')
      } catch (error) {
        if (hasCode(error, 'lock_busy')) return { kind: 'skipped_lock_busy' }
        throw error
      }

      let advisorResult: AdvisorResult | undefined
      const offeredVersions = new Map(snapshot.rules.map(rule => [rule.id, rule.version]))
      if (this.review !== undefined) {
        const controller = new AbortController()
        this.reviewController = controller
        try {
          advisorResult = await this.review(structuredClone(snapshot), controller.signal)
        } catch {
          // Advisor failures never prevent deterministic maintenance.
        } finally {
          if (this.reviewController === controller) this.reviewController = undefined
        }
      }
      if (this.disposed) return { kind: 'disposed' }

      let transitions = 0
      const updated = await this.updateWithRetry(current => {
        const result = maintain(current, now)
        transitions = result.transitions.length
        const state = { ...result.state, lastBackupId: backupId }
        applyAdvisorDecision(state, advisorResult, offeredVersions)
        return state
      })
      try {
        await this.store.appendAudit({
          schemaVersion: 1,
          at: updated.lastMaintenanceAt ?? now,
          kind: 'maintenance_completed',
          reason,
          count: transitions,
        })
      } catch {
        this.warn('maintenance_audit_failed')
      }
      return {
        kind: 'completed',
        transitions,
        reviewed: advisorResult?.status === 'accepted',
      }
    } catch {
      this.warn('maintenance_failed')
      return { kind: 'failed' }
    }
  }

  private async updateWithRetry(
    mutate: (state: EvolutionState) => EvolutionState,
  ): Promise<EvolutionState> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.store.load()
      try {
        return await this.store.update(current.revision, mutate)
      } catch (error) {
        if (!hasCode(error, 'revision_conflict') || attempt === 2) throw error
      }
    }
    throw new Error('unreachable')
  }
}

function isDue(lastMaintenanceAt: number | null, now: number, intervalMs: number): boolean {
  return lastMaintenanceAt === null || now - lastMaintenanceAt >= intervalMs
}

function applyAdvisorDecision(
  state: EvolutionState,
  result: AdvisorResult | undefined,
  offeredVersions: ReadonlyMap<string, number>,
): void {
  if (result?.status !== 'accepted' || result.decision.action !== 'rewrite') return
  const rule = state.rules.find(candidate => candidate.id === result.decision.ruleId)
  const offeredVersion = offeredVersions.get(result.decision.ruleId)
  if (
    rule === undefined
    || offeredVersion === undefined
    || rule.version !== offeredVersion
    || (rule.status !== 'candidate' && rule.status !== 'trial')
  ) return
  rule.instruction = result.decision.instruction
  rule.instructionHash = sha256(result.decision.instruction)
  rule.version += 1
}

function defaultSchedule(handler: () => void, intervalMs: number): () => void {
  const timer = setInterval(handler, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === 'object'
    && (error as { code?: unknown }).code === code
}
