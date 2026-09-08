import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { applyRegisteredMethod, type MethodId } from '../agent-product/src/methods.js'
import { evaluateRegisteredMethod } from '../agent-product/src/method-evaluator.js'
import type { VerificationRow } from '../agent-product/src/verification.js'

const root = resolve(import.meta.dirname, '..')
const fixture = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/integrated-method-cases.json'), 'utf8')) as {
  cases: Array<{ id: string, methodId: MethodId, source: VerificationRow[], artifact: VerificationRow[], expected: VerificationRow[] }>
}

describe('independent integrated method contract', () => {
  test('bundled core matches the versioned independent golden cases', () => {
    fixture.cases.forEach(row => {
      const before = JSON.stringify(row)
      const actual = applyRegisteredMethod(row.methodId, row.source, row.artifact)
      expect(actual.artifact, row.id).toEqual(row.expected)
      expect(JSON.stringify(row), row.id).toBe(before)
    })
  })

  test('offline method evaluations require real improvement without regressions', () => {
    for (const method of ['preserve-null-v1', 'copy-source-date-v1'] as const) {
      const result = evaluateRegisteredMethod(method)
      expect(result.accepted).toBe(true)
      expect(result.baselineViolations).toBeGreaterThan(result.candidateViolations)
      expect(result.regressions + result.falseChanges + result.scopeLeaks).toBe(0)
      expect(result.failureCases).toBeGreaterThan(0)
      expect(result.correctCases).toBeGreaterThan(0)
      expect(result.nonApplicableCases).toBeGreaterThan(0)
    }
  })
})
