import type { AdvisorRoute } from './advisor.js'
import { classifyError, classifyPrompt, classifyTool } from './classifier.js'
import { capture, sha256 } from './lifecycle.js'
import { TurnRegistry, type TurnSnapshot } from './registry.js'
import type { EvolutionStore } from './store.js'
import type {
  AuditEvent,
  CaptureEvent,
  EvolutionState,
  Outcome,
  ResolvedConfig,
} from './types.js'

export interface HarnessUserMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly Record<string, unknown>[]
  readonly source: {
    readonly kind: string
    readonly plugin?: string
    readonly form?: string
  }
}

export type PreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter', messages: HarnessUserMessage[] }

export interface SessionHeaderLike {
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
}

export interface SessionEventLike {
  readonly type: string
  readonly time: number
  readonly data: Record<string, unknown>
}

export interface SessionLike {
  readonly id: string
  readonly header: SessionHeaderLike
  readonly events: SessionEventLike[]
}

export interface AgentLike {
  readonly id: string
  readonly options: { readonly provider?: string, readonly model?: string }
  readonly session: SessionLike
}

export interface PreStepPayload {
  readonly agent: AgentLike
  readonly messages: HarnessUserMessage[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

export interface ToolExecutionLike {
  readonly agent?: AgentLike
  readonly callId: string
  readonly name: string
  readonly parent?: unknown
}

export interface ToolResultLike {
  readonly isError: boolean
  readonly error?: { readonly name?: string, readonly code?: string }
}

export interface AgentErrorLike {
  readonly agent: AgentLike
  readonly turn: number
  readonly step: number
  readonly error: unknown
}

export interface StoreLike {
  load(): Promise<EvolutionState>
  update(
    expectedRevision: number,
    mutate: (state: EvolutionState) => EvolutionState,
  ): Promise<EvolutionState>
  appendAudit(event: AuditEvent): Promise<void>
}

export interface MseAdapterOptions {
  store: StoreLike | EvolutionStore
  registry?: TurnRegistry
  config?: ResolvedConfig
  now?: () => number
  warn?: (code: AdapterWarningCode) => void
}

export type AdapterWarningCode =
  | 'state_unavailable'
  | 'capture_failed'
  | 'audit_failed'
  | 'injection_metric_failed'

const LOCK_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 640, 1_000] as const

export class MseAdapter {
  readonly registry: TurnRegistry
  private readonly store: StoreLike
  private readonly now: () => number
  private readonly warn: (code: AdapterWarningCode) => void
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  private latestAdvisorRoute: AdvisorRoute | null = null

  constructor(options: MseAdapterOptions) {
    this.store = options.store
    this.registry = options.registry ?? new TurnRegistry()
    this.now = options.now ?? Date.now
    this.warn = options.warn ?? (() => undefined)
  }

