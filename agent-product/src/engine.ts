import type { AdvisorRoute } from './advisor.js'
import { classifyTool } from './classifier.js'
import { distillExperience } from './experience.js'
import { collectVerificationCases } from './improvement.js'
import { capture, selectRules, sha256 } from './lifecycle.js'
import { TurnRegistry, type TurnSnapshot } from './registry.js'
import { verificationPlans, checkExitStatus, observeCheck, settleChecks,
  type VerificationPlan, type VerificationRevision } from './verification.js'
import {
  ERROR_KINDS,
  OUTCOMES,
  type AuditEvent,
  type CaptureEvent,
  type ErrorKind,
  type ExperienceCapsule,
  type ExperienceScope,
  type EvolutionState,
  type Outcome,
  type ResolvedConfig,
  type RuleCategory,
  type TaskType,
} from './types.js'

const DEFAULT_MAX_INJECTED_RULES = 4
const MAX_PROMPT_CODE_UNITS = 32 * 1_024
const PENDING_TTL_MS = 60 * 60 * 1_000
const MAX_PENDING_TURNS = 1_000
const LOCK_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 640, 1_000] as const
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u

export interface EvolutionStoreLike {
  load(): Promise<EvolutionState>
  update(
    expectedRevision: number,
    mutate: (state: EvolutionState) => EvolutionState,
  ): Promise<EvolutionState>
  appendAudit(event: AuditEvent): Promise<void>
}

export type EvolutionEngineWarningCode =
  | 'state_unavailable'
  | 'capture_failed'
  | 'audit_failed'
  | 'injection_metric_failed'
  | 'capture_retry_expired'
  | 'capture_retry_capacity'
  | 'capture_retry_exhausted'

export type CaptureReceipt = 'persisted' | 'already_persisted' | 'retryable_failure' | 'retry_exhausted' | 'not_observed'
interface DeliveryRecord {
  event: CaptureEvent
  status: 'pending' | 'persisted' | 'retryable_failure' | 'retry_exhausted'
  createdAt: number
  attempts: number
}

export interface EvolutionEngineOptions {
  store: EvolutionStoreLike
  registry?: TurnRegistry
  config?: Pick<ResolvedConfig, 'maxInjectedRules'>
  now?: () => number
  warn?: (code: EvolutionEngineWarningCode) => void
  instanceKey?: string
}

export interface PrepareTurnInput {
  sessionId: string
  turnId: string | number
  prompt: string
  projectKey?: string
  route?: AdvisorRoute
}

export interface PreparedTurn {
  readonly sessionId: string
  readonly turnId: string
  readonly instruction: string
  readonly ruleIds: readonly string[]
  readonly rules: readonly PreparedRuleSnapshot[]
  readonly experimentAssignments: readonly import('./types.js').TrialAssignment[]
  readonly correlationHash: string
  readonly selectedAt: number
  readonly verificationPlans: readonly VerificationPlan[]
  readonly projectScopeHash?: string
}

export interface PreparedRuleSnapshot {
  readonly id: string
  readonly status: 'trial' | 'active' | 'guardrail'
  readonly category: RuleCategory
  readonly taskType: TaskType
  readonly instruction: string
  readonly version: number
  readonly lastEvidenceAt: number
  readonly confidence: number
  readonly expiresAt?: number | null
  readonly scope?: Readonly<ExperienceScope>
}

interface PendingPreparedTurn {
  prepared: PreparedTurn
  touchedAt: number
}

interface ObservedTurn {
  sessionId: string
  turnId: string
  state: EvolutionState
  experience: ExperienceCapsule
  opened: TurnSnapshot
}

export interface ObserveToolInput {
  sessionId: string
  turnId: string | number
  toolName: string
  errorKind?: ErrorKind
  exitCode?: number | null
  readOnly?: boolean
}

export interface ObserveAssistantInput {
  sessionId: string
  turnId: string | number
  outcome: Outcome
}

export interface ObserveErrorInput {
  sessionId: string
  turnId: string | number
  errorKind: ErrorKind
}

export interface CompleteTurnInput {
  sessionId: string
  turnId: string | number
  outcome: Outcome
  completed?: boolean
  verificationPassed?: boolean
  occurredAt: number
  finalVerificationRevisions?: readonly VerificationRevision[]
}

