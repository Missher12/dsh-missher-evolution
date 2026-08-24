import { randomBytes, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { containsSensitive } from './classifier.js'
import {
  ERROR_KINDS,
  PREFERENCE_IDS,
  RULE_CATEGORIES,
  RULE_STATUSES,
  TASK_TYPES,
  WORKFLOW_STEPS,
  type AuditEvent,
  type EvolutionState,
  type ResetRequest,
  type StoreErrorCode,
} from './types.js'

const MAX_STATE_BYTES = 1024 * 1024
const MAX_AUDIT_BYTES = 1024 * 1024
const MAX_AUDIT_LINE_BYTES = 4 * 1024
const MAX_RULES = 200
const LOCK_LEASE_MS = 2 * 60 * 1_000
const RULE_ID = /^rule_[a-z0-9_]{1,96}$/u
const HASH = /^[0-9a-f]{64}$/u
const BACKUP_ID = /^backup_(?:maintenance|reset|upgrade)_\d+_\d+_[0-9a-f]{12}$/u
const AUDIT_REASONS = [
  'success', 'failure', 'correction', 'partial', 'candidate_created',
  'candidate_promoted', 'trial_promoted', 'rule_suspended', 'rule_retired',
  'expired', 'duplicate', 'subagent', 'cron', 'internal', 'plugin_message',
  'disabled', 'capacity', 'invalid', 'manual', 'startup', 'timer',
] as const

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const counter = z.number().int().nonnegative().max(1_000_000_000)
const hash = z.string().regex(HASH)
const uniqueHashes = z.array(hash).max(16).refine(values => new Set(values).size === values.length)
const workflowSteps = z.array(z.enum(WORKFLOW_STEPS)).max(12)
const observedSignatures = z.array(hash).max(16).refine(values => new Set(values).size === values.length)
const instruction = z.string().min(8).max(500).refine(value =>
  Buffer.byteLength(value, 'utf8') <= 1_024
  && !/[\r\n\u0000-\u001f\u007f]/u.test(value)
  && /[\u3400-\u9fff]/u.test(value)
  && /检查|确认|验证|比较|核对|回读/u.test(value)
  && !containsSensitive(value),
)

export const evolutionRuleSchema = z.object({
  id: z.string().regex(RULE_ID),
  status: z.enum(RULE_STATUSES),
  category: z.enum(RULE_CATEGORIES),
  taskType: z.enum(TASK_TYPES),
  workflowFamily: hash,
  workflowSteps,
  observedWorkflowSignatures: observedSignatures,
  preferenceId: z.enum(PREFERENCE_IDS).nullable(),
  instruction,
  instructionHash: hash,
  confidence: z.number().min(0).max(1),
  createdAt: safeInteger,
  lastEvidenceAt: safeInteger,
  lastSuccessAt: safeInteger.nullable(),
  expiresAt: safeInteger.nullable(),
  sessionHashes: uniqueHashes,
  version: z.number().int().min(1).max(1_000_000),
  opportunities: counter,
  successes: counter,
  failures: counter,
  corrections: counter,
}).strict()

export const evolutionStateSchema: z.ZodType<EvolutionState> = z.object({
  schemaVersion: z.literal(1),
  revision: safeInteger,
  enabled: z.boolean(),
  createdAt: safeInteger,
  updatedAt: safeInteger,
  lastMaintenanceAt: safeInteger.nullable(),
  lastBackupId: z.string().regex(BACKUP_ID).nullable(),
  health: z.enum(['healthy', 'degraded', 'state_unavailable', 'lock_busy']),
  counters: z.object({
    captures: counter,
    injections: counter,
    rejectedCaptures: counter,
    maintenanceRuns: counter,
    weekStartedAt: safeInteger,
    weeklyInjections: counter,
  }).strict(),
  recentTaskHashes: z.array(hash).max(1_024)
    .refine(values => new Set(values).size === values.length),
  rules: z.array(evolutionRuleSchema).max(MAX_RULES),
}).strict().superRefine((state, context) => {
  const ids = state.rules.map(rule => rule.id)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', message: 'duplicate_rule_id' })
  }
})

