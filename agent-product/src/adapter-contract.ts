import { z } from 'zod'
import {
  ADAPTER_CAPABILITIES,
  type AgentAdapterDescriptor,
} from './types.js'

const SAFE_ID = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u

const adapterDescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(64).regex(SAFE_ID),
  displayName: z.string().min(1).max(80).refine(value =>
    value === value.trim() && !CONTROL_CHARACTER.test(value)),
  version: z.string().min(5).max(64).regex(SEMVER),
  capabilities: z.array(z.enum(ADAPTER_CAPABILITIES)).min(1).max(ADAPTER_CAPABILITIES.length)
    .refine(values => values.includes('turns'))
    .refine(values => new Set(values).size === values.length),
}).strict()

export function validateAdapterDescriptor(input: unknown): Readonly<AgentAdapterDescriptor> {
  const result = adapterDescriptorSchema.safeParse(input)
  if (!result.success) throw new TypeError('adapter_descriptor_invalid')
  const capabilities = Object.freeze([...result.data.capabilities])
  return Object.freeze({ ...result.data, capabilities })
}
