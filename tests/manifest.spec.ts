import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('bundle manifest', () => {
  test('ships one prebuilt cross-platform dsh bundle and client entry', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    expect(manifest).toMatchObject({
      name: 'dsh-missher-evolution',
      version: '0.1.1',
      type: 'module',
      main: 'lib/index.js',
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web' },
      },
    })
    expect(manifest.scripts).not.toHaveProperty('prepare')
    expect(manifest.scripts).not.toHaveProperty('install')
    expect(manifest.scripts).not.toHaveProperty('postinstall')
    expect(manifest.scripts).toMatchObject({
      'verify:package': 'node scripts/verify-package.mjs',
    })
    expect(manifest.files).toEqual(['lib', 'cordis.patch.yml', 'README.md', 'LICENSE'])
    expect(existsSync(resolve(root, 'scripts/verify-package.mjs'))).toBe(true)
    expect(JSON.stringify(manifest)).not.toMatch(/python|hermes|feishu/i)
  })

  test('documents install, safety, recovery, and removal without external runtime requirements', () => {
    const readmePath = resolve(root, 'README.md')
    const licensePath = resolve(root, 'LICENSE')
    expect(existsSync(readmePath)).toBe(true)
    expect(existsSync(licensePath)).toBe(true)
    const readme = readFileSync(readmePath, 'utf8')
    for (const section of ['Install', 'Verify', 'Data', 'Reset', 'Backup', 'Uninstall', 'Limitations']) {
      expect(readme).toMatch(new RegExp(`^## ${section}$`, 'mu'))
    }
    expect(readme).toContain('>=0.1.8 <0.2.0')
    expect(readme).toContain('$DSH_HOME/missher-evolution')
    expect(readme).not.toMatch(/requires? (?:Hermes|Feishu)|依赖(?: Hermes|飞书)/iu)
  })
})