const auditEventSchema = z.object({
  schemaVersion: z.literal(1),
  at: safeInteger,
  kind: z.enum([
    'capture_applied', 'capture_filtered', 'selection_observed',
    'rule_created', 'rule_transitioned', 'rules_injected',
    'maintenance_completed', 'state_reset', 'enabled_changed',
  ]),
  ruleId: z.string().regex(RULE_ID).optional(),
  fromStatus: z.enum(RULE_STATUSES).optional(),
  toStatus: z.enum(RULE_STATUSES).optional(),
  reason: z.enum(AUDIT_REASONS).optional(),
  count: counter.optional(),
}).strict()

export class StoreError extends Error {
  readonly code: StoreErrorCode

  constructor(code: StoreErrorCode) {
    super(code)
    this.name = 'StoreError'
    this.code = code
  }
}

export interface EvolutionStoreOptions {
  now?: () => number
  defaultEnabled?: boolean
}

export function createEmptyState(now: number, enabled = true): EvolutionState {
  return {
    schemaVersion: 1,
    revision: 0,
    enabled,
    createdAt: now,
    updatedAt: now,
    lastMaintenanceAt: null,
    lastBackupId: null,
    health: 'healthy',
    counters: {
      captures: 0,
      injections: 0,
      rejectedCaptures: 0,
      maintenanceRuns: 0,
      weekStartedAt: now,
      weeklyInjections: 0,
    },
    recentTaskHashes: [],
    rules: [],
  }
}

export class EvolutionStore {
  readonly root: string
  private readonly statePath: string
  private readonly auditPath: string
  private readonly auditPreviousPath: string
  private readonly lockPath: string
  private readonly backupsPath: string
  private readonly now: () => number
  private readonly defaultEnabled: boolean

  constructor(root: string, options: EvolutionStoreOptions = {}) {
    if (
      typeof root !== 'string'
      || !isAbsolute(root)
      || root.length > 4_096
      || /[\u0000-\u001f\u007f]/u.test(root)
    ) throw new StoreError('invalid_root')
    this.root = root
    this.statePath = join(root, 'state.json')
    this.auditPath = join(root, 'audit.jsonl')
    this.auditPreviousPath = join(root, 'audit.previous.jsonl')
    this.lockPath = join(root, 'lock')
    this.backupsPath = join(root, 'backups')
    this.now = options.now ?? Date.now
    this.defaultEnabled = options.defaultEnabled ?? true
  }

  async load(): Promise<EvolutionState> {
    await this.ensureRoot()
    return this.loadInternal(true)
  }

