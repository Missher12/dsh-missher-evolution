import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, test } from 'vitest'
import {
  EvolutionSnapshotSchema,
  ResetRequestSchema,
  SetEnabledRequestSchema,
  invocationDescriptors,
} from '../src/remote-contract.js'
import { MissherEvolutionRemote } from '../src/remote.js'
import { EvolutionStore } from '../src/store.js'
import { TYPERT } from '../src/typert.host.js'
import { TYPERT_REMOTE } from '../src/typert.remote-client.js'

const roots: string[] = []
const contexts: Context[] = []

async function service() {
  const root = await mkdtemp(join(tmpdir(), 'mse-remote-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  const store = new EvolutionStore(root, { now: () => 100 })
  return { store, remote: new MissherEvolutionRemote(ctx, store) }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('MissherEvolutionRemote', () => {
  test('returns a strict pathless and hashless snapshot', async () => {
    const { remote } = await service()
    const view = await remote.snapshot()
    expect(EvolutionSnapshotSchema.parse(view)).toEqual(view)
    expect(JSON.stringify(view)).not.toMatch(/path|sessionHash|instructionHash|audit/i)
    expect(EvolutionSnapshotSchema.safeParse({ ...view, path: '/private' }).success).toBe(false)
  })

  test('updates enabled state only at the exact expected revision', async () => {
    const { remote } = await service()
    const initial = await remote.snapshot()
    const disabled = await remote.setEnabled({ enabled: false, expectedRevision: initial.revision })
    expect(disabled).toMatchObject({ enabled: false, revision: initial.revision + 1 })
    await expect(remote.setEnabled({ enabled: true, expectedRevision: initial.revision }))
      .rejects.toMatchObject({ code: 'revision_conflict' })
  })

  test('requires RESET and preserves a validated backup before clearing state', async () => {
    const { store, remote } = await service()
    const initial = await remote.snapshot()
    await expect(remote.reset({ confirmation: 'reset', expectedRevision: initial.revision } as never))
      .rejects.toMatchObject({ code: 'invalid_reset' })
    const result = await remote.reset({ confirmation: 'RESET', expectedRevision: initial.revision })
    expect(result.snapshot.revision).toBe(initial.revision + 1)
    expect(result.snapshot.rules).toEqual([])
    expect((await store.readBackup(result.backupId)).revision).toBe(initial.revision)
  })

  test('shares strict schemas across Host and Client descriptors', () => {
    expect(SetEnabledRequestSchema.safeParse({ enabled: false, expectedRevision: 0 }).success).toBe(true)
    expect(SetEnabledRequestSchema.safeParse({ enabled: false, expectedRevision: 0, extra: true }).success).toBe(false)
    expect(ResetRequestSchema.safeParse({ confirmation: 'RESET', expectedRevision: 0 }).success).toBe(true)
    expect(ResetRequestSchema.safeParse({ confirmation: 'NO', expectedRevision: 0 }).success).toBe(false)
    expect(TYPERT.invocations).toBe(invocationDescriptors)
    expect(TYPERT_REMOTE.descriptors).toBe(invocationDescriptors)
    expect(TYPERT_REMOTE.package).toBe('dsh-missher-evolution')
  })

  test('marks all three methods for the live Harness Gateway', async () => {
    const { remote } = await service()
    expect(remoteMethods(remote)).toEqual([
      { method: 'snapshot', invocation: { kind: 'direct' } },
      { method: 'setEnabled', invocation: { kind: 'direct' } },
      { method: 'reset', invocation: { kind: 'direct' } },
    ])
  })
})