export class EvolutionEngine {
  readonly registry: TurnRegistry
  private readonly store: EvolutionStoreLike
  private readonly maxInjectedRules: number
  private readonly now: () => number
  private readonly warn: (code: EvolutionEngineWarningCode) => void
  private readonly instanceKey: string | undefined
  private readonly pendingByTurn = new Map<string, PendingPreparedTurn>()
  private readonly pendingKeys = new WeakMap<PreparedTurn, string>()
  private readonly deliveries = new Map<string, DeliveryRecord>()
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  private latestAdvisorRoute: AdvisorRoute | null = null

  constructor(options: EvolutionEngineOptions) {
    this.store = options.store
    this.registry = options.registry ?? new TurnRegistry()
    this.maxInjectedRules = validMaxRules(options.config?.maxInjectedRules)
      ? options.config.maxInjectedRules
      : DEFAULT_MAX_INJECTED_RULES
    this.now = options.now ?? Date.now
    this.warn = options.warn ?? (() => undefined)
    this.instanceKey = options.instanceKey
  }

  async prepareTurn(input: PrepareTurnInput): Promise<PreparedTurn | null> {
    const observed = await this.openObservedTurn(input)
    if (observed === null) return null
    const { sessionId, turnId, state, experience, opened } = observed
    const selection = selectRules(state, {
      taskType: experience.taskType,
      experience,
      experimentKey: opened.taskHash,
      now: this.now(),
      maxRules: this.maxInjectedRules,
      maxCodePoints: 2_000,
    })
    const selectedAt = this.now()
    if (
      (selection.rules.length === 0 || selection.instruction === '')
      && (selection.experimentAssignments ?? []).length === 0
    ) return null
    const stateById = new Map(state.rules.map(rule => [rule.id, rule]))
    const ruleSnapshots = selection.rules.flatMap(selected => {
      const stored = stateById.get(selected.id)
      if (stored === undefined) return []
      return [Object.freeze({
        ...selected,
        version: stored.version,
        lastEvidenceAt: stored.lastEvidenceAt,
        confidence: stored.confidence,
        expiresAt: stored.expiresAt,
        ...(stored.scope === undefined ? {} : { scope: Object.freeze({ ...stored.scope }) }),
      })]
    })
    const prepared: PreparedTurn = Object.freeze({
      sessionId,
      turnId,
      instruction: selection.instruction,
      ruleIds: Object.freeze(ruleSnapshots.map(rule => rule.id)),
      rules: Object.freeze(ruleSnapshots),
      experimentAssignments: Object.freeze(
        (selection.experimentAssignments ?? []).map(assignment => Object.freeze({ ...assignment })),
      ),
      correlationHash: opened.taskHash,
      selectedAt,
      verificationPlans: Object.freeze(verificationPlans(selection.rules.flatMap(rule => {
        const stored = stateById.get(rule.id)
        return stored ? [stored] : []
      })).map(plan => Object.freeze(plan))),
      ...(experience.scope.kind === 'project'
        ? { projectScopeHash: experience.scope.keyHash as string }
        : {}),
    })
    const key = pendingKey(sessionId, turnId)
    this.deletePending(key)
    this.pendingByTurn.set(key, { prepared, touchedAt: this.now() })
    this.pendingKeys.set(prepared, key)
    return prepared
  }

  async observeTurn(input: PrepareTurnInput): Promise<boolean> {
    return await this.openObservedTurn(input) !== null
  }

  private async openObservedTurn(input: PrepareTurnInput): Promise<ObservedTurn | null> {
    if (this.disposed || typeof input.prompt !== 'string' || input.prompt.trim() === '') return null
    const route = safeAdvisorRoute(input.route)
    if (route !== null) this.latestAdvisorRoute = route
    try {
      const sessionId = identity(input.sessionId, 'session')
      const turnId = identity(input.turnId, 'turn')
      this.cleanupPending()
      this.retryFailedCaptures()
      const state = await this.store.load()
      if (!state.enabled) return null
      const experience = distillExperience({
        prompt: input.prompt.slice(0, MAX_PROMPT_CODE_UNITS),
        ...(input.projectKey === undefined ? {} : { projectKey: input.projectKey }),
        ...(this.instanceKey === undefined ? {} : { instanceKey: this.instanceKey }),
      })
      const opened = this.registry.open(sessionId, turnId, {
        taskHash: turnTaskHash(sessionId, turnId),
        taskType: experience.taskType,
        correction: experience.correction,
        preference: experience.preference,
        experience,
      })
      if (opened === undefined) return null
      return { sessionId, turnId, state, experience, opened }
    } catch {
      this.warn('state_unavailable')
      return null
    }
  }