  async update(
    expectedRevision: number,
    mutate: (state: EvolutionState) => EvolutionState,
  ): Promise<EvolutionState> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new StoreError('revision_conflict')
    }
    return this.withLock(async () => {
      const current = await this.loadInternal(true)
      if (current.revision !== expectedRevision) throw new StoreError('revision_conflict')
      let proposed: EvolutionState
      try {
        proposed = mutate(structuredClone(current))
      } catch {
        throw new StoreError('state_corrupt')
      }
      const now = this.now()
      const next = this.parseState({
        ...proposed,
        schemaVersion: 1,
        revision: current.revision + 1,
        createdAt: current.createdAt,
        updatedAt: now,
      })
      await this.atomicWriteJson(this.statePath, next)
      return structuredClone(next)
    })
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    let parsed: z.infer<typeof auditEventSchema>
    try {
      parsed = auditEventSchema.parse(event)
    } catch {
      throw new StoreError('state_corrupt')
    }
    const serialized = JSON.stringify(parsed)
    const line = `${serialized}\n`
    if (Buffer.byteLength(line, 'utf8') > MAX_AUDIT_LINE_BYTES || containsSensitive(serialized)) {
      throw new StoreError('state_corrupt')
    }
    await this.withLock(async () => {
      await this.ensurePrivateRegular(this.auditPath, true)
      const existingSize = await this.fileSize(this.auditPath)
      if (existingSize + Buffer.byteLength(line, 'utf8') > MAX_AUDIT_BYTES) {
        await this.rotateAudit()
      }
      const handle = await open(this.auditPath, 'a', 0o600)
      try {
        await handle.writeFile(line, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
    })
  }

  async backup(reason: 'maintenance' | 'reset' | 'upgrade'): Promise<string> {
    return this.withLock(async () => {
      const state = await this.loadInternal(true)
      return this.backupState(state, reason)
    })
  }

  async readBackup(backupId: string): Promise<EvolutionState> {
    if (!BACKUP_ID.test(backupId)) throw new StoreError('backup_failed')
    await this.ensureRoot()
    await this.ensureBackupDirectory(false)
    const path = join(this.backupsPath, `${backupId}.json`)
    await this.ensurePrivateRegular(path, false)
    return this.readStateFile(path)
  }

  async reset(input: ResetRequest): Promise<{ state: EvolutionState, backupId: string }> {
    if (input.confirmation !== 'RESET') throw new StoreError('invalid_reset')
    return this.withLock(async () => {
      const current = await this.loadInternal(true)
      if (current.revision !== input.expectedRevision) throw new StoreError('revision_conflict')
      const backupId = await this.backupState(current, 'reset')
      const now = this.now()
      const state: EvolutionState = {
        ...createEmptyState(now, current.enabled),
        revision: current.revision + 1,
        lastBackupId: backupId,
      }
      await this.atomicWriteJson(this.statePath, state)
      return { state: structuredClone(state), backupId }
    })
  }

  private async ensureRoot(): Promise<void> {
    try {
      const existing = await lstat(this.root).catch(error => {
        if (isNodeError(error, 'ENOENT')) return undefined
        throw error
      })
      if (existing !== undefined && (existing.isSymbolicLink() || !existing.isDirectory())) {
        throw new StoreError('unsafe_path')
      }
      if (existing === undefined) await mkdir(this.root, { recursive: true, mode: 0o700 })
      const verified = await lstat(this.root)
      if (verified.isSymbolicLink() || !verified.isDirectory()) throw new StoreError('unsafe_path')
      await this.ensurePrivateRegular(this.statePath, true)
      await this.ensurePrivateRegular(this.lockPath, true)
    } catch (error) {
      if (error instanceof StoreError) throw error
      throw new StoreError('state_unavailable')
    }
  }

  private async loadInternal(recover: boolean): Promise<EvolutionState> {
    const exists = await this.pathExists(this.statePath)
    if (!exists) return createEmptyState(this.now(), this.defaultEnabled)
    try {
      return await this.readStateFile(this.statePath)
    } catch (error) {
      if (!(error instanceof StoreError) || error.code !== 'state_corrupt' || !recover) throw error
      const backup = await this.latestValidBackup()
      if (backup === undefined) throw error
      return { ...backup, health: 'degraded' }
    }
  }

  private async readStateFile(path: string): Promise<EvolutionState> {
    await this.ensurePrivateRegular(path, false)
    const info = await stat(path)
    if (info.size > MAX_STATE_BYTES) throw new StoreError('state_too_large')
    try {
      const raw = await readFile(path, 'utf8')
      if (Buffer.byteLength(raw, 'utf8') > MAX_STATE_BYTES) throw new StoreError('state_too_large')
      return this.parseState(JSON.parse(raw) as unknown)
    } catch (error) {
      if (error instanceof StoreError) throw error
      throw new StoreError('state_corrupt')
    }
  }

  private parseState(value: unknown): EvolutionState {
    try {
      const state = evolutionStateSchema.parse(value)
      const serialized = JSON.stringify(state)
      if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES || containsSensitive(serialized)) {
        throw new StoreError('state_corrupt')
      }
      return state
    } catch (error) {
      if (error instanceof StoreError) throw error
      throw new StoreError('state_corrupt')
    }
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    await this.ensureRoot()
    const handle = await this.acquireLock()
    try {
      return await work()
    } finally {
      await handle.close().catch(() => undefined)
      await unlink(this.lockPath).catch(() => undefined)
    }
  }

  private async acquireLock(): Promise<Awaited<ReturnType<typeof open>>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.lockPath, 'wx', 0o600)
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: this.now() }), 'utf8')
          await handle.sync()
          return handle
        } catch {
          await handle.close().catch(() => undefined)
          await unlink(this.lockPath).catch(() => undefined)
          throw new StoreError('state_unavailable')
        }
      } catch (error) {
        if (error instanceof StoreError) throw error
        if (!isNodeError(error, 'EEXIST')) throw new StoreError('state_unavailable')
        await this.ensurePrivateRegular(this.lockPath, false)
        if (attempt === 0 && await this.removeStaleLock()) continue
        throw new StoreError('lock_busy')
      }
    }
    throw new StoreError('lock_busy')
  }

  private async removeStaleLock(): Promise<boolean> {
    try {
      const info = await stat(this.lockPath)
      if (this.now() - info.mtimeMs <= LOCK_LEASE_MS) return false
      const raw = await readFile(this.lockPath, 'utf8')
      const value = JSON.parse(raw) as { pid?: unknown, createdAt?: unknown }
      if (!Number.isInteger(value.pid) || (value.pid as number) <= 0) return false
      if (this.processAlive(value.pid as number)) return false
      await unlink(this.lockPath)
      return true
    } catch {
      return false
    }
  }

  private processAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return isNodeError(error, 'EPERM')
    }
  }

  private async backupState(
    state: EvolutionState,
    reason: 'maintenance' | 'reset' | 'upgrade',
  ): Promise<string> {
    await this.ensureBackupDirectory(true)
    const backupId = `backup_${reason}_${this.now()}_${state.revision}_${randomBytes(6).toString('hex')}`
    const path = join(this.backupsPath, `${backupId}.json`)
    try {
      await this.atomicWriteJson(path, state, true)
      const verified = await this.readStateFile(path)
      if (JSON.stringify(verified) !== JSON.stringify(state)) throw new StoreError('backup_failed')
      return backupId
    } catch (error) {
      if (error instanceof StoreError && error.code === 'unsafe_path') throw error
      throw new StoreError('backup_failed')
    }
  }

  private async latestValidBackup(): Promise<EvolutionState | undefined> {
    const exists = await this.pathExists(this.backupsPath)
    if (!exists) return undefined
    await this.ensureBackupDirectory(false)
    const names = (await readdir(this.backupsPath))
      .filter(name => BACKUP_ID.test(name.replace(/\.json$/u, '')) && name.endsWith('.json'))
      .sort()
      .reverse()
    for (const name of names) {
      try {
        return await this.readStateFile(join(this.backupsPath, name))
      } catch {
        // Only fully validated backups are candidates.
      }
    }
    return undefined
  }

  private async ensureBackupDirectory(create: boolean): Promise<void> {
    const existing = await lstat(this.backupsPath).catch(error => {
      if (isNodeError(error, 'ENOENT')) return undefined
      throw error
    })
    if (existing === undefined && create) {
      await mkdir(this.backupsPath, { mode: 0o700 })
      return
    }
    if (existing === undefined || existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new StoreError('unsafe_path')
    }
  }

  private async atomicWriteJson(path: string, value: unknown, noReplace = false): Promise<void> {
    const payload = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(payload, 'utf8') > MAX_STATE_BYTES) throw new StoreError('state_too_large')
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      if (noReplace && await this.pathExists(path)) throw new StoreError('backup_failed')
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(payload, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      if (noReplace && await this.pathExists(path)) throw new StoreError('backup_failed')
      await rename(temporary, path)
      await this.syncDirectory(path === this.statePath ? this.root : this.backupsPath)
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
      if (error instanceof StoreError) throw error
      throw new StoreError('state_unavailable')
    }
  }

  private async rotateAudit(): Promise<void> {
    if (!await this.pathExists(this.auditPath)) return
    await this.ensurePrivateRegular(this.auditPath, false)
    if (await this.pathExists(this.auditPreviousPath)) {
      await this.ensurePrivateRegular(this.auditPreviousPath, false)
      await unlink(this.auditPreviousPath)
    }
    await rename(this.auditPath, this.auditPreviousPath)
    await this.syncDirectory(this.root)
  }

  private async syncDirectory(path: string): Promise<void> {
    try {
      const directory = await open(path, 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } catch (error) {
      if (
        isNodeError(error, 'EINVAL')
        || isNodeError(error, 'ENOTSUP')
        || isNodeError(error, 'EISDIR')
        || isNodeError(error, 'EPERM')
      ) return
      throw error
    }
  }

  private async ensurePrivateRegular(path: string, allowMissing: boolean): Promise<void> {
    const info = await lstat(path).catch(error => {
      if (allowMissing && isNodeError(error, 'ENOENT')) return undefined
      throw error
    })
    if (info === undefined) return
    if (info.isSymbolicLink() || !info.isFile()) throw new StoreError('unsafe_path')
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
      throw new StoreError('unsafe_path')
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await lstat(path)
      return true
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return false
      throw new StoreError('state_unavailable')
    }
  }

  private async fileSize(path: string): Promise<number> {
    try {
      return (await stat(path)).size
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return 0
      throw new StoreError('state_unavailable')
    }
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}

export { ERROR_KINDS }
