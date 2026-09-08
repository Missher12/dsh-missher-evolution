import { z } from 'zod'
import { digest, verificationReportSchema, verificationResultSchema,
  type VerificationReport, type VerificationEntry, type VerificationResult } from './verification.js'
import type { EvolutionRule, EvolutionState, ExperienceScope } from './types.js'
import { METHOD_IDS, methodIdSchema, REGISTERED_METHODS, type MethodId } from './methods.js'
import { evaluateRegisteredMethod, type MethodEvaluation } from './method-evaluator.js'
import { scopeForInstance, scopeForProject } from './experience.js'
export * from './methods.js'
export * from './method-evaluator.js'

export const CASE_TTL_MS = 90 * 86_400_000
export const MAX_CASES_PER_RULE = 8
export const MAX_TOTAL_CASES = 256
const LEARNING_STATE_TARGET_BYTES = 960 * 1024
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const timestamp = z.number().int().nonnegative().safe()
const count = z.number().int().min(0).max(1000)
const localScope = z.object({ kind: z.enum(['project', 'instance']), keyHash: hash }).strict()
export const learningCaseSchema = z.object({
  schemaVersion: z.literal(1), caseId: hash,
  scope: localScope,
  ruleId: z.string().regex(/^rule_[a-z0-9_]{1,96}$/u), instructionHash: hash, taskHash: hash,
  checkerId: z.enum(['missing-values-v1', 'source-dates-v1']),
  constraintId: z.enum(['preserve_unknown_values', 'source_timestamp_required']),
  bindingHash: hash, sourceHash: hash, recordedAt: timestamp,
  failure: z.object({ artifactHash: hash, reason: z.enum(['missing_value_filled', 'source_value_changed']),
    checked: count, violations: count, attempt: z.union([z.literal(1), z.literal(2)]), }).strict(),
  repair: z.object({ artifactHash: hash, reason: z.literal('matched'), checked: count,
    violations: z.literal(0), attempt: z.literal(2) }).strict().nullable(),
}).strict().refine(c => c.checkerId === (c.constraintId === 'preserve_unknown_values' ? 'missing-values-v1' : 'source-dates-v1')
  && c.failure.reason === (c.checkerId === 'missing-values-v1' ? 'missing_value_filled' : 'source_value_changed')
  && c.bindingHash === digest(`${c.checkerId}:${c.sourceHash}`)
  && c.caseId === caseIdentity(c)
  && c.failure.violations > 0 && c.failure.violations <= c.failure.checked
  && (c.repair === null || (c.failure.attempt === 1 && c.repair.artifactHash !== c.failure.artifactHash
    && c.repair.checked === c.failure.checked)))
export type LearningCase = z.infer<typeof learningCaseSchema>
const evaluationSchema = z.object({ evaluatorVersion: z.literal('registered-heldout-v1'), methodVersion: z.literal(1),
  caseCount: count, failureCases: count, correctCases: count, nonApplicableCases: count,
  baselineViolations: count, candidateViolations: count, falseChanges: count, regressions: count, scopeLeaks: count,
  accepted: z.literal(true) }).strict()
export const validatedMethodSchema = z.object({ methodId: methodIdSchema, caseId: hash, instructionHash: hash,
  evidenceEpoch: hash, origin: z.enum(['ai', 'deterministic', 'import']), status: z.literal('validated'),
  validatedAt: timestamp, evaluation: evaluationSchema }).strict().refine(m => sameEvaluation(m.evaluation, evaluateRegisteredMethod(m.methodId)))
export type ValidatedMethod = z.infer<typeof validatedMethodSchema>
export const ruleImprovementSchema = z.object({ cases: z.array(learningCaseSchema).max(MAX_CASES_PER_RULE)
  .refine(cases => new Set(cases.map(c => c.caseId)).size === cases.length),
  methods: z.array(validatedMethodSchema).max(METHOD_IDS.length)
    .refine(methods => new Set(methods.map(m => m.methodId)).size === methods.length).optional(),
}).strict()
export type RuleImprovement = z.infer<typeof ruleImprovementSchema>

