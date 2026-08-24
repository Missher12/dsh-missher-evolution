import { describe, expect, test, vi } from 'vitest'
import { advise, type AdvisorRoute, type ModelRunner } from '../src/advisor.js'
import { sha256, workflowFamily } from '../src/lifecycle.js'
import type { EvolutionRule } from '../src/types.js'

function candidate(overrides: Partial<EvolutionRule> = {}): EvolutionRule {
  const instruction = '处理代码任务时先检查目标实现，再执行最小修改；完成后运行测试并核对真实结果。'
  return {
    id: 'rule_candidate',
    status: 'candidate',
    category: 'workflow',
    taskType: 'coding',
    workflowFamily: workflowFamily('coding', ['file_ops', 'shell']),
    workflowSteps: ['file_ops', 'shell'],
    observedWorkflowSignatures: [sha256('signature')],
    preferenceId: null,
    instruction,
    instructionHash: sha256(instruction),
    confidence: 0.65,
    createdAt: 1,
    lastEvidenceAt: 1,
    lastSuccessAt: null,
    expiresAt: 100_000,
    sessionHashes: [sha256('session-a')],
    version: 1,
    opportunities: 0,
    successes: 0,
    failures: 0,
    corrections: 0,
    ...overrides,
  }
}

const route: AdvisorRoute = { provider: 'deepseek', model: 'deepseek-chat' }

describe('bounded advisor', () => {
  test('does not call a model without a route or eligible candidate', async () => {
    const runner = vi.fn<ModelRunner>()
    expect(await advise([candidate()], null, runner)).toMatchObject({ status: 'skipped_no_route' })
    expect(await advise([candidate({ status: 'active' })], route, runner))
      .toMatchObject({ status: 'skipped_no_candidate' })
    expect(runner).not.toHaveBeenCalled()
  })

  test('offers only sanitized candidate fields in one model call', async () => {
    const seen: unknown[] = []
    const result = await advise([candidate()], route, async request => {
      seen.push(request)
      return JSON.stringify({ ruleId: 'rule_candidate', action: 'keep' })
    })
    expect(result).toMatchObject({ status: 'accepted', decision: { action: 'keep' } })
    expect(seen).toHaveLength(1)
    expect(JSON.stringify(seen)).not.toMatch(/prompt|response|\/Users\/|https?:|目标实现/u)
  })

  test('rejects fenced JSON, oversized output and unoffered ids', async () => {
    const fenced = await advise([candidate()], route, async () =>
      '```json\n{"ruleId":"rule_candidate","action":"keep"}\n```')
    expect(fenced).toMatchObject({ status: 'rejected', reason: 'invalid_json' })

    const oversized = await advise([candidate()], route, async () => 'x'.repeat(8_193))
    expect(oversized).toMatchObject({ status: 'rejected', reason: 'output_too_large' })

    const wrongId = await advise([candidate()], route, async () =>
      JSON.stringify({ ruleId: 'rule_other', action: 'keep' }))
    expect(wrongId).toMatchObject({ status: 'rejected', reason: 'unoffered_rule' })
  })

  test('accepts one actionable Chinese rewrite and rejects unsafe text', async () => {
    const valid = await advise([candidate()], route, async () => JSON.stringify({
      ruleId: 'rule_candidate',
      action: 'rewrite',
      instruction: '处理代码任务前先检查相关实现和测试；修改后运行对应测试并核对真实输出。',
    }))
    expect(valid).toMatchObject({ status: 'accepted', decision: { action: 'rewrite' } })

    const unsafe = await advise([candidate()], route, async () => JSON.stringify({
      ruleId: 'rule_candidate',
      action: 'rewrite',
      instruction: '访问 https://example.test 后继续。',
    }))
    expect(unsafe).toMatchObject({ status: 'rejected', reason: 'invalid_instruction' })
  })

  test('times out one call and aborts its signal', async () => {
    let signal: AbortSignal | undefined
    const result = await advise([candidate()], route, async (_request, receivedSignal) => {
      signal = receivedSignal
      await new Promise<void>(() => undefined)
      return ''
    }, { timeoutMs: 5 })
    expect(result).toMatchObject({ status: 'rejected', reason: 'timeout' })
    expect(signal?.aborted).toBe(true)
  })

  test('settles promptly when maintenance aborts the review', async () => {
    const controller = new AbortController()
    const running = advise([candidate()], route, async (_request, signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return ''
    }, { signal: controller.signal })
    controller.abort('disposed')
    await expect(running).resolves.toEqual({ status: 'rejected', reason: 'aborted' })
  })
})
