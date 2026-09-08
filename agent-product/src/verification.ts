import { createHash } from 'node:crypto'
import { z } from 'zod'
import { EXPERIENCE_CONSTRAINT_IDS, type EvolutionRule, type ExperienceConstraintId } from './types.js'

export const CHECKER_IDS = ['missing-values-v1', 'source-dates-v1', 'exit-status-v1', 'regression-test-v1'] as const
export type CheckerId = typeof CHECKER_IDS[number]
export const CHECK_STATUSES = ['pass', 'fail', 'insufficient_evidence', 'unsupported', 'stale', 'error'] as const
export const CHECK_REASONS = ['matched', 'missing_value_filled', 'source_value_changed', 'identity_mismatch',
  'empty_input', 'invalid_input', 'exit_failed', 'exit_unavailable', 'test_failed', 'test_unbound',
  'suite_changed', 'no_tests', 'artifact_changed', 'not_observed', 'checker_unavailable', 'attempt_limit',
  'binding_changed', 'cancelled'] as const
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const count = z.number().int().min(0).max(1_000)
export const verificationReportSchema = z.object({
  schemaVersion: z.literal(1), checkerId: z.enum(CHECKER_IDS), bindingHash: hashSchema,
  sourceHash: hashSchema, artifactHash: hashSchema, status: z.enum(CHECK_STATUSES),
  reason: z.enum(CHECK_REASONS), checked: count, violations: count,
}).strict().superRefine((r, ctx) => {
  const validReasons = {
    pass: ['matched'], fail: ['missing_value_filled', 'source_value_changed', 'exit_failed', 'test_failed'],
    insufficient_evidence: ['identity_mismatch', 'empty_input', 'exit_unavailable', 'test_unbound', 'no_tests', 'not_observed', 'attempt_limit'],
    unsupported: ['checker_unavailable', 'test_unbound'], stale: ['artifact_changed', 'suite_changed', 'binding_changed'],
    error: ['invalid_input', 'checker_unavailable', 'cancelled'],
  }
  const checkerReasons = {
    'missing-values-v1': ['missing_value_filled'], 'source-dates-v1': ['source_value_changed'],
    'exit-status-v1': ['exit_failed'], 'regression-test-v1': ['test_failed'],
  }
  if (!validReasons[r.status].includes(r.reason) || r.violations > r.checked
    || (r.status === 'pass' && (r.checked === 0 || r.violations !== 0))
    || (r.status === 'fail' && (r.violations === 0 || !checkerReasons[r.checkerId].includes(r.reason)))
    || (!['pass', 'fail'].includes(r.status) && r.violations !== 0)
    || r.bindingHash !== digest(`${r.checkerId}:${r.sourceHash}`)) {
    ctx.addIssue({ code: 'custom', message: 'inconsistent_verification_report' })
  }
})
export type VerificationReport = z.infer<typeof verificationReportSchema>
export interface VerificationRow { id: string, value: string | number | boolean | null }
export const verificationRowsSchema = z.array(z.object({ id: z.string().min(1).max(128).refine(value => value.isWellFormed()),
  value: z.union([z.string().max(256).refine(value => value.isWellFormed()), z.number().finite(), z.boolean(), z.null()]),
}).strict()).max(1_000).refine(rows => new Set(rows.map(row => row.id)).size === rows.length)