export const methodProposalSchema = z.object({ action: z.literal('propose'),
  ruleId: z.string().regex(/^rule_[a-z0-9_]{1,96}$/u), caseId: hash, methodId: methodIdSchema,
  checkerId: z.enum(['missing-values-v1', 'source-dates-v1']),
  constraintId: z.enum(['preserve_unknown_values', 'source_timestamp_required']),
}).strict().refine(p => p.checkerId === REGISTERED_METHODS[p.methodId].checkerId
  && p.constraintId === REGISTERED_METHODS[p.methodId].constraintId)
export type MethodProposal = z.infer<typeof methodProposalSchema>
export const methodDecisionSchema = z.union([methodProposalSchema, z.object({ action: z.literal('abstain') }).strict()])
export type MethodDecision = z.infer<typeof methodDecisionSchema>
export interface MethodOffer { case: LearningCase, methodId: MethodId, evidenceEpoch: string }
export interface MethodSelection { proposal: MethodProposal, origin: ValidatedMethod['origin'], expectedEpoch?: string }

export const portableMethodsSchema = z.object({ format: z.literal('mse-methods'), schemaVersion: z.literal(1),
  methods: z.array(methodIdSchema).max(16).refine(ids => new Set(ids).size === ids.length) }).strict()
export type PortableMethods = z.infer<typeof portableMethodsSchema>
export const methodTargetSchema = z.object({ kind: z.enum(['project', 'instance']),
  key: z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/u).refine(key => key.trim() === key) }).strict()
export type MethodTarget = z.infer<typeof methodTargetSchema>
export const importedMethodSchema = z.object({ methodId: methodIdSchema, status: z.literal('candidate'), importedAt: timestamp,
  scope: localScope }).strict()
export type ImportedMethod = z.infer<typeof importedMethodSchema>
export const importedMethodsSchema = z.array(importedMethodSchema).max(16)
  .refine(items => new Set(items.map(item => `${item.scope.kind}:${item.scope.keyHash}:${item.methodId}`)).size === items.length)

function targetScope(target: MethodTarget): ExperienceScope {
  const parsed = methodTargetSchema.parse(target)
  return parsed.kind === 'project' ? scopeForProject(parsed.key) : scopeForInstance(parsed.key)
}

function sameScope(a: ExperienceScope | undefined, b: ExperienceScope): boolean {
  return a?.kind === b.kind && a.keyHash === b.keyHash
}

export function importMethods(input: EvolutionState, document: unknown, target: MethodTarget, now: number): { state: EvolutionState, imported: number } {
  const portable = portableMethodsSchema.parse(document), scope = targetScope(target)
  timestamp.parse(now)
  const state = structuredClone(input)
  const existing = importedMethodsSchema.parse(state.importedMethods ?? [])
  const added = portable.methods.filter(methodId => !existing.some(item => item.methodId === methodId && sameScope(item.scope, scope)))
    .map(methodId => importedMethodSchema.parse({ methodId, scope, status: 'candidate', importedAt: now }))
  if (existing.length + added.length > 16) throw new Error('method_capacity')
  if (added.length) {
    state.importedMethods = [...existing, ...added]
    state.updatedAt = Math.max(state.updatedAt, now)
  }
  return { state, imported: added.length }
}

export function exportMethods(state: EvolutionState, target: MethodTarget): PortableMethods {
  const scope = targetScope(target)
  const known = new Set<MethodId>([...(state.importedMethods ?? []).filter(m => sameScope(m.scope, scope)).map(m => m.methodId),
    ...state.rules.filter(rule => sameScope(rule.scope, scope)).flatMap(rule => (rule.improvement?.methods ?? [])
      .filter(m => isMethodCurrent(rule, m, state.updatedAt)).map(m => m.methodId))])
  return portableMethodsSchema.parse({ format: 'mse-methods', schemaVersion: 1, methods: METHOD_IDS.filter(id => known.has(id)) })
}

