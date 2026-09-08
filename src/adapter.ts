import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { checkFiles, parseCheckerCommand, type FileCheckRequest } from '../agent-product/src/verification-files.js'
import { verificationReportSchema, type CheckerId, type VerificationPlan, type VerificationReport, type VerificationRevision } from '../agent-product/src/verification.js'
import { buildRepairGuidance } from '../agent-product/src/improvement.js'
import { validateAdapterDescriptor } from './adapter-contract.js'
import type { AdvisorRoute } from './advisor.js'
import { classifyError } from './classifier.js'
import {
  EvolutionEngine,
  type EvolutionEngineWarningCode,
  type EvolutionStoreLike,
  type PreparedTurn,
} from './engine.js'
import { TurnRegistry } from './registry.js'
import { sha256 } from './lifecycle.js'
import type { EvolutionStore } from './store.js'
import type { ExperienceScope, Outcome, ResolvedConfig } from './types.js'

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
  readonly cwd?: string
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
  readonly seq?: number
  eventAt?(index: number): SessionEventLike | undefined
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
  readonly arguments?: unknown
  readonly rootCallId?: string
  readonly parent?: unknown
  readonly signal?: AbortSignal
}

export interface ToolResultLike {
  readonly isError: boolean
  readonly error?: { readonly name?: string, readonly code?: string }
  readonly value?: unknown
}

export interface AgentErrorLike {
  readonly agent: AgentLike
  readonly turn: number
  readonly step: number
  readonly error: unknown
}

export interface StoreLike extends EvolutionStoreLike {}

export interface MseAdapterOptions {
  store: StoreLike | EvolutionStore
  registry?: TurnRegistry
  config?: ResolvedConfig
  now?: () => number
  warn?: (code: AdapterWarningCode) => void
  nativeMessage?: (text: string) => HarnessUserMessage
  repairMessage?: (text: string) => HarnessUserMessage
  instanceKey?: string
  checker?: NativeCheckerRegistration
}

export interface NativeCheckerRegistration {
  readonly executable: string
  readonly cliPath: string
  readonly electron?: boolean
}

interface AcceptedVerificationPlan extends VerificationPlan {
  readonly scope?: Readonly<ExperienceScope>
}

interface PendingRepair {
  report: VerificationReport
  cwd: string
  request: FileCheckRequest
  evidenceGeneration: number
  selectionGeneration: number
  plans: readonly AcceptedVerificationPlan[]
}

interface NativeTurn {
  agent: AgentLike | undefined
  signal: AbortSignal | undefined
  closed: boolean
  cancelled: boolean
  checkers: Set<CheckerId>
  pairs: Map<string, { cwd: string, request: FileCheckRequest }>
  closedCallIds: Set<string>
  receiptOverflow: boolean
  touchedAt: number
  checksSeen: Map<CheckerId, number>
  pendingRepair: PendingRepair | undefined
  evidenceGeneration: number
  selectionGeneration: number
  repairOffered: boolean
  checkingOnly: boolean
  repairAuthorized: boolean
  userRequestHash: string | undefined
  plans: Map<string, AcceptedVerificationPlan>
}

const MAX_NATIVE_TURNS = 1_000
const MAX_PAIRS = 24
const MAX_CLOSED_CALLS = 1_000

export type AdapterWarningCode = EvolutionEngineWarningCode

export const HARNESS_ADAPTER_DESCRIPTOR = validateAdapterDescriptor({
  schemaVersion: 1,
  id: 'deepseek-harness',
  displayName: 'DeepSeek Harness',
  version: '0.7.0',
  capabilities: [
    'turns',
    'tools',
    'assistant-outcome',
    'errors',
    'session-dispose',
    'model-route',
  ],
})