  acceptInjection(prepared: PreparedTurn, acceptedRuleIds: readonly string[] = prepared.ruleIds): boolean {
    if (!this.isPreparedCurrent(prepared)) return false
    const controlOnly = prepared.ruleIds.length === 0
      && prepared.experimentAssignments.length > 0
      && prepared.experimentAssignments.every(assignment => assignment.arm === 'control')
    if (
      (acceptedRuleIds.length === 0 && !controlOnly)
      || acceptedRuleIds.length > prepared.ruleIds.length
      || new Set(acceptedRuleIds).size !== acceptedRuleIds.length
      || acceptedRuleIds.some(ruleId => !prepared.ruleIds.includes(ruleId))
    ) return false
    const key = this.pendingKeys.get(prepared)
    if (key === undefined) return false
    const pending = this.pendingByTurn.get(key)
    if (pending?.prepared !== prepared) return false
    const accepted = [...acceptedRuleIds]
    const plans = prepared.verificationPlans.filter(plan => accepted.includes(plan.ruleId))
    if (!this.registry.canSetVerificationPlans(prepared.sessionId, prepared.turnId, plans)) return false
    const acceptedAssignments = accepted.length === prepared.ruleIds.length
      ? [...prepared.experimentAssignments] : []
    if (!this.registry.setInjectedRules(prepared.sessionId, prepared.turnId, accepted)) {
      return false
    }
    this.registry.setExperimentAssignments(prepared.sessionId, prepared.turnId, acceptedAssignments)
    this.registry.setVerificationPlans(prepared.sessionId, prepared.turnId, plans,
      new Map(prepared.rules.flatMap(rule => rule.scope === undefined ? [] : [[rule.id, { ...rule.scope }] as const])))
    this.deletePending(key)
    this.enqueue('injection_metric_failed', async () => {
      if (accepted.length > 0) {
        await this.updateWithRetry(current => ({
          ...current,
          counters: {
            ...current.counters,
            injections: current.counters.injections + accepted.length,
            weeklyInjections: current.counters.weeklyInjections + accepted.length,
          },
        }))
      }
      await this.appendAudits([
        selectionAudit(prepared, accepted, acceptedAssignments),
        ...(accepted.length === 0 ? [] : [{
          schemaVersion: 1 as const,
          at: this.now(),
          kind: 'rules_injected' as const,
          count: accepted.length,
          correlationHash: prepared.correlationHash,
          ruleIds: accepted,
          ...(prepared.projectScopeHash === undefined
            ? {}
            : { projectScopeHash: prepared.projectScopeHash }),
          ...(acceptedAssignments[0] === undefined
            ? {}
            : { experimentArm: acceptedAssignments[0].arm }),
        }]),
      ])
    })
    return true
  }

  cancelInjection(prepared: PreparedTurn): boolean {
    if (this.disposed) return false
    const key = this.pendingKeys.get(prepared)
    if (key === undefined || this.pendingByTurn.get(key)?.prepared !== prepared) return false
    this.deletePending(key)
    this.registry.setExperimentAssignments(prepared.sessionId, prepared.turnId, [])
    return true
  }

  isPreparedCurrent(prepared: PreparedTurn): boolean {
    if (this.disposed) return false
    const key = this.pendingKeys.get(prepared)
    if (key === undefined) return false
    const pending = this.pendingByTurn.get(key)
    if (pending?.prepared !== prepared) return false
    if (prepared.rules.some(rule => rule.status === 'guardrail'
      && (rule.expiresAt == null || rule.expiresAt <= this.now()))) {
      this.deletePending(key)
      return false
    }
    if (pending.touchedAt <= this.now() - PENDING_TTL_MS) {
      this.deletePending(key)
      return false
    }
    return true
  }

  /** Trusted host API. Never expose arbitrary pass/fail reports as an Agent tool. */
  observeVerification(input: { sessionId: string, turnId: string | number, report: unknown }): boolean {
    if (this.disposed) return false
    try { return this.registry.observeVerification(input.sessionId, input.turnId, input.report) }
    catch { return false }
  }

  observeTool(input: ObserveToolInput): boolean {
    if (this.disposed) return false
    try {
      const errorKind = ERROR_KINDS.includes(input.errorKind ?? 'none')
        ? input.errorKind ?? 'none'
        : 'unknown'
      const observed = this.registry.observeTool(
        input.sessionId,
        input.turnId,
        classifyTool(input.toolName),
        errorKind,
      )
      if (observed) this.registry.observeToolEvidence(input.sessionId, input.turnId,
        input.exitCode === undefined ? classifyTool(input.toolName) === 'shell' ? null : undefined
          : Number.isSafeInteger(input.exitCode) ? input.exitCode : null,
        input.readOnly === true)
      return observed
    } catch {
      this.warn('capture_failed')
      return false
    }
  }

