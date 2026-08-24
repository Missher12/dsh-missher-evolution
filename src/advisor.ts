import { z } from 'zod'
import { containsSensitive } from './classifier.js'
import type { EvolutionRule } from './types.js'

const DEFAULT_TIMEOUT_MS = 45_000
const MAX_OUTPUT_BYTES = 8 * 1_024
const MAX_CANDIDATES = 4

export interface AdvisorRoute {
  provider: string
  model: string
}

export interface AdvisorModelMessage {
  role: 'system' | 'user'
  content: string
}

export interface AdvisorModelRequest {
  provider: string
  model: string
  maxTokens: number
  messages: AdvisorModelMessage[]
}

export type ModelRunner = (
  request: AdvisorModelRequest,
  signal: AbortSignal,
) => Promise<string>

export type AdvisorDecision =
  | { ruleId: string, action: 'keep' }
  | { ruleId: string, action: 'rewrite', instruction: string }

export type AdvisorResult =
  | { status: 'skipped_no_route' }
  | { status: 'skipped_no_candidate' }
  | { status: 'accepted', decision: AdvisorDecision }
  | {
    status: 'rejected'
    reason:
      | 'timeout'
      | 'aborted'
      | 'model_error'
      | 'output_too_large'
      | 'invalid_json'
      | 'invalid_contract'
      | 'unoffered_rule'
      | 'invalid_instruction'
  }

export interface AdvisorOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

const keepSchema = z.object({
  ruleId: z.string().regex(/^rule_[a-z0-9_]{1,96}$/u),
  action: z.literal('keep'),
}).strict()

const rewriteSchema = z.object({
  ruleId: z.string().regex(/^rule_[a-z0-9_]{1,96}$/u),
  action: z.literal('rewrite'),
  instruction: z.string(),
}).strict()

const decisionSchema = z.discriminatedUnion('action', [keepSchema, rewriteSchema])

interface OfferedCandidate {
  id: string
  status: 'candidate' | 'trial'
  category: EvolutionRule['category']
  taskType: EvolutionRule['taskType']
  workflowFamily: string
  workflowSteps: EvolutionRule['workflowSteps']
  observedWorkflowSignatures: string[]
  preferenceId: EvolutionRule['preferenceId']
  confidence: number
  sessionCount: number
  opportunities: number
  successes: number
  failures: number
  corrections: number
  version: number
}

export async function advise(
  rules: readonly EvolutionRule[],
  route: AdvisorRoute | null,
  runner: ModelRunner,
  options: AdvisorOptions = {},
): Promise<AdvisorResult> {
  if (route === null || !validRoute(route)) return { status: 'skipped_no_route' }
  const offered = eligibleCandidates(rules)
  if (offered.length === 0) return { status: 'skipped_no_candidate' }

  const request: AdvisorModelRequest = {
    provider: route.provider,
    model: route.model,
    maxTokens: 512,
    messages: [
      {
        role: 'system',
        content: '你是规则审查器。只能返回一个 JSON 对象，action 只能是 keep 或 rewrite；不得添加解释、代码围栏或额外字段。rewrite 必须是单行简体中文操作规则，并包含明确验证步骤。',
      },
      {
        role: 'user',
        content: JSON.stringify({ schemaVersion: 1, candidates: offered }),
      },
    ],
  }

  const timeoutMs = validTimeout(options.timeoutMs) ? options.timeoutMs as number : DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timedOut = Symbol('timed-out')
  const aborted = Symbol('aborted')
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof timedOut>(resolve => {
    timer = setTimeout(() => {
      controller.abort('advisor_timeout')
      resolve(timedOut)
    }, timeoutMs)
  })
  const call = runner(request, controller.signal)
    .then(value => ({ ok: true as const, value }))
    .catch(() => ({ ok: false as const }))
  let detachAbort: (() => void) | undefined
  const externalAbort = new Promise<typeof aborted>(resolve => {
    const signal = options.signal
    if (signal === undefined) return
    const abort = () => {
      resolve(aborted)
      controller.abort('advisor_aborted')
    }
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    detachAbort = () => signal.removeEventListener('abort', abort)
  })
  const settled = await Promise.race([call, timeout, externalAbort])
  if (timer !== undefined) clearTimeout(timer)
  detachAbort?.()
  if (settled === timedOut) return { status: 'rejected', reason: 'timeout' }
  if (settled === aborted) return { status: 'rejected', reason: 'aborted' }
  if (!settled.ok) return { status: 'rejected', reason: 'model_error' }
  if (Buffer.byteLength(settled.value, 'utf8') > MAX_OUTPUT_BYTES) {
    return { status: 'rejected', reason: 'output_too_large' }
  }
  if (/```/u.test(settled.value)) return { status: 'rejected', reason: 'invalid_json' }

  let decoded: unknown
  try {
    decoded = JSON.parse(settled.value)
  } catch {
    return { status: 'rejected', reason: 'invalid_json' }
  }
  const parsed = decisionSchema.safeParse(decoded)
  if (!parsed.success) return { status: 'rejected', reason: 'invalid_contract' }
  if (!offered.some(candidate => candidate.id === parsed.data.ruleId)) {
    return { status: 'rejected', reason: 'unoffered_rule' }
  }
  if (parsed.data.action === 'rewrite' && !validInstruction(parsed.data.instruction)) {
    return { status: 'rejected', reason: 'invalid_instruction' }
  }
  return { status: 'accepted', decision: parsed.data }
}

function eligibleCandidates(rules: readonly EvolutionRule[]): OfferedCandidate[] {
  return rules
    .filter((rule): rule is EvolutionRule & { status: 'candidate' | 'trial' } =>
      rule.status === 'candidate' || rule.status === 'trial')
    .sort((left, right) =>
      left.lastEvidenceAt - right.lastEvidenceAt
      || left.confidence - right.confidence
      || left.id.localeCompare(right.id))
    .slice(0, MAX_CANDIDATES)
    .map(rule => ({
      id: rule.id,
      status: rule.status,
      category: rule.category,
      taskType: rule.taskType,
      workflowFamily: rule.workflowFamily,
      workflowSteps: [...rule.workflowSteps],
      observedWorkflowSignatures: [...rule.observedWorkflowSignatures],
      preferenceId: rule.preferenceId,
      confidence: rule.confidence,
      sessionCount: rule.sessionHashes.length,
      opportunities: rule.opportunities,
      successes: rule.successes,
      failures: rule.failures,
      corrections: rule.corrections,
      version: rule.version,
    }))
}

function validInstruction(value: string): boolean {
  return value.length >= 8
    && value.length <= 500
    && Buffer.byteLength(value, 'utf8') <= 1_024
    && !/[\r\n\u0000-\u001f\u007f]/u.test(value)
    && /[\u3400-\u9fff]/u.test(value)
    && /检查|确认|验证|比较|核对|回读/u.test(value)
    && /处理|修改|执行|运行|读取|收集|转换|保留|报告|查询|限定|完成/u.test(value)
    && !containsSensitive(value)
}

function validRoute(route: AdvisorRoute): boolean {
  return validRoutePart(route.provider) && validRoutePart(route.model)
}

function validRoutePart(value: string): boolean {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function validTimeout(value: number | undefined): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 45_000
}
