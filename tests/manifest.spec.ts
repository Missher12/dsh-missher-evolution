import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { assertSelfContainedText } from '../scripts/verify-package.mjs'

const root = resolve(import.meta.dirname, '..')

describe('bundle manifest', () => {
  test('pins the packaged Cordis patch to LF on every Git checkout', () => {
    const attributes = readFileSync(resolve(root, '.gitattributes'), 'utf8')

    expect(attributes).toContain('*.yml text eol=lf')
  })

  test('installs dependencies before type-checking the bundled shared source', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/verify.yml'), 'utf8')
    const install = workflow.indexOf('pnpm install --frozen-lockfile')
    expect(install).toBeGreaterThan(-1)
    const buildAndTest = workflow.indexOf('pnpm run test')
    expect(buildAndTest).toBeGreaterThan(install)
    expect(workflow.indexOf('pnpm exec tsc -p tsconfig.json --noEmit')).toBeGreaterThan(buildAndTest)
  })

  test('rejects source-tree imports and absolute build paths in published code', () => {
    expect(() => assertSelfContainedText('package/lib/index.js', "import { z } from 'zod'"))
      .toThrow('unbundled_runtime_dependency:package/lib/index.js')
    expect(() => assertSelfContainedText(
      'package/lib/index.js',
      "import '../../agent-product/src/engine.js'",
    )).toThrow('escaping_runtime_import:package/lib/index.js')
    expect(() => assertSelfContainedText(
      'package/lib/index.d.ts',
      'export type X = "/Users/mse/Missher Evolution/private"',
    )).toThrow('absolute_build_path:package/lib/index.d.ts')
    expect(() => assertSelfContainedText(
      'package/lib/index.js',
      '//#region ../agent-product/src/engine.ts',
    )).not.toThrow()
  })

  test('ships one prebuilt cross-platform dsh bundle and client entry', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    const release = JSON.parse(readFileSync(resolve(root, 'SOURCE_PROVENANCE.json'), 'utf8'))
    expect(manifest).toMatchObject({
      name: 'dsh-missher-evolution',
      version: release.version,
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
    expect(Object.keys(manifest.peerDependenciesMeta)).toEqual(
      Object.keys(manifest.peerDependencies),
    )
    for (const metadata of Object.values(manifest.peerDependenciesMeta)) {
      expect(metadata).toEqual({ optional: true })
    }
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
    expect(readme).toContain('>=0.3.8')
    expect(readme).toContain('missherBrain')
    expect(readme).toContain('$DSH_HOME/missher-evolution')
    expect(readme).not.toMatch(/requires? (?:Hermes|Feishu)|依赖(?: Hermes|飞书)/iu)
  })
})
