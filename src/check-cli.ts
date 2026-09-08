#!/usr/bin/env node
import { checkFiles, parseCheckArguments } from '../agent-product/src/verification-files.js'
import { report } from '../agent-product/src/verification.js'

const request = parseCheckArguments(process.argv.slice(2))
const result = request ? await checkFiles(process.cwd(), request) : report('missing-values-v1', 'error', 'invalid_input')
process.stdout.write(`${JSON.stringify(result)}\n`)
// A negative finding is a completed check, not a failed checker process.
process.exitCode = result.status === 'error' ? 2 : 0