export class MseAdapter {
  readonly registry: TurnRegistry
  private readonly engine: EvolutionEngine
  private readonly store: StoreLike
  private readonly warn: (code: AdapterWarningCode) => void
  private disposed = false
  private readonly nativeMessage: MseAdapterOptions['nativeMessage']
  private readonly repairMessage: MseAdapterOptions['repairMessage']
  private readonly pendingNative = new Map<string, { prepared: PreparedTurn, messageId: string }>()
  private readonly nativeTurns = new Map<string, NativeTurn>()
  private readonly checker: NativeCheckerRegistration | undefined
  private readonly now: () => number
  private queue: Promise<void> = Promise.resolve()

  constructor(options: MseAdapterOptions) {
    this.registry = options.registry ?? new TurnRegistry()
    this.store = options.store
    this.warn = options.warn ?? (() => undefined)
    this.nativeMessage = options.nativeMessage
    this.repairMessage = options.repairMessage ?? options.nativeMessage
    this.checker = options.checker === undefined ? undefined : Object.freeze({ ...options.checker })
    this.now = options.now ?? Date.now
    this.engine = new EvolutionEngine({
      store: options.store,
      registry: this.registry,
      ...(options.config === undefined ? {} : { config: options.config }),
      ...(options.now === undefined ? {} : { now: options.now }),
      warn: this.warn,
      ...(options.instanceKey === undefined ? {} : { instanceKey: options.instanceKey }),
    })
  }

