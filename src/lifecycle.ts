import { createHash } from 'node:crypto'
import { instructionForPreference } from './classifier.js'
import type {
  AuditEvent,
  CaptureEvent,
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
  active: 5,
  trial: 4,
  candidate: 3,
  suspended: 2,
  retired: 1,
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
  if (category === 'preference' && event.preference !== null) {
    return instructionForPreference(event.preference)
  }
  if (category === 'guardrail') return guardrailInstruction(event.taskType, event.errorKind)
  return workflowInstruction(event.taskType, event.workflowSteps)
}

function familyFor(event: CaptureEvent, category: RuleCategory): string {
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
  if (rule.status !== 'trial' && rule.status !== 'active') return false
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
  for (const rule of state.rules) {
    if (!offered.has(rule.id) || !matchesAttribution(rule, event)) continue
    rule.opportunities += 1
    rule.lastEvidenceAt = event.occurredAt
    rule.sessionHashes = boundedUnique(rule.sessionHashes, event.sessionHash)
    if (event.outcome === 'success') {
      rule.successes += 1
      rule.lastSuccessAt = event.occurredAt
      rule.confidence = roundConfidence(rule.confidence + 0.08)
      rule.expiresAt = expiryFor(rule.status, rule.category, event.occurredAt)
    } else if (event.outcome === 'failure') {
      rule.failures += 1
      rule.confidence = roundConfidence(rule.confidence - 0.2)
      transition(transitions, rule, rule.failures >= 2 ? 'retired' : 'suspended', 'failure')
    } else if (event.outcome === 'corrected' || event.correction) {
      rule.corrections += 1
      rule.confidence = roundConfidence(rule.confidence - 0.3)
      transition(transitions, rule, 'suspended', 'correction')
    }
    if (
      rule.status === 'trial'
      && rule.successes >= 3
      && rule.confidence >= 0.75
      && rule.failures === 0
      && rule.corrections === 0
    ) transition(transitions, rule, 'active', 'trial_promoted')
  }
}