function sameEvaluation(left: MethodEvaluation, right: MethodEvaluation): boolean {
  return (Object.keys(right) as (keyof MethodEvaluation)[]).every(key => left[key] === right[key])
}

export function methodEvidenceEpoch(rule: Pick<EvolutionRule, 'instructionHash' | 'improvement'>
  & { scope?: ExperienceScope | undefined }, methodId: MethodId, caseId: string): string {
  const supporting = (rule.improvement?.cases ?? []).find(c => c.caseId === caseId)
  return digest(JSON.stringify([rule.instructionHash, rule.scope, methodId, REGISTERED_METHODS[methodId].version,
    'registered-heldout-v1', supporting ?? null]))
}

export function isMethodCurrent(rule: Pick<EvolutionRule, 'status' | 'expiresAt' | 'instruction' | 'instructionHash' | 'improvement'>
  & { scope?: ExperienceScope | undefined }, method: ValidatedMethod, now: number): boolean {
  const valid = validatedMethodSchema.safeParse(method)
  if (!valid.success || rule.status !== 'guardrail' || !rule.scope || rule.scope.kind === 'global'
    || rule.instructionHash !== digest(rule.instruction)
    || rule.expiresAt === null || rule.expiresAt <= now || method.validatedAt > now) return false
  return method.instructionHash === rule.instructionHash && method.evidenceEpoch === methodEvidenceEpoch(rule, method.methodId, method.caseId)
    && (rule.improvement?.cases ?? []).some(c => c.caseId === method.caseId && c.instructionHash === rule.instructionHash
      && sameScope(c.scope, rule.scope!)
      && c.recordedAt > now - CASE_TTL_MS && c.recordedAt <= method.validatedAt
      && c.constraintId === REGISTERED_METHODS[method.methodId].constraintId)
}

export function methodOffers(rules: readonly EvolutionRule[], now: number): MethodOffer[] {
  const offers: MethodOffer[] = []
  for (const input of rules) {
    const rule = structuredClone(input)
    retainRuleCases(rule, [], now)
    if (!rule.improvement || rule.instructionHash !== digest(rule.instruction)) continue
    for (const methodId of METHOD_IDS) {
      if (rule.improvement.methods?.some(m => m.methodId === methodId && isMethodCurrent(rule, m, now))) continue
      const evidence = rule.improvement.cases.filter(c => c.constraintId === REGISTERED_METHODS[methodId].constraintId)
        .sort((a, b) => Number(b.repair !== null) - Number(a.repair !== null) || b.recordedAt - a.recordedAt || a.caseId.localeCompare(b.caseId))[0]
      if (evidence) offers.push({ case: evidence, methodId, evidenceEpoch: methodEvidenceEpoch(rule, methodId, evidence.caseId) })
    }
  }
  return offers.sort((a, b) => a.case.recordedAt - b.case.recordedAt || a.case.caseId.localeCompare(b.case.caseId)).slice(0, 4)
}

export function offeredMethodProposal(proposal: MethodProposal, offers: readonly MethodOffer[]): MethodOffer | undefined {
  const parsed = methodProposalSchema.safeParse(proposal)
  return parsed.success ? offers.find(o => o.case.caseId === proposal.caseId && o.case.ruleId === proposal.ruleId
    && o.methodId === proposal.methodId && o.case.checkerId === proposal.checkerId && o.case.constraintId === proposal.constraintId) : undefined
}

/** At most one method selection per existing maintenance pass. No status/counter promotion. */
export function maintainImprovements(state: EvolutionState, now: number, selection?: MethodSelection | null): void {
  for (const rule of state.rules) retainRuleCases(rule, [], now)
  if (selection === null) return
  const offers = methodOffers(state.rules, now)
  const offer = selection === undefined ? offers[0] : offeredMethodProposal(selection.proposal, offers)
  if (!offer || (selection?.expectedEpoch !== undefined && offer.evidenceEpoch !== selection.expectedEpoch)) return
  const rule = state.rules.find(r => r.id === offer.case.ruleId)!
  const evaluation = evaluateRegisteredMethod(offer.methodId)
  if (!evaluation.accepted) return
  const imported = (state.importedMethods ?? []).some(m => m.methodId === offer.methodId && sameScope(rule.scope, m.scope))
  const method = validatedMethodSchema.parse({ methodId: offer.methodId, caseId: offer.case.caseId,
    instructionHash: rule.instructionHash, evidenceEpoch: offer.evidenceEpoch, origin: selection?.origin ?? (imported ? 'import' : 'deterministic'),
    status: 'validated', validatedAt: now, evaluation })
  rule.improvement!.methods = [...(rule.improvement!.methods ?? []).filter(m => m.methodId !== method.methodId), method]
}