  observeAssistant(input: ObserveAssistantInput): boolean {
    if (this.disposed) return false
    try {
      if (!OUTCOMES.includes(input.outcome)) return false
      return this.registry.observeAssistant(input.sessionId, input.turnId, input.outcome)
    } catch {
      this.warn('capture_failed')
      return false
    }
  }

  observeError(input: ObserveErrorInput): boolean {
    if (this.disposed) return false
    try {
      const errorKind = ERROR_KINDS.includes(input.errorKind) && input.errorKind !== 'none'
        ? input.errorKind
        : 'unknown'
      return this.registry.observeError(input.sessionId, input.turnId, errorKind)
    } catch {
      this.warn('capture_failed')
      return false
    }
  }

  completeTurn(input: CompleteTurnInput): boolean {
    if (this.disposed) return false
    try {
      if (!OUTCOMES.includes(input.outcome) || !Number.isSafeInteger(input.occurredAt) || input.occurredAt < 0) {
        return false
      }
      const sessionId = identity(input.sessionId, 'session')
      const turnId = identity(input.turnId, 'turn')
      const key = pendingKey(sessionId, turnId)
      const taskHash = turnTaskHash(sessionId, turnId)
      const previous = this.deliveries.get(taskHash)
      if (previous !== undefined) {
        if (previous.status !== 'retryable_failure') return false
        this.scheduleCapture(previous)
        return true
      }
      this.pruneDeliveries()
      if (this.deliveries.size >= MAX_PENDING_TURNS) {
        this.warn('capture_retry_capacity')
        return false
      }
      // Unaccepted control handles have no causal authority, just like treatments.
      this.deletePending(key)
      const snapshot = this.registry.claimCapture(sessionId, turnId)
      if (snapshot === undefined) return false
      const event = toCaptureEvent(snapshot, input)
      const record: DeliveryRecord = { event, status: 'pending', createdAt: this.now(), attempts: 0 }
      this.deliveries.set(taskHash, record)
      this.scheduleCapture(record)
      return true
    } catch {
      this.warn('capture_failed')
      return false
    }
  }

  async completeTurnPersisted(input: CompleteTurnInput): Promise<CaptureReceipt> {
    let taskHash: string
    try { taskHash = turnTaskHash(input.sessionId, input.turnId) }
    catch { return 'not_observed' }
    const already = this.deliveries.get(taskHash)?.status === 'persisted'
    this.completeTurn(input)
    await this.drain()
    const status = this.deliveries.get(taskHash)?.status
    if (status === 'persisted') return already ? 'already_persisted' : 'persisted'
    if (status === 'retry_exhausted') return 'retry_exhausted'
    if (status !== undefined) return 'retryable_failure'
    // An idempotent replay after process restart may have no registry entry.
    try { if ((await this.store.load()).recentTaskHashes.includes(taskHash)) return 'already_persisted' }
    catch { return 'retryable_failure' }
    return 'not_observed'
  }

  deliveryDiagnostics(): { pending: number, retryable: number, exhausted: number } {
    const values = [...this.deliveries.values()]
    return { pending: values.filter(item => item.status === 'pending').length,
      retryable: values.filter(item => item.status === 'retryable_failure').length,
      exhausted: values.filter(item => item.status === 'retry_exhausted').length }
  }

  private scheduleCapture(record: DeliveryRecord): void {
    record.attempts += 1
    record.status = 'pending'
    this.enqueue('capture_failed', async () => {
      try {
        let audit: AuditEvent[] = []
        await this.updateWithRetry(current => {
          const result = capture(current, record.event)
          audit = result.audit
          return result.state
        })
        record.status = 'persisted'
        await this.appendAudits(audit)
      } catch (error) {
        record.status = record.attempts >= 3 ? 'retry_exhausted' : 'retryable_failure'
        if (record.status === 'retry_exhausted') this.warn('capture_retry_exhausted')
        throw error
      }
    })
  }

  private pruneDeliveries(): void {
    for (const [hash, record] of this.deliveries) {
      if (record.status === 'pending') continue
      if (record.createdAt > this.now() - PENDING_TTL_MS && this.deliveries.size < MAX_PENDING_TURNS) continue
      if (record.status === 'retryable_failure' && record.createdAt > this.now() - PENDING_TTL_MS) continue
      if (record.status === 'retryable_failure') this.warn('capture_retry_expired')
      this.deliveries.delete(hash)
    }
  }

