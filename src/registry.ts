import type {
  ErrorKind,
  Outcome,
  PreferenceId,
  TaskType,
  WorkflowStep,
} from './types.js'

const RULE_ID = /^rule_[a-z0-9_]{1,96}$/u
const MAX_WORKFLOW_STEPS = 12
const MAX_INJECTED_RULES = 4

export interface OpenTurnInput {
  taskHash: string
  taskType: TaskType
  correction: boolean
  preference: PreferenceId | null
}

export interface TurnSnapshot extends OpenTurnInput {
  sessionId: string
  turnId: string
  workflowSteps: WorkflowStep[]
  injectedRuleIds: string[]
  errorKind: ErrorKind
  assistantOutcome: Outcome | null
  captured: boolean
  filtered: boolean
  touchedAt: number
}

export interface TurnRegistryOptions {
  maxEntries?: number
  ttlMs?: number
  now?: () => number
}

function identity(value: unknown, label: string): string {
  const normalized = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : value
  if (
    typeof normalized !== 'string'
    || normalized.length === 0
    || normalized.length > 512
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new TypeError(`${label}_invalid`)
  }
  return normalized
}

function keyFor(sessionId: string, turnId: string): string {
  return `${sessionId.length}:${sessionId}${turnId}`
}

function copyTurn(turn: TurnSnapshot): TurnSnapshot {
  return {
    ...turn,
    workflowSteps: [...turn.workflowSteps],
    injectedRuleIds: [...turn.injectedRuleIds],
  }
}

export class TurnRegistry {
  private readonly turns = new Map<string, TurnSnapshot>()
  private readonly subagents = new Map<string, number>()
  private readonly maxEntries: number
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(options: TurnRegistryOptions = {}) {
    const maxEntries = options.maxEntries ?? 1_000
    const ttlMs = options.ttlMs ?? 60 * 60 * 1_000
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('max_entries_invalid')
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('ttl_invalid')
    this.maxEntries = maxEntries
    this.ttlMs = ttlMs
    this.now = options.now ?? Date.now
  }

  open(sessionId: unknown, turnId: unknown, input: OpenTurnInput): TurnSnapshot | undefined {
    const session = identity(sessionId, 'session')
    const turn = identity(turnId, 'turn')
    const now = this.now()
    this.cleanupAt(now)
    const key = keyFor(session, turn)
    const existing = this.turns.get(key)
    if (existing !== undefined) {
      existing.taskHash = input.taskHash
      existing.taskType = input.taskType
      existing.correction ||= input.correction
      existing.preference = input.preference ?? existing.preference
      existing.touchedAt = now
      return copyTurn(existing)
    }
    if (!this.makeRoom()) return undefined
    const opened: TurnSnapshot = {
      sessionId: session,
      turnId: turn,
      taskHash: input.taskHash,
      taskType: input.taskType,
      correction: input.correction,
      preference: input.preference,
      workflowSteps: [],
      injectedRuleIds: [],
      errorKind: 'none',
      assistantOutcome: null,
      captured: false,
      filtered: false,
      touchedAt: now,
    }
    this.turns.set(key, opened)
    return copyTurn(opened)
  }

  setInjectedRules(sessionId: unknown, turnId: unknown, ruleIds: readonly string[]): boolean {
    if (
      !Array.isArray(ruleIds)
      || ruleIds.length > MAX_INJECTED_RULES
      || new Set(ruleIds).size !== ruleIds.length
      || ruleIds.some(id => typeof id !== 'string' || !RULE_ID.test(id))
    ) return false
    const state = this.find(sessionId, turnId)
    if (state === undefined || state.captured || state.filtered) return false
    state.injectedRuleIds = [...ruleIds]
    state.touchedAt = this.now()
    return true
  }

  observeTool(
    sessionId: unknown,
    turnId: unknown,
    step: WorkflowStep,
    errorKind: ErrorKind = 'none',
  ): boolean {
    const state = this.find(sessionId, turnId)
    if (state === undefined || state.captured || state.filtered) return false
    const previous = state.workflowSteps.at(-1)
    if (previous !== step) {
      if (state.workflowSteps.length < MAX_WORKFLOW_STEPS) state.workflowSteps.push(step)
      else state.workflowSteps[MAX_WORKFLOW_STEPS - 1] = 'other'
    }
    if (errorKind !== 'none') state.errorKind = errorKind
    state.touchedAt = this.now()
    return true
  }

  observeAssistant(sessionId: unknown, turnId: unknown, outcome: Outcome): boolean {
    const state = this.find(sessionId, turnId)
    if (state === undefined || state.captured || state.filtered) return false
    state.assistantOutcome = outcome
    state.touchedAt = this.now()
    return true
  }

  observeError(sessionId: unknown, turnId: unknown, errorKind: ErrorKind): boolean {
    const state = this.find(sessionId, turnId)
    if (state === undefined || state.captured || state.filtered) return false
    state.errorKind = errorKind === 'none' ? 'unknown' : errorKind
    state.assistantOutcome = 'failure'
    state.touchedAt = this.now()
    return true
  }

  markFiltered(sessionId: unknown, turnId: unknown): boolean {
    const state = this.find(sessionId, turnId)
    if (state === undefined || state.captured || state.filtered) return false
    state.filtered = true
    state.touchedAt = this.now()
    return true
  }

  claimCapture(sessionId: unknown, turnId: unknown): TurnSnapshot | undefined {
    const state = this.find(sessionId, turnId)
    if (state === undefined || state.captured || state.filtered) return undefined
    state.captured = true
    state.touchedAt = this.now()
    return copyTurn(state)
  }

  markSubagent(sessionId: unknown): void {
    this.subagents.set(identity(sessionId, 'session'), this.now())
  }

  isSubagent(sessionId: unknown): boolean {
    const session = identity(sessionId, 'session')
    const now = this.now()
    this.cleanupAt(now)
    if (!this.subagents.has(session)) return false
    this.subagents.set(session, now)
    return true
  }

  discardSession(sessionId: unknown): number {
    const session = identity(sessionId, 'session')
    let removed = 0
    for (const [key, state] of this.turns) {
      if (state.sessionId !== session) continue
      this.turns.delete(key)
      removed += 1
    }
    this.subagents.delete(session)
    return removed
  }

  cleanup(): number {
    return this.cleanupAt(this.now())
  }

  get size(): number {
    this.cleanup()
    return this.turns.size
  }

  private find(sessionId: unknown, turnId: unknown): TurnSnapshot | undefined {
    const session = identity(sessionId, 'session')
    const turn = identity(turnId, 'turn')
    return this.turns.get(keyFor(session, turn))
  }

  private cleanupAt(now: number): number {
    const cutoff = now - this.ttlMs
    let removed = 0
    for (const [key, state] of this.turns) {
      if (state.touchedAt > cutoff) continue
      this.turns.delete(key)
      removed += 1
    }
    for (const [session, touchedAt] of this.subagents) {
      if (touchedAt > cutoff) continue
      this.subagents.delete(session)
      removed += 1
    }
    return removed
  }

  private makeRoom(): boolean {
    if (this.turns.size < this.maxEntries) return true
    let eviction: [string, TurnSnapshot] | undefined
    for (const entry of this.turns) {
      const state = entry[1]
      if (!state.captured && !state.filtered) continue
      if (eviction === undefined || state.touchedAt < eviction[1].touchedAt) eviction = entry
    }
    if (eviction === undefined) return false
    this.turns.delete(eviction[0])
    return this.turns.size < this.maxEntries
  }
}
