import { describe, expect, test } from 'vitest'
import { containsSensitive } from '../src/classifier.js'

describe('privacy boundary', () => {
  test.each([
    '/Users/example/key',
    '/home/example/key',
    'C:\\Users\\example\\key',
    'https://example.test/a',
    'wss://example.test/socket',
    'a@example.test',
    'api_key=secret',
    'Authorization: Bearer abcdefghijklmnop',
    '-----BEGIN PRIVATE KEY-----',
  ])('rejects sensitive durable text: %s', value => {
    expect(containsSensitive(value)).toBe(true)
  })

  test.each([
    '代码任务：先检查受影响实现，再做最小修改并运行测试验证结果。',
    'workflow: coding,file_ops,shell',
    'rule_f0a1b2c3',
  ])('allows closed non-sensitive text: %s', value => {
    expect(containsSensitive(value)).toBe(false)
  })

  test('treats non-string values as unsafe', () => {
    expect(containsSensitive(null)).toBe(true)
    expect(containsSensitive({ value: 'closed' })).toBe(true)
  })
})
