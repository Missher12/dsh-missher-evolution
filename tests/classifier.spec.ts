import { describe, expect, test } from 'vitest'
import {
  classifyError,
  classifyPrompt,
  classifyTool,
  instructionForPreference,
} from '../src/classifier.js'
import { normalizeConfig } from '../src/config.js'

describe('closed classifiers', () => {
  test('classifies without returning source text', () => {
    expect(classifyPrompt('请检查 TypeScript 构建并修复测试')).toEqual({
      taskType: 'coding',
      correction: false,
      preference: null,
    })
  })

  test('maps a closed preference without copying the prompt', () => {
    expect(classifyPrompt('以后都用中文回答，不要英文').preference)
      .toBe('respond_simplified_chinese')
  })

  test.each([
    ['抓取小红书笔记', 'media'],
    ['打开浏览器检查网页', 'browser'],
    ['整理 SQL 数据表', 'data'],
    ['继续完成', 'general'],
  ] as const)('maps prompt %s to %s', (prompt, expected) => {
    expect(classifyPrompt(prompt).taskType).toBe(expected)
  })

  test.each([
    ['terminal', 'shell'],
    ['read_file', 'file_ops'],
    ['browser_navigate', 'browser'],
    ['unknown_tool', 'other'],
  ] as const)('maps tool %s to %s', (tool, expected) => {
    expect(classifyTool(tool)).toBe(expected)
  })

  test.each([
    ['connection timed out', 'timeout'],
    ['permission denied', 'permission'],
    ['schema rejected argument', 'validation'],
    ['socket disconnected', 'transport'],
    ['', 'none'],
  ] as const)('maps error %s to %s', (error, expected) => {
    expect(classifyError(error)).toBe(expected)
  })

  test('detects explicit corrections in Chinese and English', () => {
    expect(classifyPrompt('不是 A，而是 B').correction).toBe(true)
    expect(classifyPrompt('Use B instead of A').correction).toBe(true)
    expect(classifyPrompt('继续完成').correction).toBe(false)
  })

  test('every predefined preference is actionable Chinese with verification', () => {
    for (const id of [
      'respond_simplified_chinese',
      'prefer_concise_answers',
      'verify_before_change',
      'preserve_requested_scope',
      'honor_exact_output',
    ] as const) {
      const instruction = instructionForPreference(id)
      expect(instruction).toMatch(/[\u3400-\u9fff]/u)
      expect(instruction).toMatch(/检查|确认|验证|比较|核对|回读/u)
      expect(instruction.length).toBeLessThanOrEqual(500)
    }
  })

  test('normalizes invalid configuration to safe defaults', () => {
    expect(normalizeConfig({
      enabled: 'yes',
      maintenanceIntervalHours: 2,
      maxInjectedRules: 99,
      arbitrary: '/tmp/leak',
    })).toEqual({
      enabled: true,
      maintenanceIntervalHours: 24,
      maxInjectedRules: 4,
    })
  })
})