export function methodGuidanceForRule(rule: EvolutionRule, now: number): string {
  return (rule.improvement?.methods ?? []).filter(m => isMethodCurrent(rule, m, now))
    .map(m => REGISTERED_METHODS[m.methodId].procedure).join(' ')
}

/** Evict only derived cases/methods, never legacy rules or malformed state. */
export function enforceImprovementBudget(state: EvolutionState): void {
  let ordered = state.rules.flatMap(rule => (rule.improvement?.cases ?? []).map(c => ({ rule, c })))
    .sort((a, b) => a.c.recordedAt - b.c.recordedAt || a.c.caseId.localeCompare(b.c.caseId))
  const evict = (amount: number) => {
    const affected = new Set<EvolutionRule>()
    for (const { rule, c } of ordered.splice(0, amount)) {
      rule.improvement!.cases = rule.improvement!.cases.filter(item => item.caseId !== c.caseId)
      affected.add(rule)
    }
    for (const rule of affected) {
      if (rule.improvement!.cases.length === 0) delete rule.improvement
      else if (rule.improvement!.methods) rule.improvement!.methods = rule.improvement!.methods
        .filter(m => rule.improvement!.cases.some(c => c.caseId === m.caseId))
    }
  }
  if (ordered.length > MAX_TOTAL_CASES) evict(ordered.length - MAX_TOTAL_CASES)
  let bytes = Buffer.byteLength(JSON.stringify(state, null, 2), 'utf8') + 1
  while (bytes > LEARNING_STATE_TARGET_BYTES && ordered.length > 0) {
    evict(Math.min(ordered.length, Math.max(1, Math.ceil((bytes - LEARNING_STATE_TARGET_BYTES) / 512))))
    bytes = Buffer.byteLength(JSON.stringify(state, null, 2), 'utf8') + 1
  }
}

function caseIdentity(c: { ruleId: string, instructionHash: string, taskHash: string, constraintId: string }): string {
  return digest(JSON.stringify([c.ruleId, c.instructionHash, c.taskHash, c.constraintId]))
}

/** Called only after settlement of accepted host plans with a final matching revision. */
export function collectVerificationCases(entries: readonly VerificationEntry[], results: readonly VerificationResult[],
  taskHash: string, recordedAt: number): LearningCase[] {
  const cases: LearningCase[] = []
  for (const entry of entries.slice(0, 24)) {
    if (entry.invalidated || entry.limitReached || entry.observations.length > 2) continue
    const settled = results.find(r => r.ruleId === entry.ruleId && r.instructionHash === entry.instructionHash
      && r.constraintId === entry.constraintId && r.checkerId === entry.checkerId)
    if (!verificationResultSchema.safeParse(settled).success || !settled || !['pass', 'fail'].includes(settled.status)) continue
    const observed = entry.observations.map(r => verificationReportSchema.safeParse(r))
    if (observed.some(r => !r.success)) continue
    const failureIndex = entry.observations.at(-1)?.status === 'fail' ? entry.observations.length - 1
      : entry.observations.findIndex(r => r.status === 'fail')
    const failure = entry.observations[failureIndex], final = entry.observations.at(-1)
    if (!failure || !final || final.status !== settled.status || failure.checkerId !== entry.checkerId
      || entry.observations.some(r => r.checkerId !== entry.checkerId || r.bindingHash !== failure.bindingHash
        || r.sourceHash !== failure.sourceHash) || !['pass', 'fail'].includes(final.status)) continue
    const candidate = { schemaVersion: 1, ...entry, taskHash, recordedAt,
      caseId: caseIdentity({ ...entry, taskHash }), bindingHash: failure.bindingHash, sourceHash: failure.sourceHash,
      failure: { artifactHash: failure.artifactHash, reason: failure.reason, checked: failure.checked,
        violations: failure.violations, attempt: failureIndex + 1 },
      repair: final.status === 'pass' ? { artifactHash: final.artifactHash, reason: final.reason,
        checked: final.checked, violations: final.violations, attempt: entry.observations.length } : null }
    const { observations: _observations, invalidated: _invalidated, limitReached: _limitReached, ...data } = candidate
    const parsed = learningCaseSchema.safeParse(data)
    if (parsed.success) cases.push(parsed.data)
  }
  return cases
}