  private retryFailedCaptures(): void {
    this.pruneDeliveries()
    for (const record of this.deliveries.values()) {
      if (record.status === 'retryable_failure') { this.scheduleCapture(record); break }
    }
  }

  disposeSession(sessionId: string): number {
    if (this.disposed) return 0
    try {
      const session = identity(sessionId, 'session')
      for (const [key, entry] of this.pendingByTurn) {
        if (entry.prepared.sessionId === session) this.deletePending(key)
      }
      return this.registry.discardSession(session)
    } catch {
      this.warn('capture_failed')
      return 0
    }
  }

  advisorRoute(): AdvisorRoute | null {
    return this.latestAdvisorRoute === null ? null : { ...this.latestAdvisorRoute }
  }

  drain(): Promise<void> {
    return this.queue
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const key of [...this.pendingByTurn.keys()]) this.deletePending(key)
    await this.drain()
  }

  private cleanupPending(now = this.now()): void {
    const cutoff = now - PENDING_TTL_MS
    for (const [key, entry] of this.pendingByTurn) {
      if (entry.touchedAt <= cutoff) this.deletePending(key)
    }
    while (this.pendingByTurn.size >= MAX_PENDING_TURNS) {
      const oldest = this.pendingByTurn.keys().next().value
      if (oldest === undefined) break
      this.deletePending(oldest)
    }
  }

  private deletePending(key: string): void {
    const entry = this.pendingByTurn.get(key)
    if (entry !== undefined) this.pendingKeys.delete(entry.prepared)
    this.pendingByTurn.delete(key)
  }

  private enqueue(code: EvolutionEngineWarningCode, work: () => Promise<void>): void {
    if (this.disposed) return
    this.queue = this.queue.then(async () => {
      try {
        await work()
      } catch {
        this.warn(code)
      }
    })
  }

  private async updateWithRetry(
    mutate: (state: EvolutionState) => EvolutionState,
  ): Promise<EvolutionState> {
    for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt += 1) {
      let current: EvolutionState
      try {
        current = await this.store.load()
      } catch (error) {
        if (hasCode(error, 'lock_busy') && attempt < LOCK_RETRY_DELAYS_MS.length) {
          await retryDelay(attempt)
          continue
        }
        throw error
      }
      try {
        return await this.store.update(current.revision, mutate)
      } catch (error) {
        if (
          attempt === LOCK_RETRY_DELAYS_MS.length
          || (!hasCode(error, 'revision_conflict') && !hasCode(error, 'lock_busy'))
        ) throw error
        if (hasCode(error, 'lock_busy')) await retryDelay(attempt)
      }
    }
    throw new Error('unreachable')
  }

  private async appendAudits(events: readonly AuditEvent[]): Promise<void> {
    let failed = false
    for (const event of events) {
      try {
        await this.store.appendAudit(event)
      } catch {
        failed = true
      }
    }
    if (failed) this.warn('audit_failed')
  }
}

export function turnTaskHash(sessionId: string, turnId: string | number): string {
  return sha256(JSON.stringify(['mse-turn-v2', identity(sessionId, 'session'), identity(turnId, 'turn')]))
}

