import { z } from 'zod'
import { methodIdSchema, REGISTERED_METHODS, type MethodId } from './methods.js'
import { CHECKER_IDS, verificationReportSchema, type CheckerId, type VerificationReport,
  type VerificationRevision } from './verification.js'

export interface LocalArtifactRepairAuthority extends VerificationRevision {
  operation: 'local-artifact-repair'
  attemptKey: string
  methodId: MethodId
  checkerId: CheckerId
}

export interface BoundedRepairRequest {
  /** Opaque host-issued turn key, never a model-provided retry identifier. */
  attemptKey: string
  methodId: MethodId
  failedReport: VerificationReport
  authority: LocalArtifactRepairAuthority | null
  signal: AbortSignal
  /** Absolute deadline within this controller's configured retention TTL. */
  expiresAt: number
  /** Synchronous trusted snapshot; false revokes authority or marks a closed/stale turn. */
  currentRevision: () => Readonly<VerificationRevision> | false
  repair: (signal: AbortSignal) => void | Promise<void>
  recheck: (signal: AbortSignal) => unknown | Promise<unknown>
}

export interface BoundedRepairOptions {
  /** Defaults and hard maxima: 128 entries, 5 minute TTL, 30 second total timeout. */
  maxEntries?: number
  ttlMs?: number
  timeoutMs?: number
}

export type BoundedRepairStatus = 'running' | 'pass' | 'fail' | 'rejected' | 'stale'
  | 'expired' | 'cancelled' | 'timeout' | 'disposed' | 'error'
export type BoundedRepairReason = 'pending' | 'matched' | 'recheck_not_passed' | 'invalid_input'
  | 'invalid_report' | 'method_mismatch' | 'no_authority' | 'unsupported_operation' | 'authority_mismatch'
  | 'not_current' | 'source_changed' | 'artifact_unchanged' | 'count_changed' | 'duplicate_attempt'
  | 'capacity' | 'expiry_out_of_bounds' | 'repair_failed' | 'recheck_failed' | 'expired' | 'cancelled' | 'timeout' | 'disposed'

export interface BoundedRepairResult {
  readonly status: BoundedRepairStatus
  readonly reason: BoundedRepairReason
  readonly attemptKey: string | null
  readonly methodId: MethodId | null
  readonly failedReport: Readonly<VerificationReport> | null
  readonly reports: readonly Readonly<VerificationReport>[]
  /** Includes the trusted initial failure and an invoked recheck, even if it throws or is stopped. */
  readonly attempts: number
  readonly failedAttempts: number
  readonly repairAttempts: number
  readonly repaired: boolean
}

const keySchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/u)
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const revisionSchema = z.object({ bindingHash: hashSchema, sourceHash: hashSchema, artifactHash: hashSchema }).strict()
const authoritySchema = revisionSchema.extend({ operation: z.literal('local-artifact-repair'),
  attemptKey: keySchema, methodId: methodIdSchema, checkerId: z.enum(CHECKER_IDS) }).strict()
const callback = <T>() => z.custom<T>(value => typeof value === 'function')
const requestSchema = z.object({ attemptKey: keySchema, methodId: methodIdSchema,
  failedReport: z.unknown(), authority: z.unknown(), signal: z.instanceof(AbortSignal),
  expiresAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  currentRevision: callback<BoundedRepairRequest['currentRevision']>(),
  repair: callback<BoundedRepairRequest['repair']>(), recheck: callback<BoundedRepairRequest['recheck']>(),
}).strict()
const optionsSchema = z.object({ maxEntries: z.number().int().min(1).max(128).default(128),
  ttlMs: z.number().int().min(1).max(300_000).default(300_000),
  timeoutMs: z.number().int().min(1).max(30_000).default(30_000),
}).strict()

type StopStatus = 'expired' | 'cancelled' | 'timeout' | 'disposed'
interface Attempt {
  result: BoundedRepairResult
  retainUntil: number
  retainUntilTick: number
  deadline: number
  deadlineTick: number
  deadlineStatus: 'expired' | 'timeout'
  signal: AbortSignal
  controller: AbortController
  stopStatus: StopStatus | null
  stop: (status: StopStatus) => void
  interrupted: Promise<void>
  active: boolean
  pendingCallback: boolean
}

function strictReport(input: unknown): Readonly<VerificationReport> | null {
  try {
    const parsed = verificationReportSchema.safeParse(input)
    return parsed.success ? Object.freeze(parsed.data) : null
  } catch { return null }
}

function outcome(status: BoundedRepairStatus, reason: BoundedRepairReason,
  previous: Partial<BoundedRepairResult> = {}): BoundedRepairResult {
  const reports = Object.freeze([...(previous.reports ?? [])])
  return Object.freeze({ status, reason, attemptKey: previous.attemptKey ?? null,
    methodId: previous.methodId ?? null, failedReport: previous.failedReport ?? null,
    reports, attempts: previous.attempts ?? 0, repairAttempts: previous.repairAttempts ?? 0,
    failedAttempts: reports.filter(item => item.status === 'fail').length, repaired: status === 'pass' })
}

