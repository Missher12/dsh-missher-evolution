import type {
  ErrorKind,
  PreferenceId,
  PromptClassification,
  TaskType,
  WorkflowStep,
} from './types.js'

const MAX_PROMPT_CODE_UNITS = 32 * 1024
const MAX_ERROR_CODE_UNITS = 4 * 1024

const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /(?:token|secret|password|api[_-]?key|app[_-]?secret|access[_-]?key|authorization|tenant_access_token)\s*[:=]\s*["']?[^\s"']{4,}/iu,
  /\bBearer\s+[A-Za-z0-9_.=-]{10,}/iu,
  /-----BEGIN\s+.*PRIVATE\s+KEY-----/iu,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u,
  /\b(?:https?|wss?):\/\//iu,
  /(?:^|[\s("]\/)\/(?:Users|home|etc|tmp|var)\/\S+/u,
  /(?:^|[\s("])[A-Za-z]:\\(?:Users|Windows|ProgramData|Temp)\\\S+/iu,
  /[\u0000-\u001f\u007f]/u,
]

const CORRECTION_PATTERNS: readonly RegExp[] = [
  /不是[\s\S]{0,80}(?:而是|要用|应该用|改成)/iu,
  /(?:我说的是|改成|应该用|不要再)/iu,
  /\bI said\b[\s\S]{0,80}\b(?:use|instead)\b/iu,
  /\bnot\b[\s\S]{0,80}\b(?:but|use|instead)\b/iu,
  /\binstead of\b|\bshould use\b/iu,
]

const TASK_RULES: readonly [RegExp, TaskType][] = [
  [/小红书|xiaohongshu|\bxhs\b|哔哩哔哩|b站|bilibili|微博|weibo|抖音|douyin|tiktok/iu, 'media'],
  [/python|javascript|typescript|代码|测试|修复|开发|refactor|debug|implement/iu, 'coding'],
  [/calendar|日历|日程|会议/iu, 'calendar'],
  [/email|mail|邮件/iu, 'email'],
  [/memory|记忆|obsidian|tencent/iu, 'memory'],
  [/browser|chrome|网页|浏览器/iu, 'browser'],
  [/research|搜索|调研|查资料/iu, 'research'],
  [/image|audio|video|图片|音频|视频/iu, 'media'],
  [/sheet|sql|data|表格|数据/iu, 'data'],
]

const TOOL_RULES: readonly [RegExp, WorkflowStep][] = [
  [/apply_patch|file|read|write|edit|document/iu, 'file_ops'],
  [/chrome|playwright|browser/iu, 'browser'],
  [/web|search|fetch|scrape|research/iu, 'research'],
  [/exec|shell|bash|terminal|command/iu, 'shell'],
  [/memory|tencent|obsidian/iu, 'memory'],
  [/calendar/iu, 'calendar'],
  [/mail|gmail|email/iu, 'email'],
  [/image|audio|video|media/iu, 'media'],
  [/sheet|sql|data|table/iu, 'data'],
]

const PREFERENCE_RULES: readonly [RegExp, PreferenceId][] = [
  [/(?:以后|始终|总是|都).{0,24}(?:简体)?中文(?:回答|回复|输出)|(?:不要|别用).{0,12}英文/iu, 'respond_simplified_chinese'],
  [/(?:回答|回复|输出).{0,16}(?:简洁|精简|短一些)|(?:不要|别).{0,12}(?:啰嗦|冗长)/iu, 'prefer_concise_answers'],
  [/(?:先|必须先).{0,16}(?:检查|验证|确认).{0,16}(?:再|后).{0,8}(?:修改|改动|执行)/iu, 'verify_before_change'],
  [/(?:不要|别).{0,16}(?:修改|改动|处理).{0,12}(?:无关|范围外)|仅限.{0,16}(?:范围|目标)/iu, 'preserve_requested_scope'],
  [/(?:只|仅)(?:回复|输出|回答)|\b(?:reply|respond|output|return|say)\s+(?:with\s+)?exactly\b/iu, 'honor_exact_output'],
]

const PREFERENCE_INSTRUCTIONS: Readonly<Record<PreferenceId, string>> = Object.freeze({
  respond_simplified_chinese: '使用简体中文回答；发送前检查正文语言并确认没有无必要的英文段落。',
  prefer_concise_answers: '优先给出简洁结论，只保留完成请求所需的信息；发送前核对是否存在重复说明。',
  verify_before_change: '修改前先检查目标、现状和影响范围，修改后运行对应验证并报告真实结果。',
  preserve_requested_scope: '把操作限定在用户明确请求的目标内；完成前比较变更清单并确认没有无关改动。',
  honor_exact_output: '识别用户要求的精确输出格式，只生成允许内容；发送前逐项核对格式和字符约束。',
})

function boundedString(value: unknown, maxCodeUnits: number): string {
  return typeof value === 'string' ? value.slice(0, maxCodeUnits) : ''
}

export function containsSensitive(value: unknown): boolean {
  if (typeof value !== 'string') return true
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(value))
}

export function classifyPrompt(value: unknown): PromptClassification {
  const text = boundedString(value, MAX_PROMPT_CODE_UNITS)
  const taskType = TASK_RULES.find(([pattern]) => pattern.test(text))?.[1] ?? 'general'
  const preference = PREFERENCE_RULES.find(([pattern]) => pattern.test(text))?.[1] ?? null
  return {
    taskType,
    correction: CORRECTION_PATTERNS.some(pattern => pattern.test(text)),
    preference,
  }
}

export function classifyTool(value: unknown): WorkflowStep {
  const text = boundedString(value, 512)
  return TOOL_RULES.find(([pattern]) => pattern.test(text))?.[1] ?? 'other'
}

export function classifyError(value: unknown): ErrorKind {
  const text = boundedString(value, MAX_ERROR_CODE_UNITS).toLowerCase()
  if (!text) return 'none'
  if (/timeout|timed out|deadline/u.test(text)) return 'timeout'
  if (/permission|denied|forbidden|unauthorized|approval/u.test(text)) return 'permission'
  if (/invalid|validation|schema|argument/u.test(text)) return 'validation'
  if (/network|transport|connection|socket|dns/u.test(text)) return 'transport'
  return 'tool_error'
}

export function instructionForPreference(id: PreferenceId): string {
  return PREFERENCE_INSTRUCTIONS[id]
}
