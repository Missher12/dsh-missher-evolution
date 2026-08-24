import { describe, expect, test, vi } from 'vitest'
import { MaintenanceScheduler, type MaintenanceStore } from '../src/maintenance.js'
import { createEmptyState } from '../src/store.js'
import type { AdvisorResult } from '../src/advisor.js'
import type { AuditEvent, EvolutionState } from '../src/types.js'

class MemoryMaintenanceStore implements MaintenanceStore {
  state: EvolutionState
  backups: string[] = []
  audits: AuditEvent[] = []
  lockBusy = false

  constructor(state: EvolutionState = createEmptyState(0)) {
    this.state = structuredClone(state)
  }

  async load(): Promise<EvolutionState> {
    return structuredClone(this.state)
  }

  async update(
    expectedRevision: number,
    mutate: (state: EvolutionState) => EvolutionState,
  ): Promise<EvolutionState> {
    if (expectedRevision !== this.state.revision) {
      throw Object.assign(new Error('revision_conflict'), { code: 'revision_conflict' })
    }
    this.state = { ...mutate(structuredClone(this.state)), revision: this.state.revision + 1 }
    return structuredClone(this.state)
  }

  async backup(reason: 'maintenance'): Promise<string> {
    if (this.lockBusy) throw Object.assign(new Error('lock_busy'), { code: 'lock_busy' })
    this.backups.push(reason)
    return `backup_maintenance_100_0_abcdefabcdef`
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    this.audits.push(structuredClone(event))
  }
}

describe('MaintenanceScheduler', () => {
  test('runs due maintenance at startup and creates backup before update', async () => {
    const order: string[] = []
    const store = new MemoryMaintenanceStore()
    const backup = store.backup.bind(store)
    store.backup = async reason => { order.push('backup'); return backup(reason) }
    const update = store.update.bind(store)
    store.update = async (...args) => { order.push('update'); return update(...args) }
    const scheduler = new MaintenanceScheduler({ store, now: () => 100, intervalHours: 24 })
    scheduler.start()
    await scheduler.drain()
    expect(order.slice(0, 2)).toEqual(['backup', 'update'])
    expect(store.state.lastMaintenanceAt).toBe(100)
    expect(store.state.counters.maintenanceRuns).toBe(1)
    await scheduler.dispose()
  })

  test('skips startup when not due and schedules an hourly recheck', async () => {
    const state = { ...createEmptyState(0), lastMaintenanceAt: 99 }
    const store = new MemoryMaintenanceStore(state)
    let tick: (() => void) | undefined
    let scheduledMs = 0
    const scheduler = new MaintenanceScheduler({
      store,
      now: () => 100,
      intervalHours: 24,
      schedule: (handler, ms) => {
        tick = handler
        scheduledMs = ms
        return () => { tick = undefined }
      },
    })
    scheduler.start()
    await scheduler.drain()
    expect(store.backups).toEqual([])
    expect(scheduledMs).toBe(60 * 60 * 1_000)
    tick?.()
    await scheduler.drain()
    expect(store.backups).toEqual([])
    await scheduler.dispose()
  })

  test('shares one in-flight run', async () => {
    const store = new MemoryMaintenanceStore()
    let release: (() => void) | undefined
    store.backup = vi.fn(async () => {
      await new Promise<void>(resolve => { release = resolve })
      return 'backup_maintenance_100_0_abcdefabcdef'
    })
    const scheduler = new MaintenanceScheduler({ store, now: () => 100, intervalHours: 24 })
    const first = scheduler.runIfDue('startup')
    const second = scheduler.runIfDue('timer')
    expect(first).toBe(second)
    await vi.waitFor(() => expect(release).toBeDefined())
    release?.()
    await expect(first).resolves.toMatchObject({ kind: 'completed' })
    expect(store.backup).toHaveBeenCalledOnce()
  })

  test('skips lock contention without changing state', async () => {
    const store = new MemoryMaintenanceStore()
    store.lockBusy = true
    const scheduler = new MaintenanceScheduler({ store, now: () => 100, intervalHours: 24 })
    await expect(scheduler.runIfDue('timer')).resolves.toEqual({ kind: 'skipped_lock_busy' })
    expect(store.state.revision).toBe(0)
  })

  test('isolates advisor rejection and applies a valid rewrite only to its offered version', async () => {
    const state = createEmptyState(0)
    state.rules.push({
      id: 'rule_candidate', status: 'candidate', category: 'workflow', taskType: 'coding',
      workflowFamily: 'a'.repeat(64), workflowSteps: ['shell'],
      observedWorkflowSignatures: ['b'.repeat(64)], preferenceId: null,
      instruction: '处理代码任务时先检查目标，再执行限定步骤；完成后运行测试并核对真实结果。',
      instructionHash: 'c'.repeat(64), confidence: 0.6, createdAt: 1,
      lastEvidenceAt: 1, lastSuccessAt: null, expiresAt: 100_000,
      sessionHashes: ['d'.repeat(64)], version: 1, opportunities: 0,
      successes: 0, failures: 0, corrections: 0,
    })
    const store = new MemoryMaintenanceStore(state)
    const rewrittenInstruction = '处理代码任务前先检查实现和测试；完成修改后运行对应测试并核对真实输出。'
    const decision: AdvisorResult = {
      status: 'accepted',
      decision: {
        ruleId: 'rule_candidate',
        action: 'rewrite',
        instruction: rewrittenInstruction,
      },
    }
    const scheduler = new MaintenanceScheduler({
      store, now: () => 100, intervalHours: 24,
      review: async () => decision,
    })
    await scheduler.runIfDue('timer')
    expect(store.state.rules[0]).toMatchObject({ version: 2, instruction: rewrittenInstruction })
  })

  test('aborts advisor work and waits for in-flight settlement on dispose', async () => {
    const store = new MemoryMaintenanceStore()
    let observedSignal: AbortSignal | undefined
    let release: (() => void) | undefined
    const scheduler = new MaintenanceScheduler({
      store, now: () => 100, intervalHours: 24,
      review: async (_state, signal) => {
        observedSignal = signal
        await new Promise<void>(resolve => { release = resolve })
        return { status: 'skipped_no_route' }
      },
    })
    const running = scheduler.runIfDue('startup')
    await vi.waitFor(() => expect(observedSignal).toBeDefined())
    const disposed = scheduler.dispose()
    expect(observedSignal?.aborted).toBe(true)
    release?.()
    await disposed
    await running
  })
})
