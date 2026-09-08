import { createHash } from 'node:crypto'
import { instructionForPreference } from './classifier.js'
import { addVerificationResult, verificationResultSchema } from './verification.js'
import { retainRuleCases, maintainImprovements, enforceImprovementBudget, methodGuidanceForRule, type MethodSelection } from './improvement.js'
import type {
  AuditEvent,
  CaptureEvent,
  ExperienceConstraintId,
  ExperienceIntentId,
  ExperienceScope,
  ExperienceVerificationId,
  EvolutionRule,
  EvolutionState,
  RuleCategory,
  RuleStatus,
  SelectionRequest,
  SelectionResult,
  TaskType,
  WorkflowStep,
} from './types.js'

const DAY = 24 * 60 * 60 * 1_000
const CANDIDATE_TTL = 30 * DAY
const TRIAL_TTL = 14 * DAY
const ACTIVE_TTL = 90 * DAY
const GUARDRAIL_TTL = 7 * DAY
const CORRECTION_TTL = 90 * DAY
const SUSPENDED_TTL = 30 * DAY
const MAX_RECENT_TASKS = 1_024
const MAX_RULES = 200

const TASK_LABELS: Readonly<Record<TaskType, string>> = Object.freeze({
  browser: '浏览器',
  calendar: '日历',
  coding: '代码',
  data: '数据',
  email: '邮件',
  general: '通用',
  media: '媒体',
  memory: '记忆',
  research: '研究',
})

const TASK_GUIDANCE: Readonly<Record<TaskType, string>> = Object.freeze({
  browser: '检查当前页面状态、关键元素和加载结果，只执行请求范围内的交互',
  calendar: '确认日期、时区、参与者和时间冲突，再执行变更并回读保存结果',
  coding: '检查受影响的实现和现有测试，确认范围与接口约束，只做最小必要修改',
  data: '检查结构、单位、缺失值和行数，再转换数据并与原始数据比较',
  email: '确认收件人、意图、附件以及草稿或发送状态，再核对消息结果',
  general: '识别请求目标和明确约束，将工作限定在请求范围内并完成',
  media: '检查源素材和输出要求，保留必要元数据，并核对渲染或提取结果',
  memory: '确认权威来源并保留出处，写入前去重，写入后验证可以检索',
  research: '明确问题和时效要求，优先使用权威来源，交叉核对关键结论并保留出处',
})

const STEP_GUIDANCE: Readonly<Record<WorkflowStep, string>> = Object.freeze({
  browser: '检查页面渲染状态和已加载字段',
  calendar: '读取并核对日历状态',
  data: '验证并比较结构化数值',
  email: '检查操作前后的消息状态',
  file_ops: '检查并仅更新目标文件',
  media: '检查源素材和输出媒体属性',
  memory: '查询、去重并验证检索结果',
  research: '收集并交叉核对权威证据',
  shell: '运行针对性命令并查看真实输出',
  other: '执行限定操作并检查结果',
})

const CATEGORY_PRIORITY: Readonly<Record<RuleCategory, number>> = Object.freeze({
  guardrail: 4,
  preference: 3,
  workflow: 2,
  general: 1,
})

const STATUS_PRIORITY: Readonly<Record<RuleStatus, number>> = Object.freeze({
  guardrail: 6,
  active: 5,
  trial: 4,
  candidate: 3,
  suspended: 2,
  retired: 1,
})

const GLOBAL_SCOPE: Readonly<ExperienceScope> = Object.freeze({ kind: 'global', keyHash: null })
const SEMANTIC_RECALL_INTENTS = new Set<ExperienceIntentId>([
  'publish_time',
  'interaction_metrics',
  'counted_collection',
  'authenticated_collection',
  'risk_control',
  'batch_operation',
  'deduplicate_records',
])

const CONSTRAINT_GUIDANCE: Readonly<Record<ExperienceConstraintId, string>> = Object.freeze({
  platform_command_resolution: '在 Windows 上按平台解析实际可执行入口，区分 npm.cmd 与其他平台命令，禁止套用另一平台路径',
  exit_status_required: '检查进程退出码和验证命令实际输出，非零退出时记录失败，不能仅凭完成文字判定成功',
  explicit_timezone: '保存明确的 IANA 时区，并按目标时区解析本地时间，不能使用服务器默认时区替代',
  dst_boundary_check: '检查夏令时边界的重复或不存在时间及日程冲突，存在歧义时停止写入并报告',
  idempotency_required: '在操作前建立幂等键并验证重试不会重复写入，重试结果须与首次提交一致',
  transaction_rollback: '将相关写入放入同一事务，失败时回滚并回读确认不存在部分提交',
  primary_source_citation: '使用一手或官方来源引用支持关键结论，交叉核对冲突并标明未确认部分',
  source_freshness: '核对来源发布日期与事件发生日期，对过时或时效不明的资料明确标注限制',
  preserve_unknown_values: '来源未提供值时保持空值并标记未知，禁止用当前值或推测值补齐',
  source_timestamp_required: '发布时间必须取自原始来源字段，缺失时不得改写成今天',
  no_fabricated_values: '只记录来源能够证明的数据，禁止编造、猜测或静默补值',
  exact_metric_semantics: '按来源字段原义绑定点赞、收藏和评论，禁止互换或使用位置猜测',
  exact_count_required: '严格按请求数量收集，完成前核对去重后的实际条数',
  authenticated_session_required: '只复用用户已授权的登录状态，失效时停止并报告，禁止绕过认证',
  bounded_rate_required: '使用有界并发和请求节奏，遇到限流或验证时停止扩张并保留进度',
  single_batch_required: '在同一有界批次内完成请求，避免无依据拆批或重复启动',
  deduplicate_results: '按原生内容标识去重，禁止用标题或展示文本代替唯一标识',
  meaningful_title_required: '标题缺失时使用可验证正文摘要，禁止输出无标题或图片数量占位符',
})

const INTENT_GUIDANCE: Readonly<Partial<Record<ExperienceIntentId, string>>> = Object.freeze({
  collect_data: '保留来源标识和原始字段语义',
  publish_time: '核对发布时间来源和缺失状态',
  interaction_metrics: '核对互动指标的字段映射',
  counted_collection: '核对目标数量和去重后数量',
  authenticated_collection: '确认授权会话仍然有效',
  risk_control: '限制并发、重试和访问节奏',
  batch_operation: '保持单批次状态连续',
  deduplicate_records: '使用稳定原生标识去重',
})