/**
 * Trusted in-process host API, not a model-callable command or an execution sandbox.
 * The host authenticates reports, scopes writes and independently rechecks its artifact.
 * Callbacks must honor AbortSignal: arbitrary JS cannot be killed or rolled back here.
 * A blocking callback delays timer delivery; its late return cannot become success.
 * Settled entries expire within TTL. Unsettled callbacks keep a bounded reservation
 * until they settle, even after timeout/disposal; capacity exhaustion rejects new work.
 * Use one controller per host scope and unique turn keys, never mint a key for a retry.
 */
export class BoundedRepairController {
  private readonly options: z.infer<typeof optionsSchema>
  private readonly entries = new Map<string, Attempt>()
  private disposed = false
  private clockWall = Date.now()
  private clockTick = performance.now()

  constructor(options: BoundedRepairOptions = {}) { this.options = optionsSchema.parse(options) }

  get size(): number { this.prune(); return this.entries.size }

  /** Immutable bounded history, including the original failure and actual check attempts. */
  getAttempt(attemptKey: string): BoundedRepairResult | null {
    this.prune()
    return this.entries.get(attemptKey)?.result ?? null
  }

  dispose(): void {
    this.disposed = true
    for (const entry of this.entries.values()) if (entry.active) entry.stop('disposed')
  }

  private now(): number {
    const tick = performance.now()
    const projected = this.clockWall + Math.floor(Math.max(0, tick - this.clockTick))
    const wall = Date.now()
    if (wall <= projected) return projected
    this.clockWall = wall
    this.clockTick = tick
    return wall
  }

  private prune(): void {
    const now = this.now(), tick = performance.now()
    for (const [key, entry] of this.entries) {
      // Non-cooperative callbacks keep their reservation, even after expiry; never overlap them.
      if (!entry.active && !entry.pendingCallback && (now >= entry.retainUntil || tick >= entry.retainUntilTick)) {
        this.entries.delete(key)
      }
    }
  }

  private finish(entry: Attempt, status: BoundedRepairStatus, reason: BoundedRepairReason): BoundedRepairResult {
    entry.result = outcome(status, reason, entry.result)
    return entry.result
  }

  private stopped(entry: Attempt): boolean {
    if (this.disposed) entry.stop('disposed')
    else if (entry.signal.aborted) entry.stop('cancelled')
    else if (this.now() >= entry.deadline || performance.now() >= entry.deadlineTick) entry.stop(entry.deadlineStatus)
    return entry.stopStatus !== null
  }

  private current(entry: Attempt, read: BoundedRepairRequest['currentRevision'],
    expectedArtifact?: Readonly<VerificationRevision>): boolean {
    if (this.stopped(entry)) return false
    let revision: VerificationRevision | null = null
    try {
      const parsed = revisionSchema.safeParse(read())
      if (parsed.success) revision = parsed.data
    } catch { /* Host snapshot failure revokes this attempt without leaking details. */ }
    if (this.stopped(entry)) return false
    const before = entry.result.failedReport!
    if (!revision) { this.finish(entry, 'stale', 'not_current'); return false }
    if (revision.sourceHash !== before.sourceHash || revision.bindingHash !== before.bindingHash) {
      this.finish(entry, 'stale', 'source_changed'); return false
    }
    if (expectedArtifact && revision.artifactHash !== expectedArtifact.artifactHash) {
      this.finish(entry, 'stale', 'not_current'); return false
    }
    return true
  }

  private async invoke<T>(entry: Attempt, phase: 'repair' | 'recheck', run: (signal: AbortSignal) => T | Promise<T>):
    Promise<{ ok: true, value: T } | { ok: false }> {
    if (this.stopped(entry)) return { ok: false }
    entry.result = outcome('running', 'pending', { ...entry.result,
      ...(phase === 'repair' ? { repairAttempts: 1 } : { attempts: 2 }) })
    entry.pendingCallback = true
    let work: Promise<T>
    try { work = Promise.resolve(run(entry.controller.signal)) }
    catch { entry.pendingCallback = false; return { ok: false } }
    // Observe both late fulfillment and rejection without resuming the repair pipeline.
    const settled = work.then(value => {
      entry.pendingCallback = false
      return { ok: true as const, value }
    }, () => {
      entry.pendingCallback = false
      return { ok: false as const }
    })
    return Promise.race([settled, entry.interrupted.then(() => ({ ok: false as const }))])
  }

