#!/usr/bin/env node
import { checkFiles, parseCheckArguments } from './verification-files.js'
import { report } from './verification.js'

const request = parseCheckArguments(process.argv.slice(2))
const result = request ? await checkFiles(process.cwd(), request) : report('missing-values-v1', 'error', 'invalid_input')
process.stdout.write(`${JSON.stringify(result)}\n`)
// A completed check (including a negative finding) is distinct from checker failure.
process.exitCode = result.status === 'error' ? 2 : 0
