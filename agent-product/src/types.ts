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
  'candidate', 'trial', 'active', 'guardrail', 'suspended', 'retired',
] as const
export type RuleStatus = typeof RULE_STATUSES[number]

export const RULE_CATEGORIES = [
  'workflow', 'guardrail', 'preference', 'general',
] as const
export type RuleCategory = typeof RULE_CATEGORIES[number]

export const OUTCOMES = ['success', 'failure', 'corrected', 'partial'] as const
export type Outcome = typeof OUTCOMES[number]

export const OUTCOME_QUALITIES = ['weak', 'supported', 'verified', 'contradicted'] as const
export type OutcomeQuality = typeof OUTCOME_QUALITIES[number]

export const OUTCOME_SIGNALS = [
  'host_completed',
  'assistant_content',
  'tool_success',
  'verification_passed',
  'verification_failed',
  'correction',
  'tool_failure',
  'agent_error',
] as const
export type OutcomeSignal = typeof OUTCOME_SIGNALS[number]

export const ADMISSION_REASONS = ['accepted', 'weak_outcome', 'non_success', 'missing_scope', 'low_specificity', 'no_experience'] as const
export type AdmissionReason = typeof ADMISSION_REASONS[number]

export interface OutcomeEvidence {
  quality: OutcomeQuality
  signals: OutcomeSignal[]
}

export interface TrialAssignment {
  ruleId: string
  arm: 'treatment' | 'control'
  instructionHash?: string
}

export interface RuleEvaluation {
  treatmentOpportunities: number
  treatmentSuccesses: number
  controlOpportunities: number
  controlSuccesses: number
  treatmentFailures: number
  controlFailures: number
  negativeOutcomes: number
  inconclusiveOutcomes: number
}

export const PREFERENCE_IDS = [
  'respond_simplified_chinese',
  'prefer_concise_answers',
  'verify_before_change',
  'preserve_requested_scope',
  'honor_exact_output',
] as const
export type PreferenceId = typeof PREFERENCE_IDS[number]

export const EXPERIENCE_INTENT_IDS = [
  'collect_data',
  'publish_time',
  'interaction_metrics',
  'counted_collection',
  'authenticated_collection',
  'risk_control',
  'batch_operation',
  'deduplicate_records',
  'bug_fix',
  'validate_result',
  'migrate_upgrade',
] as const
export type ExperienceIntentId = typeof EXPERIENCE_INTENT_IDS[number]

export const EXPERIENCE_CONSTRAINT_IDS = [
  'preserve_unknown_values',
  'source_timestamp_required',
  'no_fabricated_values',
  'exact_metric_semantics',
  'exact_count_required',
  'authenticated_session_required',
  'bounded_rate_required',
  'single_batch_required',
  'deduplicate_results',
  'meaningful_title_required',
  'platform_command_resolution',
  'exit_status_required',
  'explicit_timezone',
  'dst_boundary_check',
  'idempotency_required',
  'transaction_rollback',
  'primary_source_citation',
  'source_freshness',
] as const
export type ExperienceConstraintId = typeof EXPERIENCE_CONSTRAINT_IDS[number]

export const EXPERIENCE_VERIFICATION_IDS = [
  'source_comparison',
  'field_validation',
  'count_validation',
  'test_suite',
  'live_smoke',
] as const
export type ExperienceVerificationId = typeof EXPERIENCE_VERIFICATION_IDS[number]

export interface ExperienceScope {
  kind: 'global' | 'project' | 'instance'
  keyHash: string | null
}

export interface ExperienceCapsule extends PromptClassification {
  schemaVersion: 1
  scope: ExperienceScope
  intentIds: ExperienceIntentId[]
  constraintIds: ExperienceConstraintId[]
  verificationIds: ExperienceVerificationId[]
  noveltyScore: number
  semanticKey: string
  topicIds?: ExperienceConstraintId[]
  excludedConstraintIds?: ExperienceConstraintId[]
}

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
  scope?: ExperienceScope
  semanticKey?: string | undefined
  intentIds?: ExperienceIntentId[]
  constraintIds?: ExperienceConstraintId[]
  verificationIds?: ExperienceVerificationId[]
  noveltyScore?: number
  evaluation?: RuleEvaluation
  evaluationInstructionHash?: string | undefined
  evaluationHistory?: { instructionHash: string, endedAt: number, evaluation: RuleEvaluation }[] | undefined
  origin?: 'observed' | 'legacy' | undefined
  correctionLesson?: CorrectionLesson | undefined
  verificationChecks?: import('./verification.js').VerificationCounters | undefined
  improvement?: import('./improvement.js').RuleImprovement | undefined
}

export interface CorrectionLesson {
  sourceTaskHash: string
  recordedAt: number
  reminders: number
  verifiedReuses: number
  repeatCorrections: number
  failedReuses: number
  inconclusive: number
  lastVerifiedAt: number | null
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
  admissionCounters?: Partial<Record<AdmissionReason, number | undefined>> | undefined
  importedMethods?: import('./improvement.js').ImportedMethod[] | undefined
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
  experience?: ExperienceCapsule
  outcomeEvidence?: OutcomeEvidence
  experimentAssignments?: TrialAssignment[]
  verificationResults?: import('./verification.js').VerificationResult[]
  learningCases?: import('./improvement.js').LearningCase[]
}

export interface SelectionRequest {
  taskType: TaskType
  workflowSteps?: WorkflowStep[]
  experience?: ExperienceCapsule
  experimentKey?: string
  now: number
  maxRules: number
  maxCodePoints?: number
}

export interface SelectedRule {
  id: string
  status: Extract<RuleStatus, 'trial' | 'active' | 'guardrail'>
  category: RuleCategory
  taskType: TaskType
  instruction: string
}

export interface SelectionResult {
  rules: SelectedRule[]
  instruction: string
  experimentAssignments?: TrialAssignment[]
}

export type AuditEventKind =
  | 'capture_applied'
  | 'capture_filtered'
  | 'selection_observed'
  | 'rule_created'
  | 'rule_transitioned'
  | 'rules_injected'
  | 'advisor_rule_rewritten'
  | 'maintenance_completed'
  | 'state_reset'
  | 'enabled_changed'
  | 'verification_settled'

export interface AuditEvent {
  schemaVersion: 1
  at: number
  kind: AuditEventKind
  ruleId?: string
  fromStatus?: RuleStatus
  toStatus?: RuleStatus
  reason?: string
  count?: number
  correlationHash?: string
  ruleIds?: string[]
  projectScopeHash?: string
  outcomeQuality?: OutcomeQuality
  experimentArm?: TrialAssignment['arm']
  previousInstructionHash?: string
  instructionHash?: string
  previousVersion?: number
  version?: number
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

export const ADAPTER_CAPABILITIES = [
  'turns',
  'tools',
  'assistant-outcome',
  'errors',
  'session-dispose',
  'model-route',
] as const
export type AdapterCapability = typeof ADAPTER_CAPABILITIES[number]

export interface AgentAdapterDescriptor {
  schemaVersion: 1
  id: string
  displayName: string
  version: string
  capabilities: readonly AdapterCapability[]
}