  async run(request: BoundedRepairRequest): Promise<BoundedRepairResult> {
    if (this.disposed) return outcome('disposed', 'disposed')
    const parsed = requestSchema.safeParse(request)
    if (!parsed.success) return outcome('rejected', 'invalid_input')
    const input = parsed.data
    const identity = { attemptKey: input.attemptKey, methodId: input.methodId }
    const before = strictReport(input.failedReport)
    if (!before || before.status !== 'fail') return outcome('rejected', 'invalid_report', identity)
    const initial = outcome('running', 'pending', { ...identity, failedReport: before, reports: [before], attempts: 1 })
    if (input.repair === input.recheck) return outcome('rejected', 'invalid_input', initial)
    if (REGISTERED_METHODS[input.methodId].checkerId !== before.checkerId) {
      return outcome('rejected', 'method_mismatch', initial)
    }
    if (input.authority === null || input.authority === undefined) return outcome('rejected', 'no_authority', initial)
    if (typeof input.authority === 'object' && 'operation' in input.authority
      && input.authority.operation !== 'local-artifact-repair') return outcome('rejected', 'unsupported_operation', initial)
    const authority = authoritySchema.safeParse(input.authority)
    if (!authority.success || authority.data.attemptKey !== input.attemptKey || authority.data.methodId !== input.methodId
      || authority.data.checkerId !== before.checkerId || authority.data.bindingHash !== before.bindingHash
      || authority.data.sourceHash !== before.sourceHash || authority.data.artifactHash !== before.artifactHash) {
      return outcome('rejected', 'authority_mismatch', initial)
    }

    this.prune()
    const previous = this.entries.get(input.attemptKey)
    if (previous) return outcome('rejected', 'duplicate_attempt', previous.result)
    if (this.entries.size >= this.options.maxEntries) return outcome('rejected', 'capacity', initial)

    const now = this.now(), tick = performance.now(), retainUntil = now + this.options.ttlMs
    // An unchanged authority must expire before its replay reservation is evicted.
    if (input.expiresAt > retainUntil) return outcome('rejected', 'expiry_out_of_bounds', initial)
    const expiresAt = Math.min(input.expiresAt, retainUntil), timeoutAt = now + this.options.timeoutMs
    const duration = Math.max(0, Math.min(expiresAt, timeoutAt) - now)
    let interrupt!: () => void
    const interrupted = new Promise<void>(resolve => { interrupt = resolve })
    const entry: Attempt = { result: initial, retainUntil, retainUntilTick: tick + this.options.ttlMs,
      deadline: Math.min(expiresAt, timeoutAt), deadlineTick: tick + duration,
      deadlineStatus: expiresAt <= timeoutAt ? 'expired' : 'timeout', signal: input.signal,
      controller: new AbortController(), stopStatus: null, interrupted, active: true, pendingCallback: false,
      stop: status => {
        if (entry.stopStatus !== null) return
        entry.stopStatus = status
        this.finish(entry, status, status)
        entry.controller.abort(status)
        interrupt()
      } }
    // Reserve before any host callback, including synchronous/reentrant revision reads.
    this.entries.set(input.attemptKey, entry)
    const onAbort = () => entry.stop('cancelled')
    input.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => entry.stop(entry.deadlineStatus), duration)
    try {
      if (!this.current(entry, input.currentRevision, before)) return entry.result
      const repaired = await this.invoke(entry, 'repair', input.repair)
      if (this.stopped(entry)) return entry.result
      if (!repaired.ok) return this.finish(entry, 'error', 'repair_failed')
      if (!this.current(entry, input.currentRevision)) return entry.result
      const checked = await this.invoke(entry, 'recheck', input.recheck)
      if (this.stopped(entry)) return entry.result
      if (!checked.ok) return this.finish(entry, 'error', 'recheck_failed')
      const final = strictReport(checked.value)
      if (this.stopped(entry)) return entry.result
      if (!final) return this.finish(entry, 'error', 'invalid_report')
      entry.result = outcome('running', 'pending', { ...entry.result, reports: [before, final] })
      if (final.checkerId !== before.checkerId) return this.finish(entry, 'rejected', 'method_mismatch')
      if (final.sourceHash !== before.sourceHash || final.bindingHash !== before.bindingHash) {
        return this.finish(entry, 'stale', 'source_changed')
      }
      if (!this.current(entry, input.currentRevision, final)) return entry.result
      if (final.status !== 'pass') return this.finish(entry, 'fail', 'recheck_not_passed')
      if (final.artifactHash === before.artifactHash) return this.finish(entry, 'stale', 'artifact_unchanged')
      if (final.checked !== before.checked) return this.finish(entry, 'stale', 'count_changed')
      return this.finish(entry, 'pass', 'matched')
    } finally {
      entry.active = false
      clearTimeout(timer)
      input.signal.removeEventListener('abort', onAbort)
    }
  }
}