  async preStep(
    payload: PreStepPayload,
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> {
    const prompt = directUserText(payload.messages)
    const current = this.nativeTurns.get(turnKey(payload.agent.session.id, payload.turn))
    if (current?.agent === payload.agent) this.observeNativeRequest(current, prompt)
    const decision = await next()
    if (
      this.disposed
      || decision.kind === 'reject'
      || payload.signal.aborted
      || this.filteredSession(payload.agent.session)
    ) return decision

    if (payload.step !== 1) {
      if (!Number.isSafeInteger(payload.step) || payload.step < 2) return decision
      try { return await this.offerRepair(payload, decision) }
      catch { this.warn('capture_failed'); return decision }
    }

    if (prompt === '') return decision
    try {
      await this.queue
      if (this.disposed || payload.signal.aborted) return decision
      for (const [key, turn] of this.nativeTurns) {
        if (turn.touchedAt <= this.now() - 60 * 60 * 1_000) this.nativeTurns.delete(key)
      }
      for (const [session, pending] of this.pendingNative) {
        if (!this.engine.isPreparedCurrent(pending.prepared)) this.pendingNative.delete(session)
      }
      const route = safeAdvisorRoute(payload.agent.options)
      const input = {
        sessionId: payload.agent.session.id,
        turnId: payload.turn,
        prompt,
        ...(payload.agent.session.header.cwd === undefined ? {} : { projectKey: payload.agent.session.header.cwd }),
        ...(route === null ? {} : { route }),
      }
      await this.engine.observeTurn(input)
      const native = this.nativeTurn(input.sessionId, input.turnId)
      if (native !== undefined && !native.closed) {
        native.agent = payload.agent
        native.signal = payload.signal
        this.observeNativeRequest(native, prompt)
      }
      if (this.nativeMessage !== undefined) {
        const prepared = await this.engine.prepareTurn(input)
        if (prepared !== null) {
          if (payload.signal.aborted) { this.engine.cancelInjection(prepared); return decision }
          const message = prepared.instruction === '' ? undefined : this.nativeMessage(prepared.instruction)
          const acceptedMessageId = message?.id ?? decision.messages.find(item => item.source.kind === 'user')?.id
          if (acceptedMessageId === undefined) { this.engine.cancelInjection(prepared); return decision }
          if (this.pendingNative.size >= 1_000 && !this.pendingNative.has(input.sessionId)) {
            this.engine.cancelInjection(prepared)
            return decision
          }
          this.pendingNative.set(input.sessionId, { prepared, messageId: acceptedMessageId })
          if (message !== undefined) return { ...decision, messages: [...decision.messages, message] }
        }
      }
      return decision
    } catch {
      this.warn('state_unavailable')
      return decision
    }
  }

  async prepareBrainRecall(input: {
    sessionId: string
    turnId: number
    prompt: string
    projectKey: string
  }): Promise<PreparedTurn | null> {
    await this.queue
    if (this.disposed) return null
    return this.engine.prepareTurn({
      sessionId: input.sessionId,
      turnId: input.turnId,
      prompt: input.prompt,
      projectKey: input.projectKey,
    })
  }

  acceptBrainRecall(prepared: PreparedTurn, ruleIds: readonly string[]): boolean {
    const turn = this.nativeTurns.get(turnKey(prepared.sessionId, prepared.turnId))
    if (this.disposed || turn?.closed || turn?.cancelled || turn?.signal?.aborted) return false
    if (!this.engine.acceptInjection(prepared, ruleIds)) return false
    this.acceptPlans(prepared, ruleIds)
    return true
  }

  cancelBrainRecall(prepared: PreparedTurn): boolean {
    return this.engine.cancelInjection(prepared)
  }

  toolsResult(exec: ToolExecutionLike, result: ToolResultLike): void {
    try {
      if (this.disposed || exec.agent === undefined || this.filteredSession(exec.agent.session)) return
      const turn = findExecutionTurn(exec)
      if (turn === undefined) return
      const sessionId = exec.agent.session.id
      const native = this.nativeTurns.get(turnKey(sessionId, turn))
      if (native === undefined || native.closed || native.agent !== exec.agent) return
      if (native.receiptOverflow || native.closedCallIds.has(exec.callId)) return
      if (native.closedCallIds.size >= MAX_CLOSED_CALLS) {
        native.receiptOverflow = true
        this.enqueue(() => { this.registry.markFiltered(sessionId, turn); this.warn('capture_failed') })
        return
      }
      // tools/result settles this call, including a background-job acknowledgement.
      native.closedCallIds.add(exec.callId)
      // Invalidate before queued I/O, including checker receipts whose replacement binding is rejected.
      if (exec.name !== 'read' && exec.name !== 'read_image') this.invalidateRepair(native)
      const evidenceGeneration = native.evidenceGeneration
      const selectionGeneration = native.selectionGeneration
      const value = objectValue(result.value)
      const args = objectValue(exec.arguments)
      const pending = value?.kind === 'background' || value?.status === 'running' || args?.run_in_background === true
      const cancelled = exec.signal?.aborted === true || value?.aborted === true
      const exitedBadly = typeof value?.exitCode === 'number' && Number.isSafeInteger(value.exitCode) && value.exitCode !== 0
      const classified = value?.timedOut === true ? 'timeout'
        : exitedBadly || cancelled ? 'tool_error'
        : result.isError
        ? classifyError(`${result.error?.name ?? ''} ${result.error?.code ?? ''}`)
        : 'none'
      const exitCode = pending || cancelled || result.isError || value?.timedOut === true
        || (value?.signal !== undefined && value.signal !== null)
        ? null : typeof value?.exitCode === 'number' && Number.isSafeInteger(value.exitCode) ? value.exitCode : null
      const request = exec.name === 'bash' && this.checker !== undefined && !pending
        ? parseNativeCheckerCommand(args?.command, this.checker) : null
      const reported = exitCode === 0 && !result.isError ? parseNativeReport(value?.stdout) : null
      const eligible = request !== null && native.checkers.has(request.checkerId)
      const headerCwd = exec.agent.session.header.cwd
      const workdir = args?.workdir
      this.enqueue(async () => {
        const check = eligible && request && reported && reported.checkerId === request.checkerId
          && !native.cancelled && !native.signal?.aborted && !exec.signal?.aborted
          && (native.pairs.size < MAX_PAIRS || native.pairs.has(reported.bindingHash))
          ? { request, reported } : null
        const cwd = check === null ? null : await authoritativeCwd(headerCwd, workdir)
        const previous = check === null ? undefined : native.pairs.get(check.reported.bindingHash)
        const changedPair = check !== null && previous !== undefined
          && (previous.cwd !== cwd || !sameFileRequest(previous.request, check.request))
        const readOnly = !changedPair && ((request !== null && exitCode === 0) || exec.name === 'read' || exec.name === 'read_image')
        this.engine.observeTool({
          sessionId, turnId: turn, toolName: exec.name,
          errorKind: classified === 'none' && result.isError ? 'tool_error' : classified,
          ...(exec.name === 'bash' ? { exitCode } : {}),
          readOnly,
        })
        if (check === null || cwd === null || changedPair) return
        // Only reread the explicit pair authorized by this normal terminal invocation.
        const actual = await checkFiles(cwd, check.request)
        if (!sameReport(check.reported, actual) || native.cancelled || native.signal?.aborted || exec.signal?.aborted) return
        if (this.engine.observeVerification({ sessionId, turnId: turn, report: check.reported })) {
          if (previous === undefined) native.pairs.set(check.reported.bindingHash, { cwd, request: check.request })
          const count = (native.checksSeen.get(check.reported.checkerId) ?? 0) + 1
          native.checksSeen.set(check.reported.checkerId, count)
          if (native.pendingRepair?.report.checkerId === check.reported.checkerId) native.pendingRepair = undefined
          if (!native.repairOffered && evidenceGeneration === native.evidenceGeneration
            && selectionGeneration === native.selectionGeneration
            && count === 1 && check.reported.status === 'fail'
            && buildRepairGuidance(check.reported) !== null) {
            const plans = [...native.plans.values()].filter(plan => plan.checkerId === check.reported.checkerId && plan.scope !== undefined)
            if (plans.length > 0) native.pendingRepair ??= { report: check.reported, cwd, request: check.request,
              evidenceGeneration, selectionGeneration, plans }
          }
        }
      })
    } catch {
      this.warn('capture_failed')
    }
  }

  sessionEvent(session: SessionLike, event: SessionEventLike): void {
    try {
      if (this.disposed) return
      if (event.type === 'user/message') {
        const pending = this.pendingNative.get(session.id)
        if (pending !== undefined && event.data.id === pending.messageId) {
          if (!this.acceptBrainRecall(pending.prepared, pending.prepared.ruleIds)) this.engine.cancelInjection(pending.prepared)
          this.pendingNative.delete(session.id)
        }
        return
      }
      if (event.type === 'assistant/message') {
        const turn = safeTurn(event.data.turn)
        if (turn !== undefined) {
          const outcome = classifyAssistant(event.data.message)
          this.enqueue(() => { this.engine.observeAssistant({
            sessionId: session.id,
            turnId: turn,
            outcome,
          }) })
        }
        return
      }
      if (event.type !== 'turn/end') return
      const pending = this.pendingNative.get(session.id)
      if (pending !== undefined) {
        this.engine.cancelInjection(pending.prepared)
        this.pendingNative.delete(session.id)
      }
      const turn = safeTurn(event.data.turn)
      if (turn === undefined) return
      const reasonKind = completionReason(event.data.reason)
      const key = turnKey(session.id, turn)
      const native = this.nativeTurns.get(key)
      if (native?.closed) return
      if (native !== undefined) {
        native.closed = true
        native.cancelled ||= reasonKind === 'aborted' || native.signal?.aborted === true
      }
      this.enqueue(async () => {
        try {
          const finalVerificationRevisions: VerificationRevision[] = []
          if (reasonKind === 'completed' && native !== undefined && !native.cancelled && !native.signal?.aborted) {
            for (const pair of native.pairs.values()) {
              const actual = await checkFiles(pair.cwd, pair.request)
              finalVerificationRevisions.push({ bindingHash: actual.bindingHash,
                sourceHash: actual.sourceHash, artifactHash: actual.artifactHash })
            }
          }
          if (reasonKind === 'aborted' || native?.cancelled || native?.signal?.aborted) this.registry.markFiltered(session.id, turn)
          this.engine.completeTurn({
            sessionId: session.id, turnId: turn,
            outcome: reasonKind === 'error' ? 'failure' : reasonKind === 'completed' ? 'success' : 'partial',
            completed: reasonKind === 'completed', occurredAt: event.time, finalVerificationRevisions,
          })
        } finally { this.nativeTurns.delete(key) }
      })
    } catch {
      this.warn('capture_failed')
    }
  }

  agentError(payload: AgentErrorLike): void {
    try {
      if (this.disposed) return
      const classified = classifyError(errorIdentity(payload.error))
      this.enqueue(() => { this.engine.observeError({
        sessionId: payload.agent.session.id,
        turnId: payload.turn,
        errorKind: classified === 'none' ? 'unknown' : classified,
      }) })
    } catch {
      this.warn('capture_failed')
    }
  }

  sessionDisposed(session: SessionLike): void {
    if (this.disposed) return
    this.pendingNative.delete(session.id)
    for (const [key, native] of this.nativeTurns) {
      if (key.startsWith(`${session.id.length}:${session.id}`) && !native.closed) native.cancelled = true
    }
    this.enqueue(() => {
      for (const key of this.nativeTurns.keys()) {
        if (key.startsWith(`${session.id.length}:${session.id}`)) this.nativeTurns.delete(key)
      }
      this.engine.disposeSession(session.id)
    })
  }

  async drain(): Promise<void> {
    let queued: Promise<void>
    do { queued = this.queue; await queued } while (queued !== this.queue)
    await this.engine.drain()
  }

  advisorRoute(): AdvisorRoute | null {
    return this.engine.advisorRoute()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.drain()
    this.pendingNative.clear()
    this.nativeTurns.clear()
    await this.engine.dispose()
  }

  private enqueue(work: () => void | Promise<void>): void {
    this.queue = this.queue.then(work).catch(() => { this.warn('capture_failed') })
  }

  private async offerRepair(payload: PreStepPayload, decision: Extract<PreStepDecision, { kind: 'enter' }>): Promise<PreStepDecision> {
    await this.queue
    const native = this.nativeTurns.get(turnKey(payload.agent.session.id, payload.turn))
    if (this.repairMessage === undefined || native === undefined || native.repairOffered || native.pendingRepair === undefined) return decision
    const pending = native.pendingRepair
    if (!this.repairCurrent(native, pending, payload)) return decision
    // Reserve synchronously before the reread so concurrent hooks cannot duplicate the attempt.
    native.repairOffered = true
    native.pendingRepair = undefined
    if (!(await this.store.load()).enabled || !this.repairCurrent(native, pending, payload)) return decision
    const actual = await checkFiles(pending.cwd, pending.request)
    const state = await this.store.load()
    const stillApplicable = pending.plans.some(plan => native.plans.get(verificationPlanKey(plan)) === plan
      && plan.scope !== undefined && plan.scope.kind !== 'global' && plan.scope.keyHash !== null
      && state.rules.some(rule => rule.id === plan.ruleId && rule.instructionHash === plan.instructionHash
        && rule.status === 'guardrail' && (rule.expiresAt === null || rule.expiresAt > this.now())
        && rule.constraintIds?.includes(plan.constraintId) && rule.scope?.kind === plan.scope?.kind
        && rule.scope?.keyHash === plan.scope?.keyHash))
    if (!state.enabled || !stillApplicable || !sameReport(pending.report, actual)
      || !this.repairCurrent(native, pending, payload)) return decision
    const guidance = buildRepairGuidance(actual)
    if (guidance === null) return decision
    return { ...decision, messages: [...decision.messages, this.repairMessage(guidance)] }
  }

  private repairCurrent(native: NativeTurn, pending: PendingRepair, payload: PreStepPayload): boolean {
    return !this.disposed && !native.closed && !native.cancelled && !native.signal?.aborted && !payload.signal.aborted
      && this.nativeTurns.get(turnKey(payload.agent.session.id, payload.turn)) === native && native.agent === payload.agent
      && !native.receiptOverflow && !native.checkingOnly && native.repairAuthorized
      && native.evidenceGeneration === pending.evidenceGeneration && native.checksSeen.get(pending.report.checkerId) === 1
      && native.selectionGeneration === pending.selectionGeneration && native.checkers.has(pending.report.checkerId)
      && pending.plans.some(plan => native.plans.get(verificationPlanKey(plan)) === plan)
      && native.touchedAt > this.now() - 60 * 60 * 1_000
      && this.registry.canSetVerificationPlans(payload.agent.session.id, payload.turn, [])
  }

  private invalidateRepair(native: NativeTurn): void {
    native.evidenceGeneration += 1
    native.pendingRepair = undefined
  }

  private observeNativeRequest(native: NativeTurn, text: string): void {
    if (text === '') return
    const requestHash = sha256(text)
    if (native.userRequestHash === requestHash) return
    this.invalidateRepair(native)
    native.userRequestHash = requestHash
    native.checkingOnly ||= checkingOnlyTask(text)
    native.repairAuthorized = localCorrectionTask(text)
  }

  private nativeTurn(sessionId: string, turnId: string | number): NativeTurn | undefined {
    const key = turnKey(sessionId, turnId)
    let native = this.nativeTurns.get(key)
    if (native === undefined && this.nativeTurns.size < MAX_NATIVE_TURNS) {
      native = { agent: undefined, signal: undefined, closed: false, cancelled: false,
        checkers: new Set(), pairs: new Map(), closedCallIds: new Set(), receiptOverflow: false, touchedAt: this.now(),
        checksSeen: new Map(), pendingRepair: undefined, evidenceGeneration: 0, selectionGeneration: 0, repairOffered: false,
        checkingOnly: false, repairAuthorized: false, userRequestHash: undefined, plans: new Map() }
      this.nativeTurns.set(key, native)
    }
    return native
  }

  private acceptPlans(prepared: PreparedTurn, ruleIds: readonly string[]): void {
    const native = this.nativeTurn(prepared.sessionId, prepared.turnId)
    if (native === undefined) return
    this.invalidateRepair(native)
    native.selectionGeneration += 1
    native.plans.clear()
    native.checkers.clear()
    for (const plan of prepared.verificationPlans.slice(0, MAX_PAIRS)) {
      if (plan.checkerId !== null && ruleIds.includes(plan.ruleId)) {
        const scope = prepared.rules.find(rule => rule.id === plan.ruleId)?.scope
        native.checkers.add(plan.checkerId)
        native.plans.set(verificationPlanKey(plan), Object.freeze({ ...plan,
          ...(scope === undefined ? {} : { scope: Object.freeze({ ...scope }) }) }))
      }
    }
  }

  private filteredSession(session: SessionLike): boolean {
    if (session.header.origin === 'subagent' || (session.header.delegationDepth ?? 0) > 0) {
      this.registry.markSubagent(session.id)
      return true
    }
    return this.registry.isSubagent(session.id)
  }
}

function verificationPlanKey(plan: VerificationPlan): string {
  return `${plan.ruleId}:${plan.instructionHash}:${plan.constraintId}`
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

function checkingOnlyTask(text: string): boolean {
  return /只读|仅(?:做)?(?:检查|核对|报告)|只(?:需|要)?(?:检查|核对|报告)|(?:不要|不得|禁止|不许|不准|不允许|别|不)\s*(?:再)?(?:修改|改动|改文件|写入|修复|修正|更正)|read[ -]?only|(?:do not|don't|must not|never)\s+(?:fix|repair|modify|write|change|edit)|\bno\s+(?:edits?|changes?|modifications?)\b|(?:only|just)\s+(?:check|inspect|report)/iu.test(text)
}

function localCorrectionTask(text: string): boolean {
  if (checkingOnlyTask(text)) return false
  // Only explicit local-artifact requests grant hint eligibility; quoted/code examples do not.
  return text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu, '')
    .split(/[。.;；\r\n]/u).some(part => /^(?:请|允许|授权)(?:修正|更正|修复)本地(?:产物|输出文件|数据文件)$/u.test(part.trim())
      || /^(?:please (?:correct|repair)|I (?:allow|authorize) (?:correcting|repairing)) the local (?:artifact|output file|data file)$/iu.test(part.trim()))
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

function findExecutionTurn(exec: ToolExecutionLike): number | undefined {
  const session = exec.agent!.session
  const nested = exec.parent !== undefined
  if (nested && (typeof exec.parent !== 'symbol' || !exec.rootCallId || exec.rootCallId === exec.callId)) return undefined
  if (!nested && exec.rootCallId !== undefined && exec.rootCallId !== exec.callId) return undefined
  const callId = nested ? exec.rootCallId : exec.callId
  const count = session.seq ?? session.events?.length ?? 0
  for (let index = count - 1; index >= Math.max(0, count - 1_000); index -= 1) {
    const event = session.eventAt?.(index) ?? session.events?.[index]
    if (event?.type !== 'tool/call' || event.data.callId !== callId) continue
    if (nested ? typeof event.data.name !== 'string' : event.data.name !== undefined && event.data.name !== exec.name) return undefined
    return safeTurn(event.data.turn)
  }
  return undefined
}

function turnKey(sessionId: string, turnId: string | number): string {
  return `${sessionId.length}:${sessionId}${turnId}`
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function parseNativeCheckerCommand(command: unknown, registration: NativeCheckerRegistration): FileCheckRequest | null {
  if (typeof command !== 'string' || /[\r\n\x00]/u.test(command)
    || !isAbsolute(registration.executable) || !isAbsolute(registration.cliPath)) return null
  const prefix = 'ELECTRON_RUN_AS_NODE=1 '
  const actual = registration.electron === true && command.startsWith(prefix) ? command.slice(prefix.length) : command
  if (registration.electron === true && actual === command) return null
  return parseCheckerCommand(actual, registration.executable, registration.cliPath)
}

function parseNativeReport(stdout: unknown): VerificationReport | null {
  const stream = objectValue(stdout)
  const text = typeof stdout === 'string' ? stdout : stream?.truncated === false ? stream.text : undefined
  if (typeof text !== 'string' || text.length > 4_096) return null
  try {
    const parsed = verificationReportSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch { return null }
}

function sameReport(a: VerificationReport, b: VerificationReport): boolean {
  return (Object.keys(a) as (keyof VerificationReport)[]).every(key => a[key] === b[key])
}

function sameFileRequest(a: FileCheckRequest, b: FileCheckRequest): boolean {
  return a.checkerId === b.checkerId && a.source === b.source && a.artifact === b.artifact
    && a.key === b.key && a.field === b.field
}

async function authoritativeCwd(headerCwd: string | undefined, workdir: unknown): Promise<string | null> {
  if (workdir !== undefined && (typeof workdir !== 'string' || !workdir || workdir.length > 4_096)) return null
  try {
    if (typeof workdir === 'string' && isAbsolute(workdir)) return await realpath(workdir)
    if (headerCwd === undefined || !isAbsolute(headerCwd)) return null
    const root = await realpath(headerCwd)
    return workdir === undefined ? root : await realpath(resolve(root, workdir as string))
  } catch { return null }
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

function completionReason(value: unknown): unknown {
  return value !== null && typeof value === 'object'
    ? (value as { kind?: unknown }).kind
    : undefined
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
