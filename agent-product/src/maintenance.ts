import { isSemanticallySafeRewrite, type AdvisorResult } from './advisor.js'
import { emptyEvaluation, maintain, sha256 } from './lifecycle.js'
import type { AuditEvent, EvolutionState } from './types.js'
import { methodOffers, offeredMethodProposal, type MethodSelection } from './improvement.js'

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
      let maintenanceAudit: AuditEvent[] = []
      let advisorAudit: AuditEvent | undefined
      const updated = await this.updateWithRetry(current => {
        let selection: MethodSelection | null | undefined
        if (advisorResult?.status === 'accepted' && advisorResult.decision.action === 'abstain') selection = null
        if (advisorResult?.status === 'accepted' && advisorResult.decision.action === 'propose') {
          const proposal = advisorResult.decision
          const offered = offeredMethodProposal(proposal, methodOffers(snapshot.rules, now))
          selection = offered && offeredVersions.get(proposal.ruleId) === current.rules.find(r => r.id === proposal.ruleId)?.version
            ? { proposal, origin: 'ai', expectedEpoch: offered.evidenceEpoch } : null
        }
        const result = maintain(current, now, selection)
        transitions = result.transitions.length
        maintenanceAudit = result.audit
        const state = { ...result.state, lastBackupId: backupId }
        advisorAudit = applyAdvisorDecision(state, advisorResult, offeredVersions, now)
        return state
      })
      try {
        for (const event of maintenanceAudit) {
          await this.store.appendAudit(event.kind === 'maintenance_completed'
            ? { ...event, at: updated.lastMaintenanceAt ?? now, reason }
            : event)
        }
        if (advisorAudit !== undefined) await this.store.appendAudit(advisorAudit)
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
  now: number,
): AuditEvent | undefined {
  if (result?.status !== 'accepted' || result.decision.action !== 'rewrite') return undefined
  const decision = result.decision
  const rule = state.rules.find(candidate => candidate.id === decision.ruleId)
  const offeredVersion = offeredVersions.get(result.decision.ruleId)
  if (
    rule === undefined
    || offeredVersion === undefined
    || rule.version !== offeredVersion
    || (rule.status !== 'candidate' && rule.status !== 'trial')
    || !isSemanticallySafeRewrite(rule, result.decision.instruction)
  ) return undefined
  const previousInstructionHash = rule.instructionHash
  const previousVersion = rule.version
  if (previousInstructionHash === sha256(result.decision.instruction)) return undefined
  rule.evaluationHistory = [...(rule.evaluationHistory ?? []), {
    instructionHash: previousInstructionHash,
    endedAt: now,
    evaluation: { ...(rule.evaluation ?? emptyEvaluation()) },
  }].slice(-5)
  rule.instruction = result.decision.instruction
  rule.instructionHash = sha256(result.decision.instruction)
  rule.evaluationInstructionHash = rule.instructionHash
  rule.evaluation = emptyEvaluation()
  rule.opportunities = 0
  rule.successes = 0
  rule.failures = 0
  rule.corrections = 0
  rule.lastSuccessAt = null
  rule.version += 1
  return {
    schemaVersion: 1,
    at: now,
    kind: 'advisor_rule_rewritten',
    ruleId: rule.id,
    previousInstructionHash,
    instructionHash: rule.instructionHash,
    previousVersion,
    version: rule.version,
  }
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