const VERIFICATION_GUIDANCE: Readonly<Record<ExperienceVerificationId, string>> = Object.freeze({
  source_comparison: '完成前把输出与原始来源逐项比较',
  field_validation: '完成前核对字段名称、含义和空值状态',
  count_validation: '完成前核对目标数量、实际数量和重复数量',
  test_suite: '完成前运行针对性测试并核对真实输出',
  live_smoke: '完成前执行一次有界真实烟测并核对结果',
})

export interface RuleTransition {
  ruleId: string
  from: RuleStatus | null
  to: RuleStatus
  reason: string
}

export interface CaptureResult {
  state: EvolutionState
  transitions: RuleTransition[]
  audit: AuditEvent[]
}

export interface MaintenanceResult {
  state: EvolutionState
  transitions: RuleTransition[]
  audit: AuditEvent[]
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export interface WorkflowProjection {
  task_type: TaskType
  categories: WorkflowStep[]
  transitions: string[]
  no_tool: boolean
}

export function workflowProjection(taskType: TaskType, steps: readonly WorkflowStep[]): WorkflowProjection {
  const noTool = steps.length === 0
  const known = steps.filter(step => step !== 'other')
  const filtered = known.length > 0 ? known : [...steps]
  const categories = [...new Set(filtered)].sort() as WorkflowStep[]
  const transitions = [...new Set(filtered.slice(0, -1).flatMap((step, index) => {
    const next = filtered[index + 1]
    return next !== undefined && next !== step ? [`${step}>${next}`] : []
  }))].sort()
  return { task_type: taskType, categories, transitions, no_tool: noTool }
}

export function workflowFamily(taskType: TaskType, steps: readonly WorkflowStep[]): string {
  const projection = workflowProjection(taskType, steps)
  return sha256(JSON.stringify({
    categories: projection.categories,
    no_tool: projection.no_tool,
    task_type: projection.task_type,
    transitions: projection.transitions,
  }))
}

function workflowInstruction(taskType: TaskType, steps: readonly WorkflowStep[]): string {
  const projection = workflowProjection(taskType, steps)
  const stages = projection.categories.map(step => STEP_GUIDANCE[step])
  if (stages.length === 0) {
    return `处理相似${TASK_LABELS[taskType]}任务时，先${TASK_GUIDANCE[taskType]}。回复前比较每项结论与现有证据，逐项检查输出格式和完成条件；发现不一致时立即修正，无法验证的内容必须说明限制。`
  }
  return `处理相似${TASK_LABELS[taskType]}任务时，先${TASK_GUIDANCE[taskType]}。按照已验证的工作流，先${stages.join('，再')}。完成后比较实际结果与用户要求，逐项验证明确约束；发现不一致时立即修正。`
}

function guardrailInstruction(taskType: TaskType, errorKind: CaptureEvent['errorKind']): string {
  const recovery = {
    none: '重新识别用户明确约束',
    timeout: '检查超时边界和必要条件，并只做一次有界重试',
    permission: '检查授权要求和当前访问状态，不绕过权限限制',
    validation: '检查被拒输入并按目标接口逐项验证字段',
    transport: '检查连接可用性，再执行一次有界重试',
    tool_error: '分类工具故障并检查其输入和前置条件',
    unknown: '先分类故障并检查已知前置条件',
  }[errorKind]
  return `处理相似${TASK_LABELS[taskType]}任务前，先${recovery}；恢复后比较实际结果与原始请求，逐项验证完成条件，仍未解决时如实报告。`
}

function instructionFor(event: CaptureEvent, category: RuleCategory): string {
  if (event.experience !== undefined && event.experience.noveltyScore > 0) {
    return experienceInstruction(event, category)
  }
  if (category === 'preference' && event.preference !== null) {
    return instructionForPreference(event.preference)
  }
  if (category === 'guardrail') return guardrailInstruction(event.taskType, event.errorKind)
  return workflowInstruction(event.taskType, event.workflowSteps)
}

function experienceInstruction(event: CaptureEvent, category: RuleCategory): string {
  const experience = event.experience
  if (experience === undefined) return workflowInstruction(event.taskType, event.workflowSteps)
  if (experience.constraintIds.length > 0) return canonicalRuleInstruction({
    taskType: event.taskType, category, constraintIds: experience.constraintIds,
    verificationIds: experience.verificationIds,
  })
  const constraints = experience.constraintIds.map(id => CONSTRAINT_GUIDANCE[id])
  const intents = experience.intentIds
    .flatMap(id => INTENT_GUIDANCE[id] === undefined ? [] : [INTENT_GUIDANCE[id] as string])
    .slice(0, 2)
  const actions = constraints.length > 0 ? constraints : intents
  const verification = experience.verificationIds.length === 0
    ? '完成前比较实际结果与用户要求，并报告无法验证的限制'
    : experience.verificationIds.map(id => VERIFICATION_GUIDANCE[id]).join('；')
  const prefix = category === 'guardrail'
    ? `处理相似${TASK_LABELS[event.taskType]}任务时先执行纠正规则`
    : `处理相似${TASK_LABELS[event.taskType]}任务时`
  return `${prefix}：${actions.join('；')}；${verification}。`.slice(0, 500)
}

export function canonicalRuleInstruction(rule: Pick<EvolutionRule, 'taskType' | 'category' | 'constraintIds' | 'verificationIds'>): string {
  const actions = (rule.constraintIds ?? []).map(id => CONSTRAINT_GUIDANCE[id])
  if (actions.length === 0) actions.push(TASK_GUIDANCE[rule.taskType])
  const verification = (rule.verificationIds ?? []).length === 0
    ? '完成前比较实际结果与用户要求，并报告无法验证的限制'
    : rule.verificationIds!.map(id => VERIFICATION_GUIDANCE[id]).join('；')
  const prefix = rule.category === 'guardrail'
    ? `处理相似${TASK_LABELS[rule.taskType]}任务时先执行纠正规则`
    : `处理相似${TASK_LABELS[rule.taskType]}任务时`
  return `${prefix}：${actions.join('；')}；${verification}。`
}

function familyFor(event: CaptureEvent, category: RuleCategory): string {
  if (isExplicitCorrection(event)) return sha256(JSON.stringify({
    kind: 'user_correction', scope: event.experience!.scope, taskType: event.taskType,
    constraintIds: [...event.experience!.constraintIds].sort(),
  }))
  if (event.experience !== undefined && event.experience.noveltyScore > 0) {
    return sha256(JSON.stringify({
      category,
      semanticKey: event.experience.semanticKey,
      taskType: event.taskType,
    }))
  }
  if (category === 'preference') {
    return sha256(JSON.stringify({ preference: event.preference, taskType: event.taskType }))
  }
  const workflow = workflowFamily(event.taskType, event.workflowSteps)
  if (category === 'guardrail') {
    return sha256(JSON.stringify({ errorKind: event.errorKind, taskType: event.taskType, workflow }))
  }
  return workflow
}

function expiryFor(status: RuleStatus, category: RuleCategory, now: number): number | null {
  if (status === 'retired') return null
  if (status === 'guardrail') return now + CORRECTION_TTL
  if (category === 'guardrail') return now + GUARDRAIL_TTL
  if (status === 'candidate') return now + CANDIDATE_TTL
  if (status === 'trial') return now + TRIAL_TTL
  if (status === 'active') return now + ACTIVE_TTL
  return now + SUSPENDED_TTL
}

function boundedUnique(values: readonly string[], value: string, limit = 16): string[] {
  const result = values.filter(item => item !== value)
  result.push(value)
  return result.slice(-limit)
}

function roundConfidence(value: number): number {
  return Math.round(Math.min(0.99, Math.max(0, value)) * 100) / 100
}

function transition(
  transitions: RuleTransition[],
  rule: EvolutionRule,
  to: RuleStatus,
  reason: string,
): void {
  const from = rule.status
  if (from === to) return
  rule.status = to
  rule.expiresAt = expiryFor(to, rule.category, rule.lastEvidenceAt)
  rule.version += 1
  transitions.push({ ruleId: rule.id, from, to, reason })
}

function matchesAttribution(rule: EvolutionRule, event: CaptureEvent): boolean {
  if (rule.status === 'guardrail') return correctionMatches(rule, event.experience, event.taskType)
  if (rule.status !== 'trial' && rule.status !== 'active') return false
  if (!scopeMatchesEvent(rule, event)) return false
  const scope = rule.scope ?? GLOBAL_SCOPE
  if (scope.kind !== 'global') {
    if (hasControlledSignals(rule) && semanticOverlapWithExperience(rule, event.experience) === 0) {
      return false
    }
  }
  const exactTask = rule.taskType === event.taskType
  const crossTask = rule.status === 'active'
    && rule.taskType === 'general'
    && (rule.category === 'workflow' || rule.category === 'general')
  if (!exactTask && !crossTask) return false
  if (rule.status === 'trial') return exactTask
  if (rule.category === 'preference' || rule.category === 'guardrail') return exactTask
  return rule.workflowFamily === workflowFamily(event.taskType, event.workflowSteps)
    || rule.observedWorkflowSignatures.includes(event.workflowSignature)
    || crossTask
}

function attributeInjected(
  state: EvolutionState,
  event: CaptureEvent,
  transitions: RuleTransition[],
): void {
  const offered = new Set(event.injectedRuleIds)
  const assigned = new Set((event.experimentAssignments ?? []).map(assignment => assignment.ruleId))
  for (const rule of state.rules) {
    if (!offered.has(rule.id) || !matchesAttribution(rule, event)) continue
    if (rule.status === 'guardrail') {
      attributeCorrection(rule, event)
      continue
    }
    const assignment = event.experimentAssignments?.find(item => item.ruleId === rule.id)
    if (assignment !== undefined && assignment.instructionHash !== rule.instructionHash) continue
    if (rule.status === 'trial' && (assignment?.arm !== 'treatment')) continue
    const evaluation = ensureEvaluation(rule)
    rule.opportunities += 1
    rule.lastEvidenceAt = event.occurredAt
    rule.sessionHashes = boundedUnique(rule.sessionHashes, event.sessionHash)
    const quality = event.outcomeEvidence?.quality ?? 'supported'
    if (quality === 'weak') {
      if (!assigned.has(rule.id)) evaluation.inconclusiveOutcomes += 1
      continue
    }
    if (event.outcome === 'success' && (quality === 'supported' || quality === 'verified')) {
      rule.successes += 1
      rule.lastSuccessAt = event.occurredAt
      rule.confidence = roundConfidence(rule.confidence + 0.08)
      rule.expiresAt = expiryFor(rule.status, rule.category, event.occurredAt)
    } else if (event.outcome === 'failure') {
      if (!assigned.has(rule.id)) evaluation.negativeOutcomes += 1
      rule.failures += 1
      rule.confidence = roundConfidence(rule.confidence - 0.2)
      transition(transitions, rule, rule.failures >= 2 ? 'retired' : 'suspended', 'failure')
    } else if (event.outcome === 'corrected' || event.correction) {
      if (!assigned.has(rule.id)) evaluation.negativeOutcomes += 1
      rule.corrections += 1
      rule.confidence = roundConfidence(rule.confidence - 0.3)
      transition(transitions, rule, 'suspended', 'correction')
    }
  }
}

function isExplicitCorrection(event: CaptureEvent): boolean {
  const experience = event.experience
  return event.correction && experience?.correction === true
    && experience.scope.kind !== 'global' && experience.scope.keyHash !== null
    && experience.constraintIds.length > 0
}

function correctionMatches(rule: EvolutionRule, experience: CaptureEvent['experience'], taskType: TaskType): boolean {
  if (rule.correctionLesson === undefined || experience === undefined || rule.taskType !== taskType) return false
  if (rule.scope?.kind === 'global' || rule.scope === undefined || rule.scope.keyHash === null) return false
  if (rule.scope.kind !== experience.scope.kind || rule.scope.keyHash !== experience.scope.keyHash) return false
  if (rule.instruction !== canonicalRuleInstruction(rule)) return false
  const constraints = rule.constraintIds ?? []
  if (constraints.some(id => experience.excludedConstraintIds?.includes(id))) return false
  const topics = new Set([...(experience.topicIds ?? []), ...experience.constraintIds])
  return constraints.some(id => topics.has(id))
}

function attributeCorrection(rule: EvolutionRule, event: CaptureEvent): void {
  const lesson = rule.correctionLesson!
  if (rule.expiresAt === null || rule.expiresAt <= event.occurredAt) return
  if (lesson.reminders >= 1_000_000_000) return
  const seen = new Set<string>()
  for (const raw of (event.verificationResults ?? []).slice(0, 24)) {
    const parsed = verificationResultSchema.safeParse(raw)
    if (!parsed.success) continue
    const result = parsed.data
    if (result.ruleId !== rule.id || result.instructionHash !== rule.instructionHash
      || !(rule.constraintIds ?? []).includes(result.constraintId) || seen.has(result.constraintId)) continue
    seen.add(result.constraintId)
    rule.verificationChecks = addVerificationResult(rule.verificationChecks, result, event.occurredAt)
  }
  retainRuleCases(rule, (event.learningCases ?? []).slice(0, 24).filter(c => c.taskHash === event.taskHash
    && c.recordedAt === event.occurredAt && seen.has(c.constraintId)), event.occurredAt)
  lesson.reminders += 1
  rule.opportunities += 1
  const evidence = event.outcomeEvidence
  const signals = new Set(evidence?.signals ?? [])
  if (event.correction || event.outcome === 'corrected' || signals.has('correction')) {
    lesson.repeatCorrections += 1
    rule.corrections += 1
    rule.lastEvidenceAt = Math.max(rule.lastEvidenceAt, event.occurredAt)
    rule.expiresAt = rule.lastEvidenceAt + CORRECTION_TTL
  } else if (event.outcome === 'failure' || signals.has('verification_failed')
    || signals.has('agent_error') || signals.has('tool_failure')) {
    lesson.failedReuses += 1
    rule.failures += 1
  } else if (event.outcome === 'success' && evidence?.quality === 'verified'
    && signals.has('verification_passed')) {
    lesson.verifiedReuses += 1
    lesson.lastVerifiedAt = Math.max(lesson.lastVerifiedAt ?? 0, event.occurredAt)
    rule.successes += 1
    rule.lastSuccessAt = lesson.lastVerifiedAt
    rule.lastEvidenceAt = Math.max(rule.lastEvidenceAt, event.occurredAt)
    rule.expiresAt = rule.lastEvidenceAt + CORRECTION_TTL
  } else {
    lesson.inconclusive += 1
  }
}

function attributeExperiments(state: EvolutionState, event: CaptureEvent): void {
  const injected = new Set(event.injectedRuleIds)
  for (const assignment of event.experimentAssignments ?? []) {
    const rule = state.rules.find(candidate => candidate.id === assignment.ruleId)
    if (rule === undefined || (rule.status !== 'trial' && rule.status !== 'active')) continue
    if (assignment.instructionHash !== rule.instructionHash) continue
    if (rule.taskType !== event.taskType || !scopeMatchesEvent(rule, event)) continue
    if (assignment.arm === 'treatment' && !injected.has(rule.id)) continue
    if (assignment.arm === 'control' && injected.has(rule.id)) continue
    const evaluation = ensureEvaluation(rule)
    const quality = event.outcomeEvidence?.quality ?? 'weak'
    if (quality === 'weak' || event.outcome === 'partial') {
      evaluation.inconclusiveOutcomes += 1
      continue
    }
    const success = event.outcome === 'success'
      && (quality === 'supported' || quality === 'verified')
    if (assignment.arm === 'treatment') {
      evaluation.treatmentOpportunities += 1
      if (success) evaluation.treatmentSuccesses += 1
      else evaluation.treatmentFailures += 1
    } else {
      evaluation.controlOpportunities += 1
      if (success) evaluation.controlSuccesses += 1
      else evaluation.controlFailures += 1
    }
    if (!success) evaluation.negativeOutcomes += 1
  }
}

function promoteTrials(
  state: EvolutionState,
  event: CaptureEvent,
  transitions: RuleTransition[],
): void {
  for (const rule of state.rules) {
    if (rule.status !== 'trial' || rule.failures > 0 || rule.corrections > 0 || rule.confidence < 0.75) {
      continue
    }
    const evaluation = ensureEvaluation(rule)
    if (
      evaluation.treatmentOpportunities < 3
      || evaluation.treatmentSuccesses < 3
      || evaluation.controlOpportunities < 2
      || evaluation.treatmentFailures > 0
    ) continue
    const treatmentRate = evaluation.treatmentSuccesses / evaluation.treatmentOpportunities
    const controlRate = evaluation.controlSuccesses / evaluation.controlOpportunities
    if (treatmentRate - controlRate >= 0.15) {
      transition(transitions, rule, 'active', 'trial_promoted')
      rule.origin = 'observed'
    }
  }
}

function scopeMatchesEvent(rule: EvolutionRule, event: CaptureEvent): boolean {
  return scopeMatchesExperience(rule, event.experience)
}

function scopeMatchesExperience(rule: EvolutionRule, experience: CaptureEvent['experience']): boolean {
  const scope = rule.scope ?? GLOBAL_SCOPE
  if (scope.kind === 'instance' || experience?.scope.kind === 'instance') {
    return scope.kind === 'instance' && experience?.scope.kind === 'instance'
      && scope.keyHash === experience.scope.keyHash && (rule.constraintIds ?? []).length > 0
      && rule.instruction === canonicalRuleInstruction(rule)
  }
  if (scope.kind === 'global') return true
  return experience?.scope.kind === 'project' && experience.scope.keyHash === scope.keyHash
}

function ensureEvaluation(rule: EvolutionRule): NonNullable<EvolutionRule['evaluation']> {
  if (rule.evaluationInstructionHash !== rule.instructionHash) {
    if (rule.evaluation !== undefined && Object.values(rule.evaluation).some(value => value > 0)) {
      rule.evaluationHistory = [...(rule.evaluationHistory ?? []), {
        instructionHash: rule.evaluationInstructionHash ?? rule.instructionHash,
        endedAt: rule.lastEvidenceAt,
        evaluation: { ...rule.evaluation },
      }].slice(-5)
    }
    rule.evaluation = emptyEvaluation()
    rule.evaluationInstructionHash = rule.instructionHash
  }
  rule.evaluation ??= emptyEvaluation()
  return rule.evaluation
}

export function emptyEvaluation(): NonNullable<EvolutionRule['evaluation']> {
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

function sourceCategory(event: CaptureEvent): RuleCategory | null {
  if (isExplicitCorrection(event)) return 'guardrail'
  if (event.outcome === 'success' && event.outcomeEvidence?.quality === 'weak') return null
  if (event.experience !== undefined) {
    const specific = event.experience.noveltyScore >= 0.35
      && event.experience.constraintIds.length > 0
    if (event.correction || event.outcome === 'corrected') return specific ? 'guardrail' : null
    if (event.outcome === 'failure' && event.errorKind !== 'none') {
      return specific ? 'guardrail' : null
    }
    if (event.outcome !== 'success') return null
    const quality = event.outcomeEvidence?.quality ?? 'weak'
    if (quality !== 'supported' && quality !== 'verified') return null
    return event.experience.scope.kind !== 'global' && specific ? 'workflow' : null
  }
  if (event.preference !== null) return 'preference'
  if (event.correction || event.outcome === 'corrected') return 'guardrail'
  if (event.outcome === 'failure' && event.errorKind !== 'none') return 'guardrail'
  if (event.outcome === 'success') {
    if (event.taskType === 'general' && event.workflowSteps.length === 0) return null
    return 'workflow'
  }
  return null
}

function applySourceEvidence(
  state: EvolutionState,
  event: CaptureEvent,
  category: RuleCategory,
  transitions: RuleTransition[],
): void {
  const explicitCorrection = isExplicitCorrection(event)
  const family = familyFor(event, category)
  const semanticKey = explicitCorrection || event.experience === undefined
    ? family
    : sha256(JSON.stringify({ category, semanticKey: event.experience.semanticKey }))
  const existing = state.rules.find(rule =>
    rule.status !== 'retired'
    && rule.taskType === event.taskType
    && rule.category === category
    && (event.experience === undefined
      ? (rule.scope ?? GLOBAL_SCOPE).kind === 'global' && rule.workflowFamily === family
      : scopeIdentity(rule.scope) === scopeIdentity(event.experience.scope)
        && rule.semanticKey === semanticKey))
  if (existing !== undefined) {
    existing.sessionHashes = boundedUnique(existing.sessionHashes, event.sessionHash)
    existing.observedWorkflowSignatures = boundedUnique(
      existing.observedWorkflowSignatures,
      event.workflowSignature,
    )
    existing.lastEvidenceAt = Math.max(existing.lastEvidenceAt, event.occurredAt)
    if (explicitCorrection && existing.correctionLesson !== undefined) {
      existing.lastEvidenceAt = Math.max(existing.lastEvidenceAt, existing.correctionLesson.recordedAt)
      existing.expiresAt = existing.lastEvidenceAt + CORRECTION_TTL
      return
    }
    if (event.experience !== undefined) {
      existing.scope = { ...event.experience.scope }
      existing.semanticKey = semanticKey
      existing.intentIds = mergeIdentifiers(existing.intentIds, event.experience.intentIds, 6)
      existing.constraintIds = mergeIdentifiers(existing.constraintIds, event.experience.constraintIds, 6)
      existing.verificationIds = mergeIdentifiers(existing.verificationIds, event.experience.verificationIds, 4)
      existing.noveltyScore = Math.max(existing.noveltyScore ?? 0, event.experience.noveltyScore)
    }
    existing.confidence = roundConfidence(existing.confidence + 0.05)
    existing.expiresAt = expiryFor(existing.status, existing.category, event.occurredAt)
    if (existing.status === 'candidate' && existing.sessionHashes.length >= 3) {
      existing.confidence = Math.max(existing.confidence, 0.75)
      transition(transitions, existing, 'trial', 'candidate_promoted')
      existing.opportunities = 0
      existing.successes = 0
      existing.failures = 0
      existing.corrections = 0
    }
    return
  }

  const instruction = instructionFor(event, category)
  const baseId = `rule_${sha256(JSON.stringify({ category, family, taskType: event.taskType })).slice(0, 16)}`
  const id = state.rules.some(rule => rule.id === baseId)
    ? `${baseId}_${sha256(`${event.taskHash}:${event.occurredAt}`).slice(0, 8)}`
    : baseId
  const rule: EvolutionRule = {
    id,
    status: explicitCorrection ? 'guardrail' : 'candidate',
    category,
    taskType: event.taskType,
    workflowFamily: family,
    workflowSteps: [...event.workflowSteps],
    observedWorkflowSignatures: [event.workflowSignature],
    preferenceId: category === 'preference' ? event.preference : null,
    instruction,
    instructionHash: sha256(instruction),
    evaluationInstructionHash: sha256(instruction),
    origin: 'observed',
    confidence: category === 'guardrail' || category === 'preference' ? 0.65 : 0.55,
    createdAt: event.occurredAt,
    lastEvidenceAt: event.occurredAt,
    lastSuccessAt: null,
    expiresAt: expiryFor(explicitCorrection ? 'guardrail' : 'candidate', category, event.occurredAt),
    sessionHashes: [event.sessionHash],
    version: 1,
    opportunities: 0,
    successes: 0,
    failures: 0,
    corrections: 0,
    ...(explicitCorrection ? { correctionLesson: {
      sourceTaskHash: event.taskHash, recordedAt: event.occurredAt,
      reminders: 0, verifiedReuses: 0, repeatCorrections: 0,
      failedReuses: 0, inconclusive: 0, lastVerifiedAt: null,
    } } : {}),
    evaluation: {
      treatmentOpportunities: 0,
      treatmentSuccesses: 0,
      controlOpportunities: 0,
      controlSuccesses: 0,
      treatmentFailures: 0,
      controlFailures: 0,
      negativeOutcomes: 0,
      inconclusiveOutcomes: 0,
    },
    ...(event.experience === undefined ? {} : {
      scope: { ...event.experience.scope },
      semanticKey,
      intentIds: [...event.experience.intentIds],
      constraintIds: [...event.experience.constraintIds],
      verificationIds: [...event.experience.verificationIds],
      noveltyScore: event.experience.noveltyScore,
    }),
  }
  state.rules.push(rule)
  transitions.push({ ruleId: rule.id, from: null, to: rule.status,
    reason: explicitCorrection ? 'guardrail_created' : 'candidate_created' })
}

export function capture(input: EvolutionState, event: CaptureEvent): CaptureResult {
  const state = structuredClone(input)
  const transitions: RuleTransition[] = []
  if (state.recentTaskHashes.includes(event.taskHash)) return { state, transitions, audit: [] }
  state.recentTaskHashes = boundedUnique(state.recentTaskHashes, event.taskHash, MAX_RECENT_TASKS)
  state.counters.captures += 1
  state.updatedAt = event.occurredAt
  attributeExperiments(state, event)
  attributeInjected(state, event, transitions)
  promoteTrials(state, event, transitions)
  const category = sourceCategory(event)
  const admission = category !== null ? 'accepted'
    : event.outcomeEvidence?.quality === 'weak' ? 'weak_outcome'
      : event.outcome !== 'success' ? 'non_success'
        : event.experience === undefined ? 'no_experience'
          : event.experience.scope.kind === 'global' ? 'missing_scope' : 'low_specificity'
  state.admissionCounters ??= {}
  state.admissionCounters[admission] = Math.min(Number.MAX_SAFE_INTEGER, (state.admissionCounters[admission] ?? 0) + 1)
  if (category !== null) applySourceEvidence(state, event, category, transitions)
  for (const rule of state.rules) retainRuleCases(rule, [], Math.max(input.updatedAt, event.occurredAt))
  enforceCapacity(state, transitions)
  enforceImprovementBudget(state)
  const auditedRuleIds = [...new Set([
    ...event.injectedRuleIds,
    ...(event.experimentAssignments ?? []).map(assignment => assignment.ruleId),
  ])]
  const audit: AuditEvent[] = [
    ...state.rules.flatMap(rule => {
      const before = input.rules.find(old => old.id === rule.id)?.verificationChecks
      const after = rule.verificationChecks
      if (!after) return []
      return (['passed', 'failed', 'insufficient', 'unsupported', 'stale', 'errors'] as const).flatMap(status => {
        const count = after[status] - (before?.[status] ?? 0)
        return count <= 0 ? [] : [{ schemaVersion: 1 as const, at: event.occurredAt,
          kind: 'verification_settled' as const, ruleId: rule.id, instructionHash: rule.instructionHash,
          correlationHash: event.taskHash, reason: `check_${status}`, count }]
      })
    }),
    {
      schemaVersion: 1,
      at: event.occurredAt,
      kind: 'capture_applied',
      count: 1,
      correlationHash: event.taskHash,
      ruleIds: auditedRuleIds,
      ...(event.experience?.scope.kind === 'project'
        ? { projectScopeHash: event.experience.scope.keyHash as string }
        : {}),
      ...(event.outcomeEvidence === undefined
        ? {}
        : { outcomeQuality: event.outcomeEvidence.quality }),
      ...(event.experimentAssignments?.[0] === undefined
        ? {}
        : { experimentArm: event.experimentAssignments[0].arm }),
    },
    ...transitions.map(item => ({
      schemaVersion: 1 as const,
      at: event.occurredAt,
      kind: item.from === null ? 'rule_created' as const : 'rule_transitioned' as const,
      ruleId: item.ruleId,
      ...(item.from === null ? {} : { fromStatus: item.from }),
      toStatus: item.to,
      reason: normalizeAuditReason(item.reason),
    })),
  ]
  return { state, transitions, audit }
}

function normalizeAuditReason(reason: string): NonNullable<AuditEvent['reason']> {
  const allowed = new Set([
    'candidate_created', 'candidate_promoted', 'trial_promoted',
    'rule_suspended', 'rule_retired', 'failure', 'correction',
    'expired', 'duplicate', 'capacity', 'low_novelty',
    'guardrail_created',
  ])
  return allowed.has(reason) ? reason : 'invalid'
}

function enforceCapacity(state: EvolutionState, transitions: RuleTransition[]): void {
  if (state.rules.length <= MAX_RULES) return
  const victims = state.rules
    .filter(rule => rule.status !== 'active')
    .sort((left, right) =>
      STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status]
      || left.confidence - right.confidence
      || left.lastEvidenceAt - right.lastEvidenceAt
      || left.id.localeCompare(right.id))
  const removeIds = new Set<string>()
  for (const victim of victims) {
    if (state.rules.length - removeIds.size <= MAX_RULES) break
    if (victim.status !== 'retired') transition(transitions, victim, 'retired', 'capacity')
    removeIds.add(victim.id)
  }
  state.rules = state.rules.filter(rule => !removeIds.has(rule.id))
}

export function selectRules(state: EvolutionState, request: SelectionRequest): SelectionResult {
  const maxRules = Math.max(1, Math.min(4, Math.trunc(request.maxRules)))
  const maxCodePoints = Math.max(1, Math.min(2_000, request.maxCodePoints ?? 2_000))
  const eligible = state.rules.filter(rule => {
    if (rule.expiresAt !== null && rule.expiresAt <= request.now) return false
    if (rule.status === 'guardrail') return correctionMatches(rule, request.experience, request.taskType)
    if (rule.status !== 'active' && rule.status !== 'trial') return false
    if (!scopeMatchesExperience(rule, request.experience)) return false
    const scope = rule.scope ?? GLOBAL_SCOPE
    if (scope.kind !== 'global') {
      if (hasControlledSignals(rule) && semanticOverlapWithExperience(rule, request.experience) === 0) {
        return false
      }
    }
    const exact = rule.taskType === request.taskType
    if (rule.status === 'trial') {
      return exact && rule.confidence >= 0.75 && rule.failures === 0 && rule.corrections === 0
    }
    if (exact) return true
    return rule.taskType === 'general'
      && (rule.category === 'workflow' || rule.category === 'general')
  }).sort((left, right) => {
    const leftScope = scopeScore(left, request)
    const rightScope = scopeScore(right, request)
    const leftSignals = semanticOverlap(left, request)
    const rightSignals = semanticOverlap(right, request)
    const leftExact = Number(left.taskType === request.taskType)
    const rightExact = Number(right.taskType === request.taskType)
    return rightScope - leftScope
      || rightSignals - leftSignals
      || rightExact - leftExact
      || CATEGORY_PRIORITY[right.category] - CATEGORY_PRIORITY[left.category]
      || STATUS_PRIORITY[right.status] - STATUS_PRIORITY[left.status]
      || right.confidence - left.confidence
      || (right.lastSuccessAt ?? 0) - (left.lastSuccessAt ?? 0)
      || left.id.localeCompare(right.id)
  })

  const selected: SelectionResult['rules'] = []
  const experimentAssignments: NonNullable<SelectionResult['experimentAssignments']> = []
  const lines: string[] = []
  const instructions = new Set<string>()
  let total = [...'<missher-evolution-rules>\n\n</missher-evolution-rules>'].length
  let globalWorkflow = false
  let reservedCount = 0
  const requiredConstraints = new Set<ExperienceConstraintId>()
  const reminders = eligible.filter(rule => rule.status === 'guardrail').slice(0, 2)
  for (const rule of reminders) {
    const guidance = methodGuidanceForRule(rule, request.now)
    const enriched = guidance ? `${rule.instruction} ${guidance}` : rule.instruction
    const instruction = total + [...`- [纠错提醒] ${enriched}`].length + 1 <= maxCodePoints ? enriched : rule.instruction
    const line = `- [纠错提醒] ${instruction}`
    const length = [...line].length + 1
    if (reservedCount >= maxRules || total + length > maxCodePoints) continue
    total += length
    reservedCount += 1
    instructions.add(rule.instruction)
    for (const id of rule.constraintIds ?? []) requiredConstraints.add(id)
    selected.push({ id: rule.id, status: 'guardrail', category: rule.category,
      taskType: rule.taskType, instruction })
    lines.push(line)
  }
  // Select the experimental slot before its arm so the background stays identical.
  const trial = reservedCount >= maxRules ? undefined : eligible.find(rule => rule.status === 'trial'
    && !(rule.constraintIds ?? []).some(id => requiredConstraints.has(id))
    && !instructions.has(rule.instruction)
    && total + [...`- [TRIAL:${rule.category.toUpperCase()}] ${rule.instruction}`].length + 1 <= maxCodePoints)
  const ordered = trial === undefined ? eligible.filter(rule => rule.status === 'active')
    : [trial, ...eligible.filter(rule => rule.status === 'active')]
  for (const rule of ordered) {
    if (reservedCount >= maxRules || instructions.has(rule.instruction)) continue
    const isGlobalWorkflow = request.taskType !== 'general'
      && rule.taskType === 'general'
      && (rule.category === 'workflow' || rule.category === 'general')
    if (isGlobalWorkflow && globalWorkflow) continue
    const line = `- [${rule.status.toUpperCase()}:${rule.category.toUpperCase()}] ${rule.instruction}`
    const length = [...line].length + 1
    if (total + length > maxCodePoints) continue
    total += length
    reservedCount += 1
    instructions.add(rule.instruction)
    globalWorkflow ||= isGlobalWorkflow
    if (rule.status === 'trial' && request.experimentKey !== undefined) {
      const arm = trialArm(rule.id, request.experimentKey)
      experimentAssignments.push({ ruleId: rule.id, arm, instructionHash: rule.instructionHash })
      if (arm === 'control') continue
    }
    selected.push({
      id: rule.id,
      status: rule.status as 'trial' | 'active',
      category: rule.category,
      taskType: rule.taskType,
      instruction: rule.instruction,
    })
    lines.push(line)
  }
  return {
    rules: selected,
    instruction: lines.length === 0
      ? ''
      : `<missher-evolution-rules>\n${lines.join('\n')}\n</missher-evolution-rules>`,
    ...(experimentAssignments.length === 0 ? {} : { experimentAssignments }),
  }
}

export function trialArm(ruleId: string, experimentKey: string): 'treatment' | 'control' {
  const bucket = Number.parseInt(sha256(`${ruleId}:${experimentKey}`).slice(0, 8), 16) % 100
  return bucket < 20 ? 'control' : 'treatment'
}

export function maintain(input: EvolutionState, now: number, methodSelection?: MethodSelection | null): MaintenanceResult {
  const state = structuredClone(input)
  const transitions: RuleTransition[] = []
  consolidate(state, transitions, now)
  for (const rule of state.rules) {
    if (rule.status === 'retired') continue
    const lowValue = rule.taskType === 'general'
      && rule.workflowSteps.length === 0
      && (rule.category === 'workflow' || rule.category === 'general')
    const expired = rule.expiresAt !== null && rule.expiresAt <= now
    const staleActive = rule.status === 'active' && now - rule.lastEvidenceAt >= ACTIVE_TTL
    const lowNovelty = (rule.status === 'candidate' || rule.status === 'trial')
      && (rule.category === 'workflow' || rule.category === 'general')
      && (rule.noveltyScore ?? 0) < 0.35
      && (rule.intentIds ?? []).length === 0
      && (rule.constraintIds ?? []).length === 0
      && (rule.verificationIds ?? []).length === 0
    if (lowNovelty) transition(transitions, rule, 'retired', 'low_novelty')
    else if (lowValue || expired || staleActive) transition(transitions, rule, 'retired', 'expired')
  }
  state.lastMaintenanceAt = now
  maintainImprovements(state, now, methodSelection)
  state.updatedAt = now
  state.counters.maintenanceRuns += 1
  state.health = 'healthy'
  enforceImprovementBudget(state)
  return {
    state,
    transitions,
    audit: [
      ...transitions.map(item => ({
        schemaVersion: 1 as const,
        at: now,
        kind: 'rule_transitioned' as const,
        ruleId: item.ruleId,
        ...(item.from === null ? {} : { fromStatus: item.from }),
        toStatus: item.to,
        reason: normalizeAuditReason(item.reason),
      })),
      {
        schemaVersion: 1,
        at: now,
        kind: 'maintenance_completed',
        reason: 'manual',
        count: transitions.length,
      },
    ],
  }
}

function consolidate(state: EvolutionState, transitions: RuleTransition[], now: number): void {
  const groups = new Map<string, EvolutionRule[]>()
  for (const rule of state.rules) {
    if (rule.status === 'retired') continue
    const key = rule.semanticKey === undefined
      ? `${rule.taskType}:${rule.category}:${rule.workflowFamily}:${normalizeInstruction(rule.instruction)}`
      : `${rule.taskType}:${rule.category}:${scopeIdentity(rule.scope)}:${rule.semanticKey}`
    const group = groups.get(key) ?? []
    group.push(rule)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    group.sort((left, right) =>
      STATUS_PRIORITY[right.status] - STATUS_PRIORITY[left.status]
      || left.createdAt - right.createdAt
      || left.id.localeCompare(right.id))
    const primary = group[0]
    if (primary === undefined) continue
    for (const duplicate of group.slice(1)) {
      primary.sessionHashes = mergeRecent(primary.sessionHashes, duplicate.sessionHashes)
      primary.observedWorkflowSignatures = mergeRecent(
        primary.observedWorkflowSignatures,
        duplicate.observedWorkflowSignatures,
      )
      primary.confidence = Math.max(primary.confidence, duplicate.confidence)
      primary.lastEvidenceAt = Math.max(primary.lastEvidenceAt, duplicate.lastEvidenceAt)
      primary.expiresAt = Math.max(primary.expiresAt ?? 0, duplicate.expiresAt ?? 0) || null
      primary.opportunities = Math.max(primary.opportunities, duplicate.opportunities)
      primary.successes = Math.max(primary.successes, duplicate.successes)
      primary.failures = Math.max(primary.failures, duplicate.failures)
      primary.corrections = Math.max(primary.corrections, duplicate.corrections)
      primary.intentIds = mergeIdentifiers(primary.intentIds, duplicate.intentIds ?? [], 6)
      primary.constraintIds = mergeIdentifiers(primary.constraintIds, duplicate.constraintIds ?? [], 6)
      primary.verificationIds = mergeIdentifiers(primary.verificationIds, duplicate.verificationIds ?? [], 4)
      primary.noveltyScore = Math.max(primary.noveltyScore ?? 0, duplicate.noveltyScore ?? 0)
      if (primary.scope === undefined && duplicate.scope !== undefined) {
        primary.scope = { ...duplicate.scope }
      }
      if (primary.semanticKey === undefined && duplicate.semanticKey !== undefined) {
        primary.semanticKey = duplicate.semanticKey
      }
      mergeEvaluation(primary, duplicate)
      duplicate.lastEvidenceAt = now
      transition(transitions, duplicate, 'retired', 'duplicate')
    }
  }
}

function mergeEvaluation(primary: EvolutionRule, duplicate: EvolutionRule): void {
  if (primary.instructionHash !== duplicate.instructionHash
    || duplicate.evaluationInstructionHash !== primary.instructionHash) return
  const left = ensureEvaluation(primary)
  const right = duplicate.evaluation
  if (right === undefined) return
  left.treatmentOpportunities = Math.max(left.treatmentOpportunities, right.treatmentOpportunities)
  left.treatmentSuccesses = Math.max(left.treatmentSuccesses, right.treatmentSuccesses)
  left.controlOpportunities = Math.max(left.controlOpportunities, right.controlOpportunities)
  left.controlSuccesses = Math.max(left.controlSuccesses, right.controlSuccesses)
  left.treatmentFailures = Math.max(left.treatmentFailures, right.treatmentFailures)
  left.controlFailures = Math.max(left.controlFailures, right.controlFailures)
  left.negativeOutcomes = Math.max(left.negativeOutcomes, right.negativeOutcomes)
  left.inconclusiveOutcomes = Math.max(left.inconclusiveOutcomes, right.inconclusiveOutcomes)
}

function scopeIdentity(scope: ExperienceScope | undefined): string {
  return scope !== undefined && scope.kind !== 'global' && scope.keyHash !== null ? `${scope.kind}:${scope.keyHash}` : 'global'
}

function scopeScore(rule: EvolutionRule, request: SelectionRequest): number {
  const scope = rule.scope ?? GLOBAL_SCOPE
  if (scope.kind !== 'global' && scope.kind === request.experience?.scope.kind && scope.keyHash === request.experience.scope.keyHash) return 2
  return scope.kind === 'global' ? 1 : 0
}

function semanticOverlap(rule: EvolutionRule, request: SelectionRequest): number {
  return semanticOverlapWithExperience(rule, request.experience)
}

function semanticOverlapWithExperience(
  rule: EvolutionRule,
  experience: SelectionRequest['experience'],
): number {
  if (experience === undefined) return 0
  return overlap(rule.constraintIds, experience.constraintIds) * 4
    + overlap(
      rule.intentIds?.filter(intent => SEMANTIC_RECALL_INTENTS.has(intent)),
      experience.intentIds.filter(intent => SEMANTIC_RECALL_INTENTS.has(intent)),
    ) * 2
    + overlap(rule.verificationIds, experience.verificationIds)
}

function hasControlledSignals(rule: EvolutionRule): boolean {
  return (rule.intentIds?.length ?? 0) > 0
    || (rule.constraintIds?.length ?? 0) > 0
    || (rule.verificationIds?.length ?? 0) > 0
}

function overlap<T extends string>(left: readonly T[] | undefined, right: readonly T[]): number {
  if (left === undefined || left.length === 0 || right.length === 0) return 0
  const requested = new Set(right)
  return left.filter(value => requested.has(value)).length
}

function mergeIdentifiers<T extends string>(
  left: readonly T[] | undefined,
  right: readonly T[],
  limit: number,
): T[] {
  return [...new Set([...(left ?? []), ...right])].slice(0, limit)
}

function mergeRecent(left: readonly string[], right: readonly string[]): string[] {
  const values: string[] = []
  for (const value of [...left, ...right]) {
    const existing = values.indexOf(value)
    if (existing >= 0) values.splice(existing, 1)
    values.push(value)
  }
  return values.slice(-16)
}

function normalizeInstruction(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, ' ')
}
