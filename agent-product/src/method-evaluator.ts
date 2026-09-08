import { applyRegisteredMethod, methodIdSchema, REGISTERED_METHODS, type MethodId } from './methods.js'
import { checkRows, type VerificationRow } from './verification.js'

export interface MethodEvaluation {
  evaluatorVersion: 'registered-heldout-v1'
  methodVersion: 1
  caseCount: number
  failureCases: number
  correctCases: number
  nonApplicableCases: number
  baselineViolations: number
  candidateViolations: number
  falseChanges: number
  regressions: number
  scopeLeaks: number
  accepted: boolean
}

interface HeldOutCase { kind: 'failure' | 'correct' | 'non_applicable', source: VerificationRow[], artifact: VerificationRow[] }

// Private fixed fixtures. Proposers receive case summaries, never these observations.
function heldOut(method: MethodId): HeldOutCase[] {
  const dates = method === 'copy-source-date-v1'
  return [
    { kind: 'failure', source: [{ id: 'a', value: dates ? '2000-02-29' : null }, { id: 'b', value: dates ? '2001-01-02' : 7 }],
      artifact: [{ id: 'b', value: dates ? '2001-01-02' : 99 }, { id: 'a', value: dates ? '2000-03-01' : 0 }] },
    { kind: 'failure', source: [{ id: 'a', value: null }, { id: 'b', value: dates ? '1999-12-31' : null }],
      artifact: [{ id: 'a', value: dates ? '2002-01-01' : false }, { id: 'b', value: dates ? null : 'unknown' }] },
    { kind: 'correct', source: [{ id: 'a', value: null }], artifact: [{ id: 'a', value: null }] },
    { kind: 'correct', source: [{ id: 'a', value: dates ? '2024-02-29' : false }], artifact: [{ id: 'a', value: dates ? '2024-02-29' : 18 }] },
    { kind: 'non_applicable', source: [{ id: 'a', value: null }], artifact: [{ id: 'b', value: dates ? '2000-01-01' : 4 }] },
    { kind: 'non_applicable', source: [], artifact: [] },
    { kind: 'non_applicable', source: [{ id: 'a', value: null }], artifact: [{ id: 'a', value: null }, { id: 'a', value: null }] },
  ]
}

/** Same unchanged baseline and candidate checker. No caller-supplied scores or test cases. */
export function evaluateRegisteredMethod(methodId: MethodId): MethodEvaluation {
  const method = REGISTERED_METHODS[methodIdSchema.parse(methodId)]
  const result: MethodEvaluation = { evaluatorVersion: 'registered-heldout-v1', methodVersion: 1,
    caseCount: 0, failureCases: 0, correctCases: 0, nonApplicableCases: 0,
    baselineViolations: 0, candidateViolations: 0, falseChanges: 0, regressions: 0, scopeLeaks: 0, accepted: false }
  for (const item of heldOut(methodId)) {
    const sourceBefore = JSON.stringify(item.source), artifactBefore = JSON.stringify(item.artifact)
    const baseline = checkRows(method.checkerId, item.source, item.artifact)
    const applied = applyRegisteredMethod(methodId, item.source, item.artifact)
    const candidate = checkRows(method.checkerId, item.source, applied.artifact ?? item.artifact)
    result.caseCount += 1
    result[item.kind === 'failure' ? 'failureCases' : item.kind === 'correct' ? 'correctCases' : 'nonApplicableCases'] += 1
    result.baselineViolations += baseline.violations
    result.candidateViolations += candidate.violations
    if (candidate.violations > baseline.violations || (baseline.status === 'pass' && candidate.status !== 'pass')
      || (item.kind === 'failure' && candidate.status !== 'pass')) result.regressions += 1
    if (item.kind !== 'failure' && JSON.stringify(applied.artifact ?? item.artifact) !== artifactBefore) result.falseChanges += 1
    const values = new Map(item.source.map(row => [row.id, row.value]))
    if (JSON.stringify(item.source) !== sourceBefore || JSON.stringify(item.artifact) !== artifactBefore
      || (applied.artifact !== null && (applied.artifact.length !== item.artifact.length
        || applied.artifact.some((row, i) => row.id !== item.artifact[i]?.id
          || (methodId === 'preserve-null-v1' && values.get(row.id) !== null && row.value !== item.artifact[i]?.value))))) {
      result.scopeLeaks += 1
    }
  }
  result.accepted = result.baselineViolations > result.candidateViolations && result.regressions === 0
    && result.falseChanges === 0 && result.scopeLeaks === 0
  return result
}
