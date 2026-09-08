import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { checkRows, digest, report, type VerificationReport } from './verification.js'

export interface FileCheckRequest {
  checkerId: 'missing-values-v1' | 'source-dates-v1'
  source: string
  artifact: string
  key: string
  field: string
}
const MAX_FILE_BYTES = 256 * 1_024
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u

export function parseCheckArguments(args: readonly string[]): FileCheckRequest | null {
  if (args.length !== 10 || args[0] !== '--checker' || args[2] !== '--source'
    || args[4] !== '--artifact' || args[6] !== '--key' || args[8] !== '--field') return null
  const [checkerId, source, artifact, key, field] = [args[1], args[3], args[5], args[7], args[9]]
  if ((checkerId !== 'missing-values-v1' && checkerId !== 'source-dates-v1')
    || !source || !artifact || !key || !field || !FIELD.test(key) || !FIELD.test(field) || key === field) return null
  return { checkerId, source, artifact, key, field }
}

async function checkedPath(root: string, name: string): Promise<string> {
  if (!name || name.length > 512 || isAbsolute(name) || /[\\\x00-\x1f\x7f:]/u.test(name)
    || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid_path')
  let current = root
  for (const part of name.split('/')) {
    current = join(current, part)
    if ((await lstat(current)).isSymbolicLink()) throw new Error('symlink')
  }
  const actual = await realpath(current)
  const delta = relative(root, actual)
  if (!delta || delta === '..' || delta.startsWith(`..${sep}`) || isAbsolute(delta)) throw new Error('outside_root')
  return actual
}

async function readStable(root: string, name: string) {
  const path = await checkedPath(root, name)
  if (!(await lstat(path)).isFile()) throw new Error('invalid_file')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(MAX_FILE_BYTES)) throw new Error('invalid_file')
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
    let used = 0
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, used)
      if (!bytesRead) break
      used += bytesRead
    }
    const after = await file.stat({ bigint: true })
    const current = await lstat(await checkedPath(root, name), { bigint: true })
    const revision = (s: typeof before) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':')
    if (used > MAX_FILE_BYTES || BigInt(used) !== before.size || revision(before) !== revision(after)
      || revision(before) !== revision(current)) throw new Error('changed')
    const bytes = buffer.subarray(0, used)
    return { hash: digest(bytes), identity: `${before.dev}:${before.ino}`,
      value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown }
  } finally { await file.close() }
}

export async function checkFiles(cwd: string, request: FileCheckRequest): Promise<VerificationReport> {
  const checkerId = request.checkerId
  if (!parseCheckArguments(['--checker', checkerId, '--source', request.source, '--artifact', request.artifact,
    '--key', request.key, '--field', request.field]) || !isAbsolute(cwd)) return report(checkerId, 'error', 'invalid_input')
  try {
    const root = await realpath(resolve(cwd))
    const source = await readStable(root, request.source)
    const artifact = await readStable(root, request.artifact)
    if (source.identity === artifact.identity) return report(checkerId, 'error', 'invalid_input')
    const project = (input: unknown) => {
      if (!Array.isArray(input) || input.length > 1_000) return null
      return input.map((row: unknown) => {
        if (row === null || typeof row !== 'object' || Array.isArray(row)
          || !Object.hasOwn(row, request.key) || !Object.hasOwn(row, request.field)) return null
        const object = row as Record<string, unknown>
        return { id: object[request.key], value: object[request.field] }
      })
    }
    const result = checkRows(checkerId, project(source.value), project(artifact.value))
    // Include projection identity: checking a different field is not the same binding.
    const sourceHash = digest(JSON.stringify([request.key, request.field, source.hash]))
    const artifactHash = digest(JSON.stringify([request.key, request.field, artifact.hash]))
    return { ...result, sourceHash, artifactHash, bindingHash: digest(`${checkerId}:${sourceHash}`) }
  } catch {
    return report(checkerId, 'error', 'invalid_input')
  }
}

/** Recognizes only the registered binary, without shell expansion, chaining or redirects. */
export function parseCheckerCommand(command: unknown, executable: string, cliPath: string): FileCheckRequest | null {
  if (typeof command !== 'string' || command.length > 3_072) return null
  const tokens: string[] = []
  const pattern = /\s*(?:'([^'\r\n]*)'|"([^"$`\\\r\n]*)"|([A-Za-z0-9_./:@+-]+))/gy
  let end = 0
  while (end < command.length) {
    pattern.lastIndex = end
    const match = pattern.exec(command)
    if (!match) return command.slice(end).trim() === '' ? parseTokens() : null
    tokens.push(match[1] ?? match[2] ?? match[3]!)
    end = pattern.lastIndex
    if (tokens.length > 12) return null
    if (end < command.length && !/\s/u.test(command[end]!)) return null
  }
  return parseTokens()
  function parseTokens() {
    if (tokens[0] !== executable || tokens[1] !== cliPath) return null
    return parseCheckArguments(tokens.slice(2))
  }
}
