import { createHash } from 'node:crypto'
import { classifyPrompt } from './classifier.js'
import type {
  ExperienceCapsule,
  ExperienceConstraintId,
  ExperienceIntentId,
  ExperienceScope,
  ExperienceVerificationId,
} from './types.js'

const MAX_PROMPT_CODE_UNITS = 32 * 1_024
const MAX_PROJECT_KEY_CODE_UNITS = 512
const MAX_INTENTS = 6
const MAX_CONSTRAINTS = 6
const MAX_VERIFICATIONS = 4
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const POLARITY_TOPICS: Partial<Record<ExperienceConstraintId, RegExp>> = {
  platform_command_resolution: /windows|npm\.cmd|命令解析/iu,
  exit_status_required: /退出码|退出状态|exit (?:code|status)/iu,
  explicit_timezone: /时区|timezone|time zone/iu,
  dst_boundary_check: /夏令时|\bdst\b/iu,
  idempotency_required: /幂等|idempoten/iu,
  transaction_rollback: /事务|回滚|transaction|rollback/iu,
  primary_source_citation: /一手|官方|primary source|official source/iu,
  source_freshness: /时效|发布日期|freshness|publication date/iu,
}

const CONSTRAINT_EXCLUSIONS: Partial<Record<ExperienceConstraintId, RegExp>> = {
  preserve_unknown_values: /(?:不必|无需|不用|不需要|不要|别)(?:再)?(?:保持|保留|标记).{0,8}(?:未知|空值|null)/iu,
  source_timestamp_required: /(?:不必|无需|不用|不需要|不要|别)(?:再)?(?:取自|使用|记录|核对|抓取|获取).{0,8}(?:原始|来源|发布时间|发布日期|时间戳)/iu,
  no_fabricated_values: /(?<!不)(?:允许|可以)(?:直接)?(?:编造|伪造|猜测|推测|虚构)/iu,
  exact_metric_semantics: /(?:不必|无需|不用|不需要|不要|别)(?:再)?(?:按|核对|检查|保留|遵守).{0,8}(?:字段原义|字段语义|指标语义|字段映射|指标映射)/iu,
  exact_count_required: /(?:不必|无需|不用|不需要|不要|别)(?:再)?(?:严格)?(?:按|满足|遵守|核对|检查).{0,8}(?:数量|条数)|(?:不限|不限制)(?:数量|条数)/iu,
  authenticated_session_required: /(?:不必|无需|不用|不需要|不要|别)(?:再)?(?:复用|使用|检查|保持|验证)?(?:已授权的|已授权|当前|已有)?(?:登录|认证)(?:状态)?/iu,
  bounded_rate_required: /(?:不必|无需|不用|不需要|不要|别)(?:再)?(?:设置|使用|保持|遵守)?(?:限流|限速|请求频率限制|访问频率限制|有界并发)/iu,
  single_batch_required: /(?:不必|无需|不用|不需要|不要|别)(?:再)?(?:要求|坚持)?(?:一次性|单次完成|一次完成|同一批次)/iu,
  deduplicate_results: /(?:不必|无需|不用|不需要|不要|别)(?:再)?(?:做|执行|进行)?去重|(?:do not|don't|skip)\s+deduplicat/iu,
  meaningful_title_required: /(?:不必|无需|不用|不需要|不要|别)(?:再)?(?:生成|提取|补充|验证|核对)(?:有意义的|有意义)?标题/iu,
}

function admitsPolarity(id: ExperienceConstraintId, text: string): boolean {
  if (CONSTRAINT_EXCLUSIONS[id]?.test(text)) return false
  const topic = POLARITY_TOPICS[id]
  if (topic === undefined) return true
  return !text.split(/[，,。；;\n]/u).some(clause => topic.test(clause)
    && !(id === 'explicit_timezone'
      && /(?:不要|不能|禁止|不得|别)(?:再)?(?:使用|用|依赖|套用).{0,12}(?:默认|服务器).{0,6}时区/iu.test(clause))
    && /不必|无需|不用|不需要|不要|忽略|跳过|\b(?:ignore|skip|without)\b|do not|don't|no need/iu.test(clause))
}

const CORRECTION_TOPICS: Readonly<Record<ExperienceConstraintId, RegExp>> = {
  preserve_unknown_values: /未知|缺失|空值|null|missing|unknown/iu,
  source_timestamp_required: /发布时间|发布日期|时间戳|日期字段|publish(?:ed)?[ _-]?(?:at|time|date)|timestamp/iu,
  no_fabricated_values: /伪造|编造|猜测|推测|补值|fabricat|invent/iu,
  exact_metric_semantics: /点赞|收藏|评论|字段映射|字段对应|metric/iu,
  exact_count_required: /条数|数量|多少条|\d+\s*条|count/iu,
  authenticated_session_required: /登录|认证|cookie|authenticat/iu,
  bounded_rate_required: /风控|封号|限流|请求频率|访问频率|rate.?limit/iu,
  single_batch_required: /一次性|单次|一次完成|批量|batch/iu,
  deduplicate_results: /去重|重复数据|重复记录|重复写入|deduplicat/iu,
  meaningful_title_required: /标题|title/iu,
  platform_command_resolution: /windows|win32|npm\.cmd|命令解析|command resolution/iu,
  exit_status_required: /退出码|退出状态|exit (?:code|status)/iu,
  explicit_timezone: /时区|timezone|time zone/iu,
  dst_boundary_check: /夏令时|\bdst\b/iu,
  idempotency_required: /幂等|idempoten/iu,
  transaction_rollback: /事务|回滚|transaction|rollback/iu,
  primary_source_citation: /一手|官方来源|primary source|official source/iu,
  source_freshness: /时效|资料.{0,8}最新|来源.{0,8}最新|freshness|publication date/iu,
}

const INTENT_PATTERNS: readonly [ExperienceIntentId, RegExp][] = [
  ['publish_time', /发布时间|发布日期|时间戳|日期字段/iu],
  ['interaction_metrics', /点赞|收藏|评论|互动数据/iu],
  ['counted_collection', /指定数量|条数|多少条|抓取.{0,12}\d+\s*条|采集.{0,12}\d+\s*条/iu],
  ['authenticated_collection', /登录状态|已登录|cookie|认证状态/iu],
  ['risk_control', /风控|封号|限流|请求频率|访问频率/iu],
  ['batch_operation', /一次性|批量/iu],
  ['deduplicate_records', /去重|重复数据|重复记录/iu],
  ['collect_data', /抓取|采集|爬取|scrap|crawl/iu],
  ['bug_fix', /修复|\bbug\b|错误|不对|问题/iu],
  ['validate_result', /验证|测试|核对|比较|对比/iu],
  ['migrate_upgrade', /升级|迁移|重构|版本/iu],
]

const CONSTRAINT_PATTERNS: readonly [ExperienceConstraintId, (text: string) => boolean][] = [
  ['preserve_unknown_values', text =>
    /未知|没有|缺失|空值|null/iu.test(text)
    && /保持|保留|不要|不能|禁止|不得/iu.test(text)
    && /今天|当前|补齐|填充|推测|未知|空值|null/iu.test(text)],
  ['source_timestamp_required', text =>
    /发布时间|发布日期|时间戳|日期字段/iu.test(text)
    && /来源|原始|抓取|记录|字段|接口/iu.test(text)],
  ['no_fabricated_values', text =>
    /不要|不能|禁止|不得|严禁/iu.test(text)
    && /伪造|编造|猜测|推测|写成今天|统一写成今天|虚构|补齐/iu.test(text)],
  ['exact_metric_semantics', text =>
    (/点赞/iu.test(text) && /收藏/iu.test(text) && /评论/iu.test(text))
    || /字段.{0,20}(?:对应|映射)|(?:对应|映射).{0,20}字段/iu.test(text)],
  ['exact_count_required', text =>
    /指定数量|条数|多少条|\d+\s*条/iu.test(text)
    && /抓取|采集|需要|必须|要求|指定/iu.test(text)],
  ['authenticated_session_required', text => /已登录|登录状态|cookie|认证状态/iu.test(text)],
  ['bounded_rate_required', text => /风控|封号|限流|请求频率|访问频率/iu.test(text)],
  ['single_batch_required', text => /一次性|单次完成|一次完成/iu.test(text)],
  ['deduplicate_results', text => /去重|不得重复|不要重复|重复数据|重复记录/iu.test(text)],
  ['meaningful_title_required', text =>
    /标题/iu.test(text) && /无标题|不能为空|占位|有意义|正文摘要/iu.test(text)],
  ['platform_command_resolution', text => /windows|win32|跨平台/iu.test(text) && /npm\.cmd|可执行文件|命令解析|command resolution/iu.test(text)],
  ['exit_status_required', text => /退出码|退出状态|exit (?:code|status)/iu.test(text) && /检查|核对|验证|必须|check|verify|require/iu.test(text)],
  ['explicit_timezone', text => /时区|timezone|time zone/iu.test(text) && /iana|明确|显式|指定|explicit/iu.test(text)],
  ['dst_boundary_check', text => /夏令时|\bdst\b/iu.test(text) && /边界|冲突|歧义|检查|验证|boundary|ambigui|check|verify/iu.test(text)],
  ['idempotency_required', text => /幂等|idempoten/iu.test(text) && /键|重复|重试|保证|必须|key|retry|require/iu.test(text)],
  ['transaction_rollback', text => /事务|transaction/iu.test(text) && /回滚|rollback/iu.test(text)],
  ['primary_source_citation', text => /一手来源|官方来源|primary source|official source/iu.test(text) && /引用|出处|交叉核对|cite|citation|cross.check/iu.test(text)],
  ['source_freshness', text => /来源|资料|source/iu.test(text) && /时效|发布日期|最新|publication date|freshness|up.to.date/iu.test(text)],
]

const VERIFICATION_PATTERNS: readonly [ExperienceVerificationId, (text: string) => boolean][] = [
  ['source_comparison', text =>
    /来源|原始|实际打开|源数据/iu.test(text) && /核对|比较|对比|验证/iu.test(text)],
  ['field_validation', text => /字段|点赞|收藏|评论|发布时间|标题/iu.test(text)],
  ['count_validation', text => /条数|数量|多少条|\d+\s*条/iu.test(text)],
  ['test_suite', text => /测试|pytest|vitest|unittest|test suite/iu.test(text)],
  ['live_smoke', text => /烟测|实际抓取|真实抓取|开箱即用|端到端/iu.test(text)],
]

const CONSTRAINT_WEIGHT: Readonly<Record<ExperienceConstraintId, number>> = Object.freeze({
  preserve_unknown_values: 0.35,
  source_timestamp_required: 0.25,
  no_fabricated_values: 0.30,
  exact_metric_semantics: 0.35,
  exact_count_required: 0.20,
  authenticated_session_required: 0.20,
  bounded_rate_required: 0.25,
  single_batch_required: 0.20,
  deduplicate_results: 0.15,
  meaningful_title_required: 0.20,
  platform_command_resolution: 0.30,
  exit_status_required: 0.25,
  explicit_timezone: 0.30,
  dst_boundary_check: 0.30,
  idempotency_required: 0.30,
  transaction_rollback: 0.30,
  primary_source_citation: 0.25,
  source_freshness: 0.25,
})

const SPECIFIC_INTENTS = new Set<ExperienceIntentId>([
  'publish_time',
  'interaction_metrics',
  'counted_collection',
  'authenticated_collection',
  'risk_control',
  'batch_operation',
  'deduplicate_records',
])

export interface DistillExperienceInput {
  prompt: unknown
  projectKey?: unknown
  instanceKey?: unknown
}

export function scopeForInstance(instanceKey: unknown): ExperienceScope {
  if (scopeForProject(instanceKey).kind !== 'project') return { kind: 'global', keyHash: null }
  return { kind: 'instance', keyHash: digest(`mse-instance-v1:${String(instanceKey)}`) }
}

export function scopeForProject(projectKey: unknown): ExperienceScope {
  if (
    typeof projectKey !== 'string'
    || projectKey.length === 0
    || projectKey.length > MAX_PROJECT_KEY_CODE_UNITS
    || projectKey !== projectKey.trim()
    || CONTROL_CHARACTER.test(projectKey)
  ) return { kind: 'global', keyHash: null }
  return { kind: 'project', keyHash: digest(projectKey) }
}

export function distillExperience(input: DistillExperienceInput): ExperienceCapsule {
  const text = typeof input.prompt === 'string'
    ? input.prompt.slice(0, MAX_PROMPT_CODE_UNITS)
    : ''
  const classification = classifyPrompt(text)
  const topicIds = (Object.keys(CORRECTION_TOPICS) as ExperienceConstraintId[])
    .filter(id => CORRECTION_TOPICS[id].test(text))
  const excludedConstraintIds = (Object.keys(CORRECTION_TOPICS) as ExperienceConstraintId[])
    .filter(id => !admitsPolarity(id, text))
  const scope = input.projectKey === undefined ? scopeForInstance(input.instanceKey) : scopeForProject(input.projectKey)
  const intentIds = INTENT_PATTERNS
    .filter(([, pattern]) => pattern.test(text))
    .map(([id]) => id)
    .slice(0, MAX_INTENTS)
  const constraintIds = CONSTRAINT_PATTERNS
    .filter(([id, matches]) => matches(text) && admitsPolarity(id, text))
    .map(([id]) => id)
    .slice(0, MAX_CONSTRAINTS)
  const verificationIds = VERIFICATION_PATTERNS
    .filter(([, matches]) => matches(text))
    .map(([id]) => id)
    .slice(0, MAX_VERIFICATIONS)
  const noveltyScore = scoreNovelty(
    scope,
    intentIds,
    constraintIds,
    verificationIds,
    classification.correction,
  )
  const semanticKey = digest(JSON.stringify({
    constraintIds,
    intentIds,
    scope,
    taskType: classification.taskType,
    verificationIds,
  }))
  return {
    schemaVersion: 1,
    ...classification,
    scope,
    intentIds,
    constraintIds,
    verificationIds,
    noveltyScore,
    semanticKey,
    ...(topicIds.length === 0 ? {} : { topicIds }),
    ...(excludedConstraintIds.length === 0 ? {} : { excludedConstraintIds }),
  }
}

function scoreNovelty(
  scope: ExperienceScope,
  intents: readonly ExperienceIntentId[],
  constraints: readonly ExperienceConstraintId[],
  verifications: readonly ExperienceVerificationId[],
  correction: boolean,
): number {
  const hasSpecificIntent = intents.some(intent => SPECIFIC_INTENTS.has(intent))
  if (constraints.length === 0 && !hasSpecificIntent) return 0
  const constraintScore = constraints.reduce((total, id) => total + CONSTRAINT_WEIGHT[id], 0)
  const scopeScore = scope.kind === 'project' ? 0.10 : 0
  const intentScore = Math.min(0.15, intents.filter(intent => SPECIFIC_INTENTS.has(intent)).length * 0.05)
  const verificationScore = Math.min(0.10, verifications.length * 0.05)
  const correctionScore = correction ? 0.15 : 0
  return Math.round(Math.min(1, constraintScore + scopeScore + intentScore + verificationScore + correctionScore) * 100) / 100
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