  async preStep(
    payload: PreStepPayload,
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> {
    const decision = await next()
    if (
      this.disposed
      || decision.kind === 'reject'
      || payload.signal.aborted
      || payload.step !== 1
      || this.filteredSession(payload.agent.session)
    ) return decision

    const prompt = directUserText(payload.messages)
    if (prompt === '') return decision
    const route = safeAdvisorRoute(payload.agent.options)
    if (route !== null) this.latestAdvisorRoute = route
    try {
      const state = await this.store.load()
      if (!state.enabled) return decision
      const classification = classifyPrompt(prompt)
      const opened = this.registry.open(payload.agent.session.id, payload.turn, {
        taskHash: sha256(`${payload.agent.session.id}:${payload.turn}`),
        taskType: classification.taskType,
        correction: classification.correction,
        preference: classification.preference,
      })
      if (opened === undefined) return decision
      return decision
    } catch {
      this.warn('state_unavailable')
      return decision
    }
  }

  acceptInjectedRules(sessionId: string, turn: number, ruleIds: readonly string[]): boolean {
    if (this.disposed || !this.registry.setInjectedRules(sessionId, turn, ruleIds)) return false
    this.enqueue('injection_metric_failed', async () => {
      await this.updateWithRetry(current => ({
        ...current,
        counters: {
          ...current.counters,
          injections: current.counters.injections + ruleIds.length,
          weeklyInjections: current.counters.weeklyInjections + ruleIds.length,
        },
      }))
      await this.appendAudits([{
        schemaVersion: 1,
        at: this.now(),
        kind: 'rules_injected',
        count: ruleIds.length,
      }])
    })
    return true
  }

  toolsResult(exec: ToolExecutionLike, result: ToolResultLike): void {
    try {
      if (this.disposed || exec.agent === undefined || exec.parent !== undefined) return
      const turn = findToolTurn(exec.agent.session.events, exec.callId)
      if (turn === undefined) return
      const errorKind = result.isError
        ? classifyError(`${result.error?.name ?? ''} ${result.error?.code ?? ''}`) || 'tool_error'
        : 'none'
      this.registry.observeTool(
        exec.agent.session.id,
        turn,
        classifyTool(exec.name),
        errorKind === 'none' && result.isError ? 'tool_error' : errorKind,
      )
    } catch {
      this.warn('capture_failed')
    }
  }

  sessionEvent(session: SessionLike, event: SessionEventLike): void {
    try {
      if (this.disposed) return
      if (event.type === 'assistant/message') {
        const turn = safeTurn(event.data.turn)
        if (turn !== undefined) {
          this.registry.observeAssistant(session.id, turn, classifyAssistant(event.data.message))
        }
        return
      }
      if (event.type !== 'turn/end') return
      const turn = safeTurn(event.data.turn)
      if (turn === undefined) return
      const snapshot = this.registry.claimCapture(session.id, turn)
      if (snapshot === undefined) return
      const captureEvent = toCaptureEvent(snapshot, event)
      this.enqueue('capture_failed', async () => {
        let audit: AuditEvent[] = []
        await this.updateWithRetry(current => {
          const result = capture(current, captureEvent)
          audit = result.audit
          return result.state
        })
        await this.appendAudits(audit)
      })
    } catch {
      this.warn('capture_failed')
    }
  }

  agentError(payload: AgentErrorLike): void {
    try {
      const classified = classifyError(errorIdentity(payload.error))
      this.registry.observeError(
        payload.agent.session.id,
        payload.turn,
        classified === 'none' ? 'unknown' : classified,
      )
    } catch {
      this.warn('capture_failed')
    }
  }

  sessionDisposed(session: SessionLike): void {
    try {
      this.registry.discardSession(session.id)
    } catch {
      this.warn('capture_failed')
    }
  }

  drain(): Promise<void> {
    return this.queue
  }

  advisorRoute(): AdvisorRoute | null {
    return this.latestAdvisorRoute === null ? null : { ...this.latestAdvisorRoute }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.drain()
  }

  private filteredSession(session: SessionLike): boolean {
    if (session.header.origin === 'subagent' || (session.header.delegationDepth ?? 0) > 0) {
      this.registry.markSubagent(session.id)
      return true
    }
    return this.registry.isSubagent(session.id)
  }

  private enqueue(code: AdapterWarningCode, work: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      if (this.disposed && code !== 'capture_failed') return
      try {
        await work()
      } catch {
        this.warn(code)
      }
    })
  }

  private async updateWithRetry(
    mutate: (state: EvolutionState) => EvolutionState,
  ): Promise<EvolutionState> {
    for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt += 1) {
      let current: EvolutionState
      try {
        current = await this.store.load()
      } catch (error) {
        if (hasCode(error, 'lock_busy') && attempt < LOCK_RETRY_DELAYS_MS.length) {
          await retryDelay(attempt)
          continue
        }
        throw error
      }
      try {
        return await this.store.update(current.revision, mutate)
      } catch (error) {
        if (
          attempt === LOCK_RETRY_DELAYS_MS.length
          || (!hasCode(error, 'revision_conflict') && !hasCode(error, 'lock_busy'))
        ) throw error
        if (hasCode(error, 'lock_busy')) await retryDelay(attempt)
      }
    }
    throw new Error('unreachable')
  }

  private async appendAudits(events: readonly AuditEvent[]): Promise<void> {
    for (const event of events) {
      try {
        await this.store.appendAudit(event)
      } catch {
        this.warn('audit_failed')
      }
    }
  }
}

