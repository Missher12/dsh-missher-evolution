#!/usr/bin/env node
import { isAbsolute, join } from 'node:path'
import { JsonlAdapter } from './jsonl.js'
import { resolveAgentStateRoot } from './paths.js'
import { EvolutionStore } from './store.js'
import { runConformance, lifecycleConformanceVectors } from './conformance.js'
import { JsonlRequestSchema } from './jsonl.js'
import { z } from 'zod'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--conformance') {
    const result = runConformance()
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (!result.ok) process.exitCode = 1
    return
  }
  if (args.length === 1 && args[0] === '--protocol') {
    process.stdout.write(`${JSON.stringify({ ...lifecycleConformanceVectors(), requestSchema: z.toJSONSchema(JsonlRequestSchema) })}\n`)
    return
  }
  let instanceId = 'default'
  let base: string | undefined
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1]
    if (value === undefined || (key !== '--instance' && key !== '--state-base')) throw new Error('invalid_arguments')
    if (key === '--instance') instanceId = value
    else base = value
  }
  const defaultRoot = resolveAgentStateRoot({ adapterId: 'generic-jsonl', instanceId })
  if (base !== undefined && (!isAbsolute(base) || /[\u0000-\u001f\u007f]/u.test(base))) throw new Error('invalid_arguments')
  const root = base === undefined ? defaultRoot : join(base, 'generic-jsonl', instanceId)
  const adapter = new JsonlAdapter(new EvolutionStore(root), { instanceKey: root })
  let buffer = '', oversized = false
  const respond = (result: unknown) => process.stdout.write(`${JSON.stringify(result)}\n`)
  const consume = async (line: string) => {
    if (!line.trim()) return
    try { respond(await adapter.request(JSON.parse(line))) }
    catch { respond({ ok: false, code: 'invalid_json' }) }
  }
  process.stdin.setEncoding('utf8')
  try {
    for await (const chunk of process.stdin) {
      for (const part of String(chunk).split(/(?<=\n)/u)) {
        if (!oversized) {
          buffer += part
          if (Buffer.byteLength(buffer, 'utf8') > 65_536) { buffer = ''; oversized = true }
        }
        if (part.endsWith('\n')) {
          if (oversized) respond({ ok: false, code: 'line_too_large' })
          else await consume(buffer)
          buffer = ''; oversized = false
        }
      }
    }
    if (oversized) respond({ ok: false, code: 'line_too_large' })
    else await consume(buffer)
  } finally { await adapter.dispose() }
}

await main().catch(() => {
  process.stderr.write(`${JSON.stringify({ ok: false, code: 'adapter_start_failed' })}\n`)
  process.exitCode = 1
})
