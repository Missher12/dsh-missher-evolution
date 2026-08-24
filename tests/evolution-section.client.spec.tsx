/** @vitest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { EvolutionSection, type EvolutionSectionProps } from '../src/client/EvolutionSection.js'
import { apply, inject } from '../src/client/index.js'
import { zh } from '../src/client/locales.js'
import type { EvolutionSnapshot } from '../src/remote-contract.js'

function snapshot(overrides: Partial<EvolutionSnapshot> = {}): EvolutionSnapshot {
  return {
    schemaVersion: 1,
    revision: 2,
    enabled: true,
    health: 'healthy',
    lastMaintenanceAt: 100,
    counters: {
      captures: 9,
      injections: 4,
      rejectedCaptures: 1,
      maintenanceRuns: 2,
      weeklyInjections: 3,
      candidate: 1,
      trial: 0,
      active: 1,
      suspended: 0,
      retired: 0,
    },
    rules: [],
    ...overrides,
  }
}

function props(overrides: Partial<EvolutionSectionProps> = {}): EvolutionSectionProps {
  return {
    snapshot: vi.fn(async () => ({ ok: true as const, value: snapshot() })),
    setEnabled: vi.fn(async request => ({
      ok: true as const,
      value: snapshot({ enabled: request.enabled, revision: request.expectedRevision + 1 }),
    })),
    reset: vi.fn(async request => ({
      ok: true as const,
      value: {
        snapshot: snapshot({ revision: request.expectedRevision + 1, rules: [] }),
        backupId: 'backup_reset_100_2_abcdefabcdef',
      },
    })),
    t: key => zh[key],
    ...overrides,
  }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('EvolutionSection', () => {
  test('mounts its Remote before registering the ordered settings section', async () => {
    const order: string[] = []
    let registered: { id?: string, order?: number, inject?: () => EvolutionSectionProps } | undefined
    const unmount = vi.fn(async () => undefined)
    const ctx = {
      remote: {
        $mount: vi.fn(async () => { order.push('remote'); return unmount }),
        missherEvolution: {
          snapshot: vi.fn(async () => ({ ok: true as const, value: snapshot() })),
          setEnabled: vi.fn(),
          reset: vi.fn(),
        },
      },
      get: vi.fn((name: string) => name === 'remote.missherEvolution'
        ? {
            snapshot: vi.fn(async () => ({ ok: true as const, value: snapshot() })),
            setEnabled: vi.fn(),
            reset: vi.fn(),
          }
        : undefined),
      locale: {
        register: vi.fn(() => () => undefined),
        bind: vi.fn(() => ((key: keyof typeof zh) => zh[key])),
      },
      effect: vi.fn((setup: () => unknown) => setup()),
      slots: {
        inject: vi.fn((_name: string, setup: () => unknown) => setup()),
        register: vi.fn((options: typeof registered) => {
          order.push('section')
          registered = options
          return () => undefined
        }),
      },
    }
    const dispose = await apply(ctx as never)
    expect(inject).toEqual(['slots', 'locale', 'remote'])
    expect(order).toEqual(['remote', 'section'])
    expect(registered).toMatchObject({ id: 'evolution', order: 13 })
    expect(registered?.inject?.().snapshot).toBeTypeOf('function')
    await dispose()
    expect(unmount).toHaveBeenCalledOnce()
  })

  test('renders loading, empty and ready Chinese states with aggregate counts', async () => {
    let release: ((value: { ok: true, value: EvolutionSnapshot }) => void) | undefined
    const input = props({
      snapshot: vi.fn(() => new Promise<{ ok: true, value: EvolutionSnapshot }>(resolve => { release = resolve })),
    })
    render(<EvolutionSection {...input} />)
    expect(screen.getByText('正在读取进化状态…')).toBeTruthy()
    await act(async () => { release?.({ ok: true, value: snapshot() }) })
    expect(await screen.findByRole('heading', { name: '进化' })).toBeTruthy()
    expect(screen.getByText('本周注入')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getByText('还没有通过验证的规则。')).toBeTruthy()
  })

  test('renders a bounded rule row without internal hashes or paths', async () => {
    const value = snapshot({
      rules: [{
        id: 'rule_public', status: 'active', category: 'workflow', taskType: 'coding',
        instruction: '处理代码任务时先检查实现；完成后运行测试并核对真实输出。',
        confidence: 0.9, opportunities: 4, successes: 3, failures: 1, corrections: 0,
      }],
    })
    render(<EvolutionSection {...props({ snapshot: vi.fn(async () => ({ ok: true as const, value })) })} />)
    expect(await screen.findByText(value.rules[0]!.instruction)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/sessionHash|instructionHash|\/Users\//u)
  })

  test('shows only a local generic error and supports retry', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'STATE', message: '/Users/private/state.json', details: {} },
      })
      .mockResolvedValueOnce({ ok: true, value: snapshot() })
    render(<EvolutionSection {...props({ snapshot: read })} />)
    expect(await screen.findByText('无法读取进化状态。')).toBeTruthy()
    expect(document.body.textContent).not.toContain('/Users/private')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('heading', { name: '进化' })).toBeTruthy()
  })

  test('handles toggle conflicts without displaying Host error details', async () => {
    const write = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'CONFLICT', message: 'private C:\\state.json', details: {} },
    }))
    render(<EvolutionSection {...props({ setEnabled: write })} />)
    const toggle = await screen.findByRole('checkbox', { name: '启用自动进化' })
    fireEvent.click(toggle)
    await waitFor(() => expect(write).toHaveBeenCalledWith({ enabled: false, expectedRevision: 2 }))
    expect(await screen.findByText('状态已变化，请刷新后重试。')).toBeTruthy()
    expect(document.body.textContent).not.toContain('private C:')
  })

  test('requires both reset confirmations and uses the current revision', async () => {
    const reset = vi.fn(async () => ({
      ok: true as const,
      value: { snapshot: snapshot({ revision: 3 }), backupId: 'backup_reset_100_2_abcdefabcdef' },
    }))
    render(<EvolutionSection {...props({ reset })} />)
    const button = await screen.findByRole('button', { name: '重置学习数据' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: '我知道重置前会创建本地备份' }))
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('输入 RESET 以确认'), { target: { value: 'RESET' } })
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(reset).toHaveBeenCalledWith({ confirmation: 'RESET', expectedRevision: 2 }))
    expect(await screen.findByText('学习数据已重置，本地备份已保留。')).toBeTruthy()
  })

  test('ignores an older refresh that settles after a newer one', async () => {
    const pending: Array<(value: { ok: true, value: EvolutionSnapshot }) => void> = []
    const read = vi.fn(() => new Promise<{ ok: true, value: EvolutionSnapshot }>(resolve => {
      pending.push(resolve)
    }))
    render(<EvolutionSection {...props({ snapshot: read })} />)
    await act(async () => { pending.shift()?.({ ok: true, value: snapshot({ revision: 1 }) }) })
    const refresh = await screen.findByRole('button', { name: '刷新' })
    fireEvent.click(refresh)
    fireEvent.click(refresh)
    await act(async () => { pending[1]?.({ ok: true, value: snapshot({ revision: 3, enabled: false }) }) })
    await waitFor(() => expect((screen.getByRole('checkbox', { name: '启用自动进化' }) as HTMLInputElement).checked).toBe(false))
    await act(async () => { pending[0]?.({ ok: true, value: snapshot({ revision: 2, enabled: true }) }) })
    expect((screen.getByRole('checkbox', { name: '启用自动进化' }) as HTMLInputElement).checked).toBe(false)
  })
})