export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function rowHash(rows: readonly VerificationRow[]): string {
  const tagged = (value: VerificationRow['value']): string[] => {
    if (value === null) return ['null']
    if (typeof value === 'number') {
      const bytes = Buffer.alloc(8)
      bytes.writeDoubleBE(Object.is(value, -0) ? 0 : value)
      return ['number', bytes.toString('hex')]
    }
    return [typeof value, String(value)]
  }
  return digest(JSON.stringify([...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map(row => [row.id, tagged(row.value)])))
}

export function report(checkerId: CheckerId, status: VerificationReport['status'], reason: VerificationReport['reason'],
  checked = 0, violations = 0, sourceHash = digest('unavailable'), artifactHash = digest('unavailable')): VerificationReport {
  return { schemaVersion: 1, checkerId, bindingHash: digest(`${checkerId}:${sourceHash}`), sourceHash,
    artifactHash, status, reason, checked, violations }
}

function validDate(value: VerificationRow['value']): boolean {
  if (value === null) return true
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || value.startsWith('0000')) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function checkRows(checkerId: 'missing-values-v1' | 'source-dates-v1', source: unknown, artifact: unknown): VerificationReport {
  const a = verificationRowsSchema.safeParse(source), b = verificationRowsSchema.safeParse(artifact)
  if (!a.success || !b.success) return report(checkerId, 'error', 'invalid_input')
  const sourceHash = rowHash(a.data), artifactHash = rowHash(b.data)
  const result = (status: VerificationReport['status'], reason: VerificationReport['reason'], checked = 0, violations = 0) =>
    report(checkerId, status, reason, checked, violations, sourceHash, artifactHash)
  if (checkerId === 'source-dates-v1' && [...a.data, ...b.data].some(row => !validDate(row.value))) {
    return result('error', 'invalid_input')
  }
  if (a.data.length === 0 || b.data.length === 0) return result('insufficient_evidence', 'empty_input')
  const target = new Map(b.data.map(row => [row.id, row.value]))
  if (a.data.length !== b.data.length || a.data.some(row => !target.has(row.id))) {
    return result('insufficient_evidence', 'identity_mismatch')
  }
  const violations = a.data.filter(row => checkerId === 'missing-values-v1'
    ? row.value === null && target.get(row.id) !== null
    : row.value !== target.get(row.id)).length
  return result(violations === 0 ? 'pass' : 'fail', violations === 0 ? 'matched'
    : checkerId === 'missing-values-v1' ? 'missing_value_filled' : 'source_value_changed', a.data.length, violations)
}

export function checkExitStatus(codes: readonly (number | null)[]): VerificationReport {
  if (codes.length > 1_000 || codes.some(code => code !== null && !Number.isSafeInteger(code))) {
    return report('exit-status-v1', 'error', 'invalid_input')
  }
  const sourceHash = digest('native-exit-status-v1'), artifactHash = digest(JSON.stringify(codes))
  if (codes.length === 0 || codes.includes(null)) return report('exit-status-v1', 'insufficient_evidence', 'exit_unavailable', 0, 0, sourceHash, artifactHash)
  const failures = codes.filter(code => code !== 0).length
  return report('exit-status-v1', failures ? 'fail' : 'pass', failures ? 'exit_failed' : 'matched', codes.length, failures, sourceHash, artifactHash)
}

export interface VerificationPlan {
  ruleId: string
  instructionHash: string
  constraintId: ExperienceConstraintId
  checkerId: CheckerId | null
}
export interface VerificationEntry extends VerificationPlan {
  /** Hashed scope captured from the accepted rule, never inferred during maintenance. */
  scope?: import('./types.js').ExperienceScope
  observations: VerificationReport[]
  invalidated: boolean
  limitReached: boolean
}
export interface VerificationResult extends VerificationPlan {
  status: VerificationReport['status']
  attempts: number
  failedAttempts: number
  repaired: boolean
  firstPass: boolean
}
export interface VerificationRevision { bindingHash: string, sourceHash: string, artifactHash: string }

export function checkerFor(constraintId: ExperienceConstraintId): CheckerId | null {
  if (constraintId === 'preserve_unknown_values') return 'missing-values-v1'
  if (constraintId === 'source_timestamp_required') return 'source-dates-v1'
  if (constraintId === 'exit_status_required') return 'exit-status-v1'
  return null
}

export function verificationPlans(rules: readonly EvolutionRule[]): VerificationPlan[] {
  return rules.filter(rule => rule.status === 'guardrail' && rule.correctionLesson !== undefined)
    .flatMap(rule => (rule.constraintIds ?? []).map(constraintId => ({ ruleId: rule.id,
      instructionHash: rule.instructionHash, constraintId, checkerId: checkerFor(constraintId) }))).slice(0, 24)
}

export function observeCheck(entries: VerificationEntry[], input: unknown): boolean {
  const parsed = verificationReportSchema.safeParse(input)
  if (!parsed.success || parsed.data.checkerId === 'regression-test-v1') return false
  let accepted = false
  for (const entry of entries) {
    if (entry.checkerId !== parsed.data.checkerId) continue
    if (entry.observations.length >= 2) { entry.limitReached = true; continue }
    const first = entry.observations[0]
    if (first && first.bindingHash !== parsed.data.bindingHash) { entry.invalidated = true; continue }
    entry.observations.push({ ...parsed.data })
    entry.invalidated = false
    accepted = true
  }
  return accepted
}

export function settleChecks(entries: readonly VerificationEntry[], revisions: readonly VerificationRevision[] = []): VerificationResult[] {
  return entries.map(entry => {
    const last = entry.observations.at(-1)
    let status: VerificationReport['status'] = entry.checkerId === null ? 'unsupported'
      : last?.status ?? 'insufficient_evidence'
    if (entry.invalidated) status = 'stale'
    else if (entry.limitReached) status = 'insufficient_evidence'
    else if (last && entry.checkerId !== 'exit-status-v1' && ['pass', 'fail'].includes(last.status)
      && !revisions.some(revision => revision.bindingHash === last.bindingHash
        && revision.sourceHash === last.sourceHash && revision.artifactHash === last.artifactHash)) status = 'stale'
    const failedAttempts = entry.observations.filter(item => item.status === 'fail').length
    return { ruleId: entry.ruleId, instructionHash: entry.instructionHash, constraintId: entry.constraintId,
      checkerId: entry.checkerId, status, attempts: entry.observations.length, failedAttempts,
      repaired: status === 'pass' && failedAttempts > 0,
      firstPass: status === 'pass' && entry.observations.length === 1 }
  })
}

const counter = z.number().int().min(0).max(1_000_000_000)
export const verificationCountersSchema = z.object({ plans: counter, passed: counter, failed: counter,
  insufficient: counter, unsupported: counter, stale: counter, errors: counter, attempts: counter,
  failedAttempts: counter, repaired: counter, firstPass: counter, lastPassedAt: z.number().int().min(0).nullable(),
}).strict().refine(c => c.passed + c.failed + c.insufficient + c.unsupported + c.stale + c.errors === c.plans
  && c.firstPass + c.repaired <= c.passed && c.attempts <= c.plans * 2 && c.failedAttempts <= c.attempts
  && c.passed <= c.attempts && c.failed <= c.failedAttempts
  && c.repaired <= c.failedAttempts && (c.passed === 0) === (c.lastPassedAt === null))
export type VerificationCounters = z.infer<typeof verificationCountersSchema>
export const verificationResultSchema = z.object({ ruleId: z.string().regex(/^rule_[a-z0-9_]{1,96}$/u),
  instructionHash: hashSchema, constraintId: z.enum(EXPERIENCE_CONSTRAINT_IDS), checkerId: z.enum(CHECKER_IDS).nullable(),
  status: z.enum(CHECK_STATUSES), attempts: z.number().int().min(0).max(2),
  failedAttempts: z.number().int().min(0).max(2), repaired: z.boolean(), firstPass: z.boolean(),
}).strict().refine(r => r.checkerId === checkerFor(r.constraintId) && r.failedAttempts <= r.attempts
  && (r.checkerId !== null || (r.status === 'unsupported' && r.attempts === 0))
  && (r.status !== 'fail' || (r.checkerId !== null && r.attempts > 0 && r.failedAttempts > 0))
  && r.repaired === (r.status === 'pass' && r.failedAttempts > 0)
  && r.firstPass === (r.status === 'pass' && r.attempts === 1)
  && (r.status !== 'pass' || (r.checkerId !== null && r.attempts > 0 && r.failedAttempts < r.attempts)))

export function addVerificationResult(previous: VerificationCounters | undefined, result: VerificationResult, at: number): VerificationCounters {
  const next: VerificationCounters = { plans: 0, passed: 0, failed: 0, insufficient: 0, unsupported: 0,
    stale: 0, errors: 0, attempts: 0, failedAttempts: 0, repaired: 0, firstPass: 0, lastPassedAt: null, ...previous }
  const key = { pass: 'passed', fail: 'failed', insufficient_evidence: 'insufficient', unsupported: 'unsupported', stale: 'stale', error: 'errors' } as const
  if (next.plans >= 499_999_999) return next
  next.plans += 1
  next[key[result.status]] += 1
  next.attempts += result.attempts
  next.failedAttempts += result.failedAttempts
  if (result.repaired) next.repaired += 1
  if (result.firstPass) next.firstPass += 1
  if (result.status === 'pass') next.lastPassedAt = Math.max(next.lastPassedAt ?? 0, at)
  return next
}
