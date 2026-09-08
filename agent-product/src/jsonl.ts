import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { EvolutionEngine, type EvolutionStoreLike, type PreparedTurn } from './engine.js'
import { ERROR_KINDS, OUTCOMES } from './types.js'
import { learningDiagnostics } from './diagnostics.js'
import { CHECKER_IDS, verificationReportSchema } from './verification.js'
import { portableMethodsSchema, methodTargetSchema, importMethods, exportMethods, METHOD_IDS } from './improvement.js'

const id = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/u)
const turn = { sessionId: id, turnId: z.union([id, z.number().int().positive()]) }
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const revision = z.object({ bindingHash: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u), artifactHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
export const JsonlRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('prepare'), ...turn, prompt: z.string().max(32_768), projectKey: id.optional() }).strict(),
  z.object({ op: z.literal('accept'), receipt: z.string().uuid(), ruleIds: z.array(id).max(4) }).strict(),
  z.object({ op: z.literal('cancel'), receipt: z.string().uuid() }).strict(),
  z.object({ op: z.literal('tool'), ...turn, toolName: id, errorKind: z.enum(ERROR_KINDS),
    exitCode: z.number().int().safe().nullable().optional(), readOnly: z.boolean().optional() }).strict(),
  z.object({ op: z.literal('verification'), ...turn, report: verificationReportSchema }).strict(),
  z.object({ op: z.literal('capabilities') }).strict(),
  z.object({ op: z.literal('methods.import'), document: portableMethodsSchema, target: methodTargetSchema }).strict(),
  z.object({ op: z.literal('methods.export'), target: methodTargetSchema }).strict(),
  z.object({ op: z.literal('complete'), ...turn, outcome: z.enum(OUTCOMES), completed: z.boolean(), verificationPassed: z.boolean().optional(), occurredAt: timestamp,
    finalVerificationRevisions: z.array(revision).max(24).optional() }).strict(),
  z.object({ op: z.literal('close'), sessionId: id }).strict(),
  z.object({ op: z.literal('status') }).strict(),
])

/** Sequential local transport; receipts are process-local, bounded, and single-use. */
export class JsonlAdapter {
  private readonly engine: EvolutionEngine
  private readonly pending = new Map<string, PreparedTurn>()
  private readonly now: () => number
  constructor(private readonly store: EvolutionStoreLike, options: { now?: () => number, instanceKey?: string } = {}) {
    this.engine = new EvolutionEngine({ store, ...options })
    this.now = options.now ?? Date.now
  }

  async request(value: unknown): Promise<Record<string, unknown>> {
    const parsed = JsonlRequestSchema.safeParse(value)
    if (!parsed.success) return { ok: false, code: 'invalid_request' }
    const input = parsed.data
    try {
      switch (input.op) {
        case 'prepare': {
          for (const [receipt, prepared] of this.pending) {
            if (!this.engine.isPreparedCurrent(prepared)
              || (prepared.sessionId === input.sessionId && String(prepared.turnId) === String(input.turnId))) {
              this.engine.cancelInjection(prepared)
              this.pending.delete(receipt)
            }
          }
          const prepared = await this.engine.prepareTurn({
            sessionId: input.sessionId, turnId: input.turnId, prompt: input.prompt,
            ...(input.projectKey === undefined ? {} : { projectKey: input.projectKey }),
          })
          if (prepared === null) return { ok: true, receipt: null, ruleIds: [], instruction: '' }
          if (this.pending.size >= 128) {
            this.engine.cancelInjection(prepared)
            return { ok: false, code: 'receipt_capacity' }
          }
          const receipt = randomUUID()
          this.pending.set(receipt, prepared)
          return { ok: true, receipt, ruleIds: prepared.ruleIds, instruction: prepared.instruction,
            verificationPlans: prepared.verificationPlans }
        }
        case 'accept':
        case 'cancel': {
          const prepared = this.pending.get(input.receipt)
          if (prepared === undefined) return { ok: false, code: 'receipt_unknown' }
          const ok = input.op === 'accept'
            ? this.engine.acceptInjection(prepared, input.ruleIds)
            : this.engine.cancelInjection(prepared)
          if (!ok) this.engine.cancelInjection(prepared)
          this.pending.delete(input.receipt)
          await this.engine.drain()
          return { ok, ...(ok ? {} : { code: 'receipt_rejected' }) }
        }
        case 'tool': return { ok: this.engine.observeTool({ sessionId: input.sessionId, turnId: input.turnId,
          toolName: input.toolName, errorKind: input.errorKind,
          ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
          ...(input.readOnly === undefined ? {} : { readOnly: input.readOnly }) }) }
        case 'verification': return { ok: this.engine.observeVerification(input) }
        case 'capabilities': return { ok: true, protocolVersion: 1, verificationVersion: 1,
          checkerIds: CHECKER_IDS.filter(id => id !== 'regression-test-v1'),
          improvementVersion: 1, methodIds: [...METHOD_IDS], portableMethods: true, hostCallbackRepair: false,
          maxPlans: 24, maxAttempts: 2, evidenceBoundary: 'trusted_host_local_reference', deliveryGate: false }
        case 'methods.export': {
          await this.engine.drain()
          return { ok: true, document: exportMethods(await this.store.load(), input.target) }
        }
        case 'methods.import': {
          await this.engine.drain()
          for (let attempt = 0; attempt < 3; attempt++) {
            const current = await this.store.load()
            const result = importMethods(current, input.document, input.target, this.now())
            if (result.imported === 0) return { ok: true, imported: 0 }
            try {
              await this.store.update(current.revision, () => result.state)
              return { ok: true, imported: result.imported }
            } catch (error) {
              if (attempt === 2 || (error as { code?: unknown })?.code !== 'revision_conflict') throw error
            }
          }
          return { ok: false, code: 'revision_conflict' }
        }
        case 'complete': {
          // A host must explicitly acknowledge even a control-only prepared turn.
          this.cancelSession(input.sessionId, input.turnId)
          const receipt = await this.engine.completeTurnPersisted({
            sessionId: input.sessionId, turnId: input.turnId, outcome: input.outcome,
            completed: input.completed, occurredAt: input.occurredAt,
            ...(input.verificationPassed === undefined ? {} : { verificationPassed: input.verificationPassed }),
            ...(input.finalVerificationRevisions === undefined ? {} : { finalVerificationRevisions: input.finalVerificationRevisions }),
          })
          await this.engine.drain()
          const state = await this.store.load()
          return { ok: receipt === 'persisted' || receipt === 'already_persisted', receipt,
            captures: state.counters.captures, diagnostics: learningDiagnostics(state) }
        }
        case 'close': {
          this.cancelSession(input.sessionId)
          return { ok: true, discarded: this.engine.disposeSession(input.sessionId) }
        }
        case 'status': {
          await this.engine.drain()
          const state = await this.store.load()
          return { ok: true, enabled: state.enabled, health: state.health,
            delivery: this.engine.deliveryDiagnostics(), diagnostics: learningDiagnostics(state) }
        }
      }
    } catch (error) { return { ok: false, code: error instanceof Error && error.message === 'method_capacity' ? 'method_capacity' : 'state_unavailable' } }
  }

  private cancelSession(sessionId: string, turnId?: string | number): void {
    for (const [receipt, prepared] of this.pending) {
      if (prepared.sessionId !== sessionId || (turnId !== undefined && String(prepared.turnId) !== String(turnId))) continue
      this.engine.cancelInjection(prepared)
      this.pending.delete(receipt)
    }
  }

  async dispose(): Promise<void> { this.pending.clear(); await this.engine.dispose() }
}
