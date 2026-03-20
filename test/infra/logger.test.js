import { createLogger } from '../../src/infra/logger.js'
import { readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

async function run() {
  console.log('Logger tests')

  const logDir = join(tmpdir(), `presence-log-test-${Date.now()}`)

  // 1. Logger creates log directory and file
  const { logger, setLevel } = createLogger({ level: 'info', logDir })
  assert(existsSync(logDir), 'log directory created')

  // 2. Info message is written (level = info)
  logger.info('test info message', { extra: 'data' })

  // Winston writes asynchronously, wait a bit
  await new Promise(r => setTimeout(r, 200))
  const logFile = join(logDir, 'agent.log')
  const content = readFileSync(logFile, 'utf-8')
  assert(content.includes('test info message'), 'info message written to file')
  assert(content.includes('"extra":"data"'), 'extra data in JSON format')

  // 3. Debug message NOT written at info level
  logger.debug('debug message should not appear')
  await new Promise(r => setTimeout(r, 200))
  const content2 = readFileSync(logFile, 'utf-8')
  assert(!content2.includes('debug message should not appear'), 'debug not written at info level')

  // 4. After setLevel('debug'), debug messages are written
  setLevel('debug')
  logger.debug('debug now visible')
  await new Promise(r => setTimeout(r, 200))
  const content3 = readFileSync(logFile, 'utf-8')
  assert(content3.includes('debug now visible'), 'debug written after setLevel(debug)')

  // 5. Error is always logged
  setLevel('info')
  logger.error('critical error', { code: 500 })
  await new Promise(r => setTimeout(r, 200))
  const content4 = readFileSync(logFile, 'utf-8')
  assert(content4.includes('critical error'), 'error always logged')

  // 6. JSON format with timestamp
  const lines = content4.trim().split('\n')
  const lastLine = JSON.parse(lines[lines.length - 1])
  assert(lastLine.timestamp !== undefined, 'log entry has timestamp')
  assert(lastLine.level !== undefined, 'log entry has level')

  // Cleanup
  rmSync(logDir, { recursive: true, force: true })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
