#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

const expectedVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version

const REQUIRED_FILES = new Set([
  'package/package.json',
  'package/cordis.patch.yml',
  'package/lib/index.js',
  'package/lib/index.d.ts',
  'package/lib/client.js',
  'package/lib/client.js.map',
  'package/lib/typert.host.js',
  'package/lib/typert.host.d.ts',
  'package/lib/typert.remote-client.js',
  'package/lib/typert.remote-client.d.ts',
  'package/lib/check-cli.js',
  'package/lib/check-cli.d.ts',
])
const OPTIONAL_FILES = new Set(['package/README.md', 'package/LICENSE'])
const RUNTIME_CHUNK = /^package\/lib\/remote-contract-[A-Za-z0-9_-]+\.js$/u
const DECLARATION_CHUNK = /^package\/lib\/schemas-[A-Za-z0-9_-]+\.d\.ts$/u
const VERIFICATION_CHUNK = /^package\/lib\/verification(?:-files)?-[A-Za-z0-9_-]+\.(?:js|d\.ts)$/u
const TYPES_CHUNK = /^package\/lib\/types-[A-Za-z0-9_-]+\.(?:js|d\.ts)$/u
const TEXT_FILE = /(?:\.d\.ts|\.js|\.json|\.map|\.md|\.yml|\/LICENSE)$/u
const FORBIDDEN_FILE = /(?:^|\/)(?:src|tests?|scripts?|state|backups?)(?:\/|\.|$)|(?:^|\/)(?:\.env(?:\.|$)|audit(?:\.|$))|\.(?:pem|key)$/iu
const PRIVATE_KEY_VALUE = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{64,}/u
const SECRET_VALUE = /(?:api[_-]?key|authorization|bearer|password|secret|token)\s*[:=]\s*["']?[A-Za-z0-9_./+\-=]{20,}/iu
const ESCAPING_RUNTIME_IMPORT = /(?:from\s+|import\s*(?:\(\s*)?)["'](?:\.\.\/){2,}/u
const ABSOLUTE_BUILD_PATH = /(?:\/Users\/|\/home\/|[A-Za-z]:\\)[^\r\n"']*Missher Evolution/u
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024
const MAX_EXPANDED_BYTES = 20 * 1024 * 1024

export async function verifyPackage(inputPath) {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    throw new Error('usage: verify-package.mjs <package.tgz>')
  }
  const archivePath = resolve(inputPath)
  const archive = await readFile(archivePath)
  if (archive.length === 0 || archive.length > MAX_ARCHIVE_BYTES) throw new Error('archive_size_invalid')
  const expanded = gunzipSync(archive, { maxOutputLength: MAX_EXPANDED_BYTES })
  const entries = readTar(expanded)
  const files = [...entries.keys()].sort()
  const chunks = files.filter(file => RUNTIME_CHUNK.test(file))
  if (chunks.length !== 1) throw new Error('runtime_chunk_invalid')
  for (const required of REQUIRED_FILES) {
    if (!entries.has(required)) throw new Error(`required_file_missing:${required}`)
  }
  for (const file of files) {
    if (
      !REQUIRED_FILES.has(file)
      && !OPTIONAL_FILES.has(file)
      && !RUNTIME_CHUNK.test(file)
      && !DECLARATION_CHUNK.test(file)
      && !VERIFICATION_CHUNK.test(file)
      && !TYPES_CHUNK.test(file)
    ) throw new Error(`unexpected_file:${file}`)
    if (FORBIDDEN_FILE.test(file)) throw new Error(`forbidden_file:${file}`)
  }

  const manifest = parseJson(entries.get('package/package.json'), 'package_json_invalid')
  assertManifest(manifest)
  const patch = requiredText(entries, 'package/cordis.patch.yml')
  if (patch.includes('\r') || !patch.endsWith('\n')) throw new Error('patch_must_be_lf')
  if (!/^\s*- insert:/mu.test(patch) || !/name: dsh-missher-evolution/u.test(patch)) {
    throw new Error('patch_invalid')
  }
  const client = requiredText(entries, 'package/lib/client.js')
  if (!client.startsWith('window.__ModuleLoader__.load')) throw new Error('client_wrapper_invalid')

  for (const [file, bytes] of entries) {
    if (!TEXT_FILE.test(file)) continue
    const value = bytes.toString('utf8')
    if (value.includes('\u0000')) throw new Error(`binary_text:${file}`)
    if (PRIVATE_KEY_VALUE.test(value) || SECRET_VALUE.test(value)) {
      throw new Error(`secret_marker:${file}`)
    }
    if (file.startsWith('package/lib/')) assertSelfContainedText(file, value)
    if (file.endsWith('.map')) assertPortableSourceMap(file, value)
  }

  return {
    ok: true,
    files: files.length,
    bytes: archive.length,
    sha256: createHash('sha256').update(archive).digest('hex'),
  }
}

export function assertSelfContainedText(file, value) {
  if (ESCAPING_RUNTIME_IMPORT.test(value)) throw new Error(`escaping_runtime_import:${file}`)
  if (ABSOLUTE_BUILD_PATH.test(value)) throw new Error(`absolute_build_path:${file}`)
  if (file.endsWith('.js') && /(?:from\s*|import\s*\(|require\s*\()\s*["']zod(?:\/[^"']*)?["']/u.test(value)) {
    throw new Error(`unbundled_runtime_dependency:${file}`)
  }
}

function readTar(buffer) {
  const entries = new Map()
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    validateChecksum(header)
    const name = tarPath(header)
    const size = parseOctal(header.subarray(124, 136), 'tar_size_invalid')
    const type = header[156]
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > buffer.length) throw new Error('tar_truncated')
    validateTarPath(name)
    if (type === 0 || type === 48) {
      if (entries.has(name)) throw new Error(`duplicate_file:${name}`)
      entries.set(name, Buffer.from(buffer.subarray(dataStart, dataEnd)))
    } else if (type !== 53) {
      throw new Error(`unsupported_tar_entry:${name}`)
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return entries
}

function validateChecksum(header) {
  const expected = parseOctal(header.subarray(148, 156), 'tar_checksum_invalid')
  let actual = 0
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index]
  }
  if (actual !== expected) throw new Error('tar_checksum_invalid')
}

function tarPath(header) {
  const name = readCString(header.subarray(0, 100))
  const prefix = readCString(header.subarray(345, 500))
  return prefix === '' ? name : `${prefix}/${name}`
}

function readCString(buffer) {
  const end = buffer.indexOf(0)
  return buffer.subarray(0, end < 0 ? buffer.length : end).toString('utf8')
}

function parseOctal(buffer, code) {
  const value = readCString(buffer).trim()
  if (!/^[0-7]+$/u.test(value)) throw new Error(code)
  const parsed = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(code)
  return parsed
}

function validateTarPath(value) {
  if (
    value === ''
    || value.includes('\\')
    || value.startsWith('/')
    || value.split('/').some(segment => segment === '..' || segment === '')
  ) throw new Error('tar_path_invalid')
}

function requiredText(entries, file) {
  const value = entries.get(file)
  if (value === undefined) throw new Error(`required_file_missing:${file}`)
  return value.toString('utf8')
}

function parseJson(value, code) {
  if (value === undefined) throw new Error(code)
  try {
    return JSON.parse(value.toString('utf8'))
  } catch {
    throw new Error(code)
  }
}

function assertManifest(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('package_json_invalid')
  }
  if (
    value.name !== 'dsh-missher-evolution'
    || value.version !== expectedVersion
    || value.type !== 'module'
    || value.main !== 'lib/index.js'
    || value.types !== 'lib/index.d.ts'
    || value.dsh?.bundle?.patch !== './cordis.patch.yml'
    || value.dsh?.client?.platform !== 'web'
    || value.scripts?.prepare !== undefined
    || value.scripts?.install !== undefined
    || value.scripts?.postinstall !== undefined
  ) throw new Error('package_manifest_invalid')
}

function assertPortableSourceMap(file, value) {
  const map = parseJson(Buffer.from(value), `source_map_invalid:${file}`)
  if (!Array.isArray(map.sources)) throw new Error(`source_map_invalid:${file}`)
  for (const source of map.sources) {
    if (
      typeof source !== 'string'
      || isAbsolute(source)
      || /^[A-Za-z]:[\\/]/u.test(source)
      || source.startsWith('\\\\')
    ) throw new Error(`absolute_source_path:${file}`)
  }
}

async function main() {
  try {
    console.log(JSON.stringify(await verifyPackage(process.argv[2])))
  } catch (error) {
    const code = error instanceof Error ? error.message : 'verification_failed'
    console.error(JSON.stringify({ ok: false, code }))
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