export function retainRuleCases(rule: EvolutionRule, incoming: readonly LearningCase[], now: number): void {
  if (rule.status !== 'guardrail' || !rule.correctionLesson || !rule.scope || rule.scope.kind === 'global'
    || rule.instructionHash !== digest(rule.instruction)
    || rule.expiresAt === null || rule.expiresAt <= now) {
    delete rule.improvement
    return
  }
  const valid = new Map<string, LearningCase>()
  for (const raw of [...(rule.improvement?.cases ?? []), ...incoming]) {
    const parsed = learningCaseSchema.safeParse(raw)
    if (!parsed.success) continue
    const c = parsed.data
    if (c.ruleId !== rule.id || c.instructionHash !== rule.instructionHash || !(rule.constraintIds ?? []).includes(c.constraintId)
      || !sameScope(rule.scope, c.scope)
      || c.recordedAt <= now - CASE_TTL_MS || c.recordedAt > now || c.recordedAt < rule.createdAt) continue
    if (!valid.has(c.caseId)) valid.set(c.caseId, c)
  }
  const cases = [...valid.values()].sort((a, b) => a.recordedAt - b.recordedAt || a.caseId.localeCompare(b.caseId)).slice(-MAX_CASES_PER_RULE)
  if (cases.length) rule.improvement = { ...rule.improvement, cases }
  else delete rule.improvement
  if (rule.improvement?.methods) rule.improvement.methods = rule.improvement.methods.filter(m => isMethodCurrent(rule, m, now))
}

export function methodDiagnostics(state: EvolutionState) {
  const cases = state.rules.flatMap(rule => rule.improvement?.cases ?? [])
  const methods = state.rules.flatMap(rule => (rule.improvement?.methods ?? []).filter(m => isMethodCurrent(rule, m, state.updatedAt)))
  const importedCandidates = (state.importedMethods ?? []).filter(item => !state.rules.some(rule => sameScope(rule.scope, item.scope)
    && rule.improvement?.methods?.some(m => m.methodId === item.methodId && isMethodCurrent(rule, m, state.updatedAt)))).length
  return { cases: cases.length, repairedCases: cases.filter(c => c.repair !== null).length,
    validatedMethods: methods.length, importedCandidates, aiProposals: methods.filter(m => m.origin === 'ai').length }
}

/** Trusted host reports only. This hint grants no tool authority or delivery gate. */
export function buildRepairGuidance(report: VerificationReport): string | null {
  const parsed = verificationReportSchema.safeParse(report)
  if (!parsed.success || parsed.data.status !== 'fail') return null
  const action = parsed.data.checkerId === 'missing-values-v1'
    ? '将来源未知的对应字段恢复为空值'
    : parsed.data.checkerId === 'source-dates-v1'
      ? '按原始来源复制对应发布时间，来源为空时保留空值' : null
  return action === null ? null
    : `仅在用户已有授权范围内，对当前产物进行一次最小修复：${action}。保留原始来源和无关字段，不扩大操作范围，不重放外部副作用；随后通过原生检查器重新核验（recheck）。若已取消、授权不足或无法核验，停止修复并如实报告，不得自行宣称通过。`
}
