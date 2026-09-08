import { z } from 'zod'
import { checkRows, verificationRowsSchema, type VerificationRow } from './verification.js'

export const METHOD_IDS = Object.freeze(['preserve-null-v1', 'copy-source-date-v1'] as const)
export const methodIdSchema = z.enum(METHOD_IDS)
export type MethodId = typeof METHOD_IDS[number]
export const REGISTERED_METHODS = Object.freeze({
  'preserve-null-v1': Object.freeze({ methodId: 'preserve-null-v1', version: 1,
    checkerId: 'missing-values-v1', constraintId: 'preserve_unknown_values',
    procedure: '先核对来源与产物的记录标识完全一致，仅将来源未知的对应字段保留为空值，保留其他字段，完成后重新核验。',
    applicability: 'matching_row_identity', exclusions: 'invalid_or_mismatched_rows',
  } as const),
  'copy-source-date-v1': Object.freeze({ methodId: 'copy-source-date-v1', version: 1,
    checkerId: 'source-dates-v1', constraintId: 'source_timestamp_required',
    procedure: '先核对来源与产物的记录标识完全一致，仅将对应发布时间复制为原始来源日期，来源为空时保留空值，保留其他字段，完成后重新核验。',
    applicability: 'matching_row_identity_valid_dates', exclusions: 'invalid_or_mismatched_rows',
  } as const),
})

export interface MethodApplication {
  status: 'applied' | 'unchanged' | 'not_applicable'
  artifact: VerificationRow[] | null
}

/** Pure row projection, never an authorization to write an artifact. */
export function applyRegisteredMethod(methodId: MethodId, source: unknown, artifact: unknown): MethodApplication {
  const method = REGISTERED_METHODS[methodIdSchema.parse(methodId)]
  const a = verificationRowsSchema.safeParse(source), b = verificationRowsSchema.safeParse(artifact)
  if (!a.success || !b.success) return { status: 'not_applicable', artifact: null }
  const baseline = checkRows(method.checkerId, a.data, b.data)
  if (baseline.status !== 'fail') return { status: baseline.status === 'pass' ? 'unchanged' : 'not_applicable', artifact: b.data }
  const values = new Map(a.data.map(row => [row.id, row.value]))
  return { status: 'applied', artifact: b.data.map(row => ({ ...row,
    value: methodId === 'copy-source-date-v1' || values.get(row.id) === null ? values.get(row.id)! : row.value })) }
}
