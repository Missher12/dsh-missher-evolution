import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { RULE_CATEGORIES, RULE_STATUSES, TASK_TYPES } from './types.js'

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const counter = z.number().int().nonnegative().max(1_000_000_000)

export const EvolutionRuleViewSchema = z.object({
  id: z.string().regex(/^rule_[a-z0-9_]{1,96}$/u),
  status: z.enum(RULE_STATUSES),
  category: z.enum(RULE_CATEGORIES),
  taskType: z.enum(TASK_TYPES),
  instruction: z.string().min(8).max(500),
  confidence: z.number().min(0).max(1),
  opportunities: counter,
  successes: counter,
  failures: counter,
  corrections: counter,
}).strict()

export const EvolutionSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  revision: safeInteger,
  enabled: z.boolean(),
  health: z.enum(['healthy', 'degraded', 'state_unavailable', 'lock_busy']),
  lastMaintenanceAt: safeInteger.nullable(),
  counters: z.object({
    captures: counter,
    injections: counter,
    rejectedCaptures: counter,
    maintenanceRuns: counter,
    weeklyInjections: counter,
    candidate: counter,
    trial: counter,
    active: counter,
    suspended: counter,
    retired: counter,
  }).strict(),
  rules: z.array(EvolutionRuleViewSchema).max(200),
}).strict()

export const SetEnabledRequestSchema = z.object({
  enabled: z.boolean(),
  expectedRevision: safeInteger,
}).strict()

export const ResetRequestSchema = z.object({
  confirmation: z.literal('RESET'),
  expectedRevision: safeInteger,
}).strict()

export const ResetResultSchema = z.object({
  snapshot: EvolutionSnapshotSchema,
  backupId: z.string().regex(/^backup_reset_\d+_\d+_[0-9a-f]{12}$/u),
}).strict()

export type EvolutionRuleView = z.infer<typeof EvolutionRuleViewSchema>
export type EvolutionSnapshot = z.infer<typeof EvolutionSnapshotSchema>
export type SetEnabledRequest = z.infer<typeof SetEnabledRequestSchema>
export type RemoteResetRequest = z.infer<typeof ResetRequestSchema>
export type RemoteResetResult = z.infer<typeof ResetResultSchema>

function strictCodec(typeSymbol: string, schema: z.ZodType): InvocationDescriptor['result'] {
  return { mode: 'strict', typeSymbol, schema }
}

const PACKAGE = 'dsh-missher-evolution'
const SERVICE = 'missherEvolution'

export const invocationDescriptors = Object.freeze([
  {
    id: `${PACKAGE}#${SERVICE}/snapshot`,
    service: SERVICE,
    namespace: SERVICE,
    method: 'snapshot',
    invocation: { kind: 'direct' },
    parameters: [],
    result: strictCodec(`${PACKAGE}#EvolutionSnapshot`, EvolutionSnapshotSchema),
    sourceLocation: { file: 'src/remote.ts', line: 50, column: 3 },
  },
  {
    id: `${PACKAGE}#${SERVICE}/setEnabled`,
    service: SERVICE,
    namespace: SERVICE,
    method: 'setEnabled',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: strictCodec(`${PACKAGE}#SetEnabledRequest`, SetEnabledRequestSchema),
    }],
    result: strictCodec(`${PACKAGE}#EvolutionSnapshot`, EvolutionSnapshotSchema),
    sourceLocation: { file: 'src/remote.ts', line: 56, column: 3 },
  },
  {
    id: `${PACKAGE}#${SERVICE}/reset`,
    service: SERVICE,
    namespace: SERVICE,
    method: 'reset',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: strictCodec(`${PACKAGE}#RemoteResetRequest`, ResetRequestSchema),
    }],
    result: strictCodec(`${PACKAGE}#RemoteResetResult`, ResetResultSchema),
    sourceLocation: { file: 'src/remote.ts', line: 75, column: 3 },
  },
] as const satisfies readonly InvocationDescriptor[])

