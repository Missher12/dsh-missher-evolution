import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { EvolutionStore, StoreError } from '../src/store.js'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mse-store-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => rm(root, { recursive: true, force: true })))
})

describe('EvolutionStore', () => {
  test('uses configured enabled only for first state creation', async () => {
    const root = await tempRoot()
    const disabled = new EvolutionStore(root, { now: () => 10, defaultEnabled: false })
    expect((await disabled.load()).enabled).toBe(false)
    const initial = await disabled.load()
    await disabled.update(initial.revision, state => ({ ...state, enabled: true }))
    const reopened = new EvolutionStore(root, { now: () => 20, defaultEnabled: false })
    expect((await reopened.load()).enabled).toBe(true)
  })

  test('initializes empty state and atomically updates one revision', async () => {
    const root = await tempRoot()
    const store = new EvolutionStore(root, { now: () => 100 })
    const empty = await store.load()
    expect(empty).toMatchObject({ schemaVersion: 1, revision: 0, enabled: true, rules: [] })

    const updated = await store.update(0, state => ({ ...state, enabled: false }))
    expect(updated).toMatchObject({ revision: 1, enabled: false, updatedAt: 100 })
    expect(await store.load()).toEqual(updated)
    expect((await lstat(join(root, 'state.json'))).isFile()).toBe(true)
    expect((await readFile(join(root, 'state.json'), 'utf8')).endsWith('\n')).toBe(true)
  })

  test('rejects revision conflicts without replacing valid state', async () => {
    const root = await tempRoot()
    const store = new EvolutionStore(root)
    await store.update(0, state => state)
    await expect(store.update(0, state => ({ ...state, enabled: false })))
      .rejects.toMatchObject({ code: 'revision_conflict' })
    expect((await store.load()).revision).toBe(1)
  })

  test('rejects symlinked managed paths', async () => {
    const root = await tempRoot()
    const target = join(root, 'real-state.json')
    await writeFile(target, '{}', 'utf8')
    await symlink(target, join(root, 'state.json'))
    await expect(new EvolutionStore(root).load())
      .rejects.toMatchObject({ code: 'unsafe_path' })
  })

  test('reports live lock contention with a closed code', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'lock'), JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { mode: 0o600 })
    const store = new EvolutionStore(root)
    await expect(store.update(0, state => state)).rejects.toMatchObject({ code: 'lock_busy' })
  })

  test('validates audit keys and never persists arbitrary text', async () => {
    const root = await tempRoot()
    const store = new EvolutionStore(root, { now: () => 10 })
    await store.appendAudit({ schemaVersion: 1, at: 10, kind: 'capture_applied', count: 1 })
    await expect(store.appendAudit({
      schemaVersion: 1,
      at: 11,
      kind: 'capture_applied',
      count: 1,
      rawPrompt: 'secret',
    } as never)).rejects.toMatchObject({ code: 'state_corrupt' })
    const audit = await readFile(join(root, 'audit.jsonl'), 'utf8')
    expect(audit).toContain('capture_applied')
    expect(audit).not.toContain('secret')
  })

  test('recovers in memory from the newest valid backup without deleting corruption', async () => {
    const root = await tempRoot()
    const store = new EvolutionStore(root, { now: () => 100 })
    const saved = await store.update(0, state => ({ ...state, enabled: false }))
    await store.backup('maintenance')
    await writeFile(join(root, 'state.json'), '{corrupt', 'utf8')
    const recovered = await store.load()
    expect(recovered).toMatchObject({ revision: saved.revision, enabled: false, health: 'degraded' })
    expect(await readFile(join(root, 'state.json'), 'utf8')).toBe('{corrupt')
  })

  test('resets only after a verified backup', async () => {
    const root = await tempRoot()
    const store = new EvolutionStore(root, { now: () => 200 })
    const before = await store.update(0, state => ({
      ...state,
      counters: { ...state.counters, captures: 8 },
    }))
    const reset = await store.reset({ expectedRevision: before.revision, confirmation: 'RESET' })
    expect(reset.state.rules).toEqual([])
    expect(reset.state.counters.captures).toBe(0)
    expect(reset.state.lastBackupId).toBe(reset.backupId)
    expect(await store.readBackup(reset.backupId)).toMatchObject({ revision: before.revision })
  })

  test('does not accept an invalid reset confirmation', async () => {
    const store = new EvolutionStore(await tempRoot())
    await expect(store.reset({ expectedRevision: 0, confirmation: 'reset' }))
      .rejects.toMatchObject({ code: 'invalid_reset' })
  })

  test('rejects a non-private existing state file on POSIX', async () => {
    if (process.platform === 'win32') return
    const root = await tempRoot()
    const store = new EvolutionStore(root)
    await store.update(0, state => state)
    await chmod(join(root, 'state.json'), 0o644)
    await expect(store.load()).rejects.toSatisfy((error: unknown) =>
      error instanceof StoreError && error.code === 'unsafe_path')
  })
})