function sourceCategory(event: CaptureEvent): RuleCategory | null {
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
  const family = familyFor(event, category)
  const existing = state.rules.find(rule =>
    rule.status !== 'retired'
    && rule.taskType === event.taskType
    && rule.category === category
    && rule.workflowFamily === family)
  if (existing !== undefined) {
    existing.sessionHashes = boundedUnique(existing.sessionHashes, event.sessionHash)
    existing.observedWorkflowSignatures = boundedUnique(
      existing.observedWorkflowSignatures,
      event.workflowSignature,
    )
    existing.lastEvidenceAt = event.occurredAt
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
  const id = `rule_${sha256(JSON.stringify({ category, family, taskType: event.taskType })).slice(0, 16)}`
  const rule: EvolutionRule = {
    id,
    status: 'candidate',
    category,
    taskType: event.taskType,
    workflowFamily: family,
    workflowSteps: [...event.workflowSteps],
    observedWorkflowSignatures: [event.workflowSignature],
    preferenceId: category === 'preference' ? event.preference : null,
    instruction,
    instructionHash: sha256(instruction),
    confidence: category === 'guardrail' || category === 'preference' ? 0.65 : 0.55,
    createdAt: event.occurredAt,
    lastEvidenceAt: event.occurredAt,
    lastSuccessAt: null,
    expiresAt: expiryFor('candidate', category, event.occurredAt),
    sessionHashes: [event.sessionHash],
    version: 1,
    opportunities: 0,
    successes: 0,
    failures: 0,
    corrections: 0,
  }
  state.rules.push(rule)
  transitions.push({ ruleId: rule.id, from: null, to: 'candidate', reason: 'candidate_created' })
}

export function capture(input: EvolutionState, event: CaptureEvent): CaptureResult {
  const state = structuredClone(input)
  const transitions: RuleTransition[] = []
  if (state.recentTaskHashes.includes(event.taskHash)) return { state, transitions, audit: [] }
  state.recentTaskHashes = boundedUnique(state.recentTaskHashes, event.taskHash, MAX_RECENT_TASKS)
  state.counters.captures += 1
  state.updatedAt = event.occurredAt
  attributeInjected(state, event, transitions)
  const category = sourceCategory(event)
  if (category !== null) applySourceEvidence(state, event, category, transitions)
  enforceCapacity(state, transitions)
  const audit: AuditEvent[] = [
    { schemaVersion: 1, at: event.occurredAt, kind: 'capture_applied', count: 1 },
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
    'expired', 'duplicate', 'capacity',
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
  for (const victim of victims) {
    if (state.rules.filter(rule => rule.status !== 'retired').length <= MAX_RULES) break
    transition(transitions, victim, 'retired', 'capacity')
  }
}

export function selectRules(state: EvolutionState, request: SelectionRequest): SelectionResult {
  const maxRules = Math.max(1, Math.min(4, Math.trunc(request.maxRules)))
  const maxCodePoints = Math.max(1, Math.min(2_000, request.maxCodePoints ?? 2_000))
  const eligible = state.rules.filter(rule => {
    if (rule.expiresAt !== null && rule.expiresAt <= request.now) return false
    if (rule.status !== 'active' && rule.status !== 'trial') return false
    const exact = rule.taskType === request.taskType
    if (rule.status === 'trial') {
      return exact && rule.confidence >= 0.75 && rule.failures === 0 && rule.corrections === 0
    }
    if (exact) return true
    return rule.taskType === 'general'
      && (rule.category === 'workflow' || rule.category === 'general')
  }).sort((left, right) => {
    const leftExact = Number(left.taskType === request.taskType)
    const rightExact = Number(right.taskType === request.taskType)
    return rightExact - leftExact
      || CATEGORY_PRIORITY[right.category] - CATEGORY_PRIORITY[left.category]
      || STATUS_PRIORITY[right.status] - STATUS_PRIORITY[left.status]
      || right.confidence - left.confidence
      || (right.lastSuccessAt ?? 0) - (left.lastSuccessAt ?? 0)
      || left.id.localeCompare(right.id)
  })

  const selected: SelectionResult['rules'] = []
  const lines: string[] = []
  const instructions = new Set<string>()
  let total = [...'<missher-evolution-rules>\n\n</missher-evolution-rules>'].length
  let globalWorkflow = false
  for (const rule of eligible) {
    if (selected.length >= maxRules || instructions.has(rule.instruction)) continue
    const isGlobalWorkflow = request.taskType !== 'general'
      && rule.taskType === 'general'
      && (rule.category === 'workflow' || rule.category === 'general')
    if (isGlobalWorkflow && globalWorkflow) continue
    const line = `- [${rule.status.toUpperCase()}:${rule.category.toUpperCase()}] ${rule.instruction}`
    const length = [...line].length + 1
    if (total + length > maxCodePoints) continue
    selected.push({
      id: rule.id,
      status: rule.status as 'trial' | 'active',
      category: rule.category,
      taskType: rule.taskType,
      instruction: rule.instruction,
    })
    lines.push(line)
    instructions.add(rule.instruction)
    globalWorkflow ||= isGlobalWorkflow
    total += length
  }
  return {
    rules: selected,
    instruction: lines.length === 0
      ? ''
      : `<missher-evolution-rules>\n${lines.join('\n')}\n</missher-evolution-rules>`,
  }
}

export function maintain(input: EvolutionState, now: number): MaintenanceResult {
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
    if (lowValue || expired || staleActive) transition(transitions, rule, 'retired', 'expired')
  }
  state.lastMaintenanceAt = now
  state.updatedAt = now
  state.counters.maintenanceRuns += 1
  state.health = 'healthy'
  return {
    state,
    transitions,
    audit: [{
      schemaVersion: 1,
      at: now,
      kind: 'maintenance_completed',
      reason: 'manual',
      count: transitions.length,
    }],
  }
}

function consolidate(state: EvolutionState, transitions: RuleTransition[], now: number): void {
  const groups = new Map<string, EvolutionRule[]>()
  for (const rule of state.rules) {
    if (rule.status === 'retired') continue
    const key = `${rule.taskType}:${rule.category}:${rule.workflowFamily}:${normalizeInstruction(rule.instruction)}`
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
      duplicate.lastEvidenceAt = now
      transition(transitions, duplicate, 'retired', 'duplicate')
    }
  }
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
