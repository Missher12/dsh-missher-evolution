export const TASK_TYPES = [
  'browser', 'calendar', 'coding', 'data', 'email', 'general',
  'media', 'memory', 'research',
] as const
export type TaskType = typeof TASK_TYPES[number]

export const WORKFLOW_STEPS = [
  'browser', 'calendar', 'data', 'email', 'file_ops', 'media',
  'memory', 'research', 'shell', 'other',
] as const
export type WorkflowStep = typeof WORKFLOW_STEPS[number]

export const ERROR_KINDS = [
  'none', 'timeout', 'permission', 'validation', 'transport',
  'tool_error', 'unknown',
] as const
export type ErrorKind = typeof ERROR_KINDS[number]

export const RULE_STATUSES = [
  'candidate', 'trial', 'active', 'suspended', 'retired',
] as const
export type RuleStatus = typeof RULE_STATUSES[number]

export const RULE_CATEGORIES = [
  'workflow', 'guardrail', 'preference', 'general',
] as const
export type RuleCategory = typeof RULE_CATEGORIES[number]

export const OUTCOMES = ['success', 'failure', 'corrected', 'partial'] as const
export type Outcome = typeof OUTCOMES[number]

export const PREFERENCE_IDS = [
  'respond_simplified_chinese',
  'prefer_concise_answers',
  'verify_before_change',
  'preserve_requested_scope',
  'honor_exact_output',
] as const
export type PreferenceId = typeof PREFERENCE_IDS[number]

export type Complexity = 'low' | 'medium' | 'high'
export type HealthKind = 'healthy' | 'degraded' | 'state_unavailable' | 'lock_busy'

export interface PluginConfig {
  enabled?: boolean
  maintenanceIntervalHours?: number
  maxInjectedRules?: number
}

export interface ResolvedConfig {
  enabled: boolean
  maintenanceIntervalHours: number
  maxInjectedRules: number
}

export interface PromptClassification {
  taskType: TaskType
  correction: boolean
  preference: PreferenceId | null
}

export interface RuleCounters {
  opportunities: number
  successes: number
  failures: number
  corrections: number
}

export interface EvolutionRule extends RuleCounters {
  id: string
  status: RuleStatus
  category: RuleCategory
  taskType: TaskType
  workflowFamily: string
  workflowSteps: WorkflowStep[]
  observedWorkflowSignatures: string[]
  preferenceId: PreferenceId | null
  instruction: string
  instructionHash: string
  confidence: number
  createdAt: number
  lastEvidenceAt: number
  lastSuccessAt: number | null
  expiresAt: number | null
  sessionHashes: string[]
  version: number
}

export interface EvolutionCounters {
  captures: number
  injections: number
  rejectedCaptures: number
  maintenanceRuns: number
  weekStartedAt: number
  weeklyInjections: number
}

export interface EvolutionState {
  schemaVersion: 1
  revision: number
  enabled: boolean
  createdAt: number
  updatedAt: number
  lastMaintenanceAt: number | null
  lastBackupId: string | null
  health: HealthKind
  counters: EvolutionCounters
  recentTaskHashes: string[]
  rules: EvolutionRule[]
}

export interface CaptureEvent {
  schemaVersion: 1
  taskHash: string
  sessionHash: string
  occurredAt: number
  taskType: TaskType
  outcome: Outcome
  correction: boolean
  complexity: Complexity
  workflowSteps: WorkflowStep[]
  workflowSignature: string
  errorKind: ErrorKind
  injectedRuleIds: string[]
  preference: PreferenceId | null
}

export interface SelectionRequest {
  taskType: TaskType
  workflowSteps?: WorkflowStep[]
  now: number
  maxRules: number
  maxCodePoints?: number
}

export interface SelectedRule {
  id: string
  status: Extract<RuleStatus, 'trial' | 'active'>
  category: RuleCategory
  taskType: TaskType
  instruction: string
}

export interface SelectionResult {
  rules: SelectedRule[]
  instruction: string
}

export type AuditEventKind =
  | 'capture_applied'
  | 'capture_filtered'
  | 'selection_observed'
  | 'rule_created'
  | 'rule_transitioned'
  | 'rules_injected'
  | 'maintenance_completed'
  | 'state_reset'
  | 'enabled_changed'

export interface AuditEvent {
  schemaVersion: 1
  at: number
  kind: AuditEventKind
  ruleId?: string
  fromStatus?: RuleStatus
  toStatus?: RuleStatus
  reason?: string
  count?: number
}

export type StoreErrorCode =
  | 'invalid_root'
  | 'state_unavailable'
  | 'state_corrupt'
  | 'state_too_large'
  | 'revision_conflict'
  | 'lock_busy'
  | 'unsafe_path'
  | 'invalid_reset'
  | 'backup_failed'

export interface ResetRequest {
  expectedRevision: number
  confirmation: string
}
