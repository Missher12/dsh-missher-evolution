import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '..')
const pluginRoot = repositoryRoot

describe('native platform acceptance contract', () => {
  test('pins all supported package runners and native acceptance', () => {
    const workflowPath = resolve(repositoryRoot, '.github/workflows/verify.yml')
    expect(existsSync(workflowPath)).toBe(true)
    const workflow = readFileSync(workflowPath, 'utf8')
    for (const value of [
      'macos-15-intel',
      'windows-2025',
      'ubuntu-24.04',
      '22.19.0',
      '11.7.0',
      'pnpm run test',
      'verify-package.mjs',
      'native-smoke.mjs',
    ]) expect(workflow).toContain(value)
    expect(workflow).not.toMatch(/audit\.jsonl|state\.json|missher-evolution\/backups/u)
  })

  test('requires restart, injection, uninstall, and adjacent-data preservation', () => {
    const scriptPath = resolve(pluginRoot, 'scripts/native-smoke.mjs')
    expect(existsSync(scriptPath)).toBe(true)
    const script = readFileSync(scriptPath, 'utf8')
    for (const field of [
      'capture',
      'restart',
      'injection',
      'uninstall',
      'adjacentDataPreserved',
    ]) expect(script).toContain(field)
    expect(script).toContain('dsh-missher-evolution')
    expect(script).toContain('missher-evolution')
    expect(script).not.toMatch(/process\.env\.(?:API_KEY|TOKEN|PASSWORD)/u)
  })
})