function toCaptureEvent(snapshot: TurnSnapshot, input: CompleteTurnInput) {
  const entries = snapshot.verificationEntries ?? []
  if (entries.some(entry => entry.checkerId === 'exit-status-v1')) {
    observeCheck(entries, checkExitStatus(snapshot.exitCodes ?? []))
  }
  const verificationResults = settleChecks(entries, input.finalVerificationRevisions).map(result =>
    result.status === 'pass' && (input.completed !== true || input.outcome === 'partial')
      ? { ...result, status: 'insufficient_evidence' as const, repaired: false, firstPass: false } : result)
  const learningCases = input.completed === true && input.outcome !== 'partial'
    ? collectVerificationCases(entries, verificationResults, snapshot.taskHash, input.occurredAt) : []
  const observedOutcome = input.outcome === 'success'
    ? snapshot.assistantOutcome ?? 'success'
    : input.outcome
  const outcome: Outcome = input.verificationPassed === false
    || (snapshot.failedToolCount > 0 && input.verificationPassed !== true)
    ? 'failure'
    : snapshot.correction && input.completed === true && observedOutcome !== 'failure'
      ? 'corrected'
      : observedOutcome
  const errorKind: ErrorKind = outcome === 'failure'
    ? snapshot.errorKind === 'none' ? 'unknown' : snapshot.errorKind
    : 'none'
  const outcomeEvidence = evidenceFor(snapshot, input, outcome)
  return {
    schemaVersion: 1 as const,
    taskHash: snapshot.taskHash,
    sessionHash: sha256(snapshot.sessionId),
    occurredAt: input.occurredAt,
    taskType: snapshot.taskType,
    outcome,
    correction: snapshot.correction,
    complexity: snapshot.workflowSteps.length >= 3
      ? 'high' as const
      : snapshot.workflowSteps.length > 0 ? 'medium' as const : 'low' as const,
    workflowSteps: [...snapshot.workflowSteps],
    workflowSignature: sha256(JSON.stringify({
      taskType: snapshot.taskType,
      workflowSteps: snapshot.workflowSteps,
    })),
    errorKind,
    injectedRuleIds: [...snapshot.injectedRuleIds],
    ...(verificationResults.length === 0 ? {} : { verificationResults }),
    ...(learningCases.length === 0 ? {} : { learningCases }),
    preference: snapshot.preference,
    ...(snapshot.experience === undefined ? {} : { experience: structuredClone(snapshot.experience) }),
    outcomeEvidence,
    experimentAssignments: snapshot.experimentAssignments.map(assignment => ({ ...assignment })),
  }
}

function evidenceFor(
  snapshot: TurnSnapshot,
  input: CompleteTurnInput,
  outcome: Outcome,
): import('./types.js').OutcomeEvidence {
  const signals: import('./types.js').OutcomeSignal[] = []
  if (input.completed === true) signals.push('host_completed')
  if (snapshot.assistantOutcome !== null) signals.push('assistant_content')
  if (snapshot.successfulToolCount > 0) signals.push('tool_success')
  if (input.verificationPassed === true) signals.push('verification_passed')
  if (input.verificationPassed === false) signals.push('verification_failed')
  if (snapshot.correction || outcome === 'corrected') signals.push('correction')
  if (snapshot.failedToolCount > 0) signals.push('tool_failure')
  if (outcome === 'failure') signals.push('agent_error')
  const contradicted = outcome === 'failure'
    || outcome === 'corrected'
    || snapshot.correction
    || input.verificationPassed === false
    || (snapshot.failedToolCount > 0 && input.verificationPassed !== true)
  return {
    quality: contradicted
      ? 'contradicted'
      : input.verificationPassed === true
        ? 'verified'
        : input.completed === true && snapshot.successfulToolCount > 0
          ? 'supported'
          : 'weak',
    signals: [...new Set(signals)],
  }
}

function identity(value: unknown, label: string): string {
  const normalized = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : value
  if (
    typeof normalized !== 'string'
    || normalized.length === 0
    || normalized.length > 512
    || CONTROL_CHARACTER.test(normalized)
  ) throw new TypeError(`${label}_invalid`)
  return normalized
}

function safeAdvisorRoute(route: AdvisorRoute | undefined): AdvisorRoute | null {
  if (
    route === undefined
    || !validRoutePart(route.provider)
    || !validRoutePart(route.model)
  ) return null
  return { provider: route.provider, model: route.model }
}

function validRoutePart(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !CONTROL_CHARACTER.test(value)
}

function validMaxRules(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 4
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === 'object'
    && (error as { code?: unknown }).code === code
}

function retryDelay(attempt: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, LOCK_RETRY_DELAYS_MS[attempt] ?? 1_000))
}

function pendingKey(sessionId: string, turnId: string): string {
  return `${sessionId.length}:${sessionId}${turnId}`
}

function selectionAudit(
  prepared: PreparedTurn,
  acceptedRuleIds: readonly string[],
  assignments: readonly import('./types.js').TrialAssignment[],
): AuditEvent {
  return {
    schemaVersion: 1,
    at: prepared.selectedAt,
    kind: 'selection_observed',
    count: acceptedRuleIds.length,
    correlationHash: prepared.correlationHash,
    ruleIds: [...new Set([
      ...acceptedRuleIds,
      ...assignments.map(assignment => assignment.ruleId),
    ])],
    ...(prepared.projectScopeHash === undefined
      ? {}
      : { projectScopeHash: prepared.projectScopeHash }),
    ...(assignments[0] === undefined
      ? {}
      : { experimentArm: assignments[0].arm }),
  }
}