function directUserText(messages: readonly HarnessUserMessage[]): string {
  const texts: string[] = []
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    for (const block of message.content) {
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    }
  }
  return texts.join('\n').slice(0, 32 * 1_024)
}

function safeAdvisorRoute(options: AgentLike['options']): AdvisorRoute | null {
  const { provider, model } = options
  if (!validRoutePart(provider) || !validRoutePart(model)) return null
  return { provider, model }
}

function validRoutePart(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function findToolTurn(events: readonly SessionEventLike[], callId: string): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'tool/call' || event.data.callId !== callId) continue
    return safeTurn(event.data.turn)
  }
  return undefined
}

function safeTurn(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? value as number : undefined
}

function classifyAssistant(value: unknown): Outcome {
  if (value === null || typeof value !== 'object') return 'partial'
  const content = (value as { content?: unknown }).content
  if (!Array.isArray(content)) return 'partial'
  const text = content.flatMap(block =>
    block !== null
    && typeof block === 'object'
    && (block as { type?: unknown }).type === 'text'
    && typeof (block as { text?: unknown }).text === 'string'
      ? [(block as { text: string }).text]
      : []).join('\n').slice(0, 32 * 1_024).trim()
  if (text === '') return 'partial'
  if (/(?:^|[\n。！？!?])\s*(?:抱歉[，,\s]*)?(?:这个)?我(?:不能|无法|没法)|\b(?:i|we)\s+(?:cannot|can't|won't|am unable)\b/iu.test(text)) {
    return 'partial'
  }
  return 'success'
}

function toCaptureEvent(snapshot: TurnSnapshot, event: SessionEventLike): CaptureEvent {
  const reason = event.data.reason
  const reasonKind = reason !== null && typeof reason === 'object'
    ? (reason as { kind?: unknown }).kind
    : undefined
  let outcome: Outcome
  if (snapshot.correction && reasonKind === 'completed') outcome = 'corrected'
  else if (reasonKind === 'error') outcome = 'failure'
  else if (reasonKind === 'completed') outcome = snapshot.assistantOutcome ?? 'success'
  else outcome = 'partial'
  const errorKind = outcome === 'failure'
    ? snapshot.errorKind === 'none' ? 'unknown' : snapshot.errorKind
    : 'none'
  return {
    schemaVersion: 1,
    taskHash: snapshot.taskHash,
    sessionHash: sha256(snapshot.sessionId),
    occurredAt: event.time,
    taskType: snapshot.taskType,
    outcome,
    correction: snapshot.correction,
    complexity: snapshot.workflowSteps.length >= 3
      ? 'high'
      : snapshot.workflowSteps.length > 0 ? 'medium' : 'low',
    workflowSteps: [...snapshot.workflowSteps],
    workflowSignature: sha256(JSON.stringify({
      taskType: snapshot.taskType,
      workflowSteps: snapshot.workflowSteps,
    })),
    errorKind,
    injectedRuleIds: [...snapshot.injectedRuleIds],
    preference: snapshot.preference,
  }
}

function errorIdentity(error: unknown): string {
  if (error === null || typeof error !== 'object') return ''
  const name = typeof (error as { name?: unknown }).name === 'string'
    ? (error as { name: string }).name
    : ''
  const code = typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : ''
  return `${name} ${code}`
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === 'object'
    && (error as { code?: unknown }).code === code
}

function retryDelay(attempt: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, LOCK_RETRY_DELAYS_MS[attempt] ?? 1_000))
}
