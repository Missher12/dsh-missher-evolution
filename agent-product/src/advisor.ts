import { z } from 'zod'
import { containsSensitive } from './classifier.js'
import { canonicalRuleInstruction } from './lifecycle.js'
import type { EvolutionRule } from './types.js'
import { methodDecisionSchema, methodOffers, offeredMethodProposal, type MethodDecision } from './improvement.js'
import { METHOD_IDS, REGISTERED_METHODS } from './methods.js'

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
  | MethodDecision

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
      | 'unoffered_case'
      | 'invalid_instruction'
  }

export interface AdvisorOptions {
  timeoutMs?: number
  signal?: AbortSignal
  now?: number
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
  instruction: string
  workflowFamily: string
  workflowSteps: EvolutionRule['workflowSteps']
  observedWorkflowSignatures: string[]
  preferenceId: EvolutionRule['preferenceId']
  scope: NonNullable<EvolutionRule['scope']>
  semanticKey: string
  intentIds: NonNullable<EvolutionRule['intentIds']>
  constraintIds: NonNullable<EvolutionRule['constraintIds']>
  verificationIds: NonNullable<EvolutionRule['verificationIds']>
  noveltyScore: number
  evaluation: NonNullable<EvolutionRule['evaluation']>
  confidence: number
  sessionCount: number
  opportunities: number
  successes: number
  failures: number
  corrections: number
  version: number
  allowedRewriteInstructions: string[]
}

export async function advise(
  rules: readonly EvolutionRule[],
  route: AdvisorRoute | null,
  runner: ModelRunner,
  options: AdvisorOptions = {},
): Promise<AdvisorResult> {
  if (route === null || !validRoute(route)) return { status: 'skipped_no_route' }
  if (options.signal?.aborted) return { status: 'rejected', reason: 'aborted' }
  const caseOffers = methodOffers(rules, options.now ?? Date.now())
  const offered = eligibleCandidates(rules)
  if (offered.length === 0 && caseOffers.length === 0) return { status: 'skipped_no_candidate' }

  const request: AdvisorModelRequest = {
    provider: route.provider,
    model: route.model,
    maxTokens: 512,
    messages: [
      {
        role: 'system',
        content: caseOffers.length > 0
          ? '你是受限方法提案器。只根据 cases 内的真实核验失败、修复摘要和整体哈希选择一个兼容的注册方法，禁止虚构证据、分数、代码、操作权限或指令。只返回一个 JSON 对象：放弃为 {"action":"abstain"}；提案为 {"action":"propose","ruleId":案例规则标识,"caseId":案例标识,"methodId":兼容方法标识,"checkerId":案例检查器,"constraintId":案例约束}。不得有额外字段，不得改变约束或预期结果。'
          : '你是规则审查器。只能依据候选中的受控语义、操作正文和实验统计判断，不得补充候选证据之外的新事实。只能返回一个 JSON 对象，action 只能是 keep 或 rewrite；不得添加解释、代码围栏或额外字段。rewrite 必须逐字选择 allowedRewriteInstructions 中的正文；列表为空时只能使用 keep，禁止自由改写。',
      },
      {
        role: 'user',
        content: JSON.stringify(caseOffers.length > 0
          ? { schemaVersion: 3, cases: caseOffers, methods: METHOD_IDS.map(id => REGISTERED_METHODS[id]) }
          : { schemaVersion: 2, candidates: offered }),
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
  const call = Promise.resolve().then(() => runner(request, controller.signal))
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
  if (typeof settled.value !== 'string') return { status: 'rejected', reason: 'invalid_contract' }
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
  if (caseOffers.length > 0) {
    const proposal = methodDecisionSchema.safeParse(decoded)
    if (!proposal.success) return { status: 'rejected', reason: 'invalid_contract' }
    if (proposal.data.action === 'propose' && !offeredMethodProposal(proposal.data, caseOffers)) {
      return { status: 'rejected', reason: 'unoffered_case' }
    }
    return { status: 'accepted', decision: proposal.data }
  }
  const parsed = decisionSchema.safeParse(decoded)
  if (!parsed.success) return { status: 'rejected', reason: 'invalid_contract' }
  if (!offered.some(candidate => candidate.id === parsed.data.ruleId)) {
    return { status: 'rejected', reason: 'unoffered_rule' }
  }
  if (parsed.data.action === 'rewrite') {
    const candidate = offered.find(item => item.id === parsed.data.ruleId)
    if (
      candidate === undefined
      || !isSemanticallySafeRewrite(candidate, parsed.data.instruction)
    ) return { status: 'rejected', reason: 'invalid_instruction' }
  }
  return { status: 'accepted', decision: parsed.data }
}

function eligibleCandidates(rules: readonly EvolutionRule[]): OfferedCandidate[] {
  return rules
    .filter((rule): rule is EvolutionRule & { status: 'candidate' | 'trial' } =>
      rule.status === 'candidate' || rule.status === 'trial')
    .filter(rule => safeCandidateInstruction(rule.instruction))
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
      instruction: rule.instruction,
      workflowFamily: rule.workflowFamily,
      workflowSteps: [...rule.workflowSteps],
      observedWorkflowSignatures: [...rule.observedWorkflowSignatures],
      preferenceId: rule.preferenceId,
      scope: rule.scope === undefined
        ? { kind: 'global', keyHash: null }
        : { ...rule.scope },
      semanticKey: rule.semanticKey ?? rule.workflowFamily,
      intentIds: [...(rule.intentIds ?? [])],
      constraintIds: [...(rule.constraintIds ?? [])],
      verificationIds: [...(rule.verificationIds ?? [])],
      noveltyScore: rule.noveltyScore ?? 0,
      evaluation: rule.evaluation === undefined
        ? emptyEvaluation()
        : { ...rule.evaluation },
      confidence: rule.confidence,
      sessionCount: rule.sessionHashes.length,
      opportunities: rule.opportunities,
      successes: rule.successes,
      failures: rule.failures,
      corrections: rule.corrections,
      version: rule.version,
      allowedRewriteInstructions: allowedRewrites(rule),
    }))
}

function emptyEvaluation(): NonNullable<EvolutionRule['evaluation']> {
  return {
    treatmentOpportunities: 0,
    treatmentSuccesses: 0,
    controlOpportunities: 0,
    controlSuccesses: 0,
    treatmentFailures: 0,
    controlFailures: 0,
    negativeOutcomes: 0,
    inconclusiveOutcomes: 0,
  }
}

function safeCandidateInstruction(value: string): boolean {
  return value.length >= 8
    && value.length <= 500
    && Buffer.byteLength(value, 'utf8') <= 1_024
    && !/[\r\n\u0000-\u001f\u007f]/u.test(value)
    && !containsSensitive(value)
    && !/(?:https?:\/\/|file:\/\/|\/Users\/|\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+|[A-Za-z]:\\)/u.test(value)
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

type SemanticRuleEvidence = Pick<EvolutionRule, 'taskType' | 'category' | 'constraintIds' | 'verificationIds'>

export function isSemanticallySafeRewrite(
  rule: SemanticRuleEvidence,
  instruction: string,
): boolean {
  return validInstruction(instruction) && allowedRewrites(rule).includes(instruction)
}

function allowedRewrites(rule: SemanticRuleEvidence): string[] {
  // Legacy rules without structured evidence are keep-only until migrated.
  return (rule.constraintIds ?? []).length + (rule.verificationIds ?? []).length > 0
    ? [canonicalRuleInstruction(rule)] : []
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
