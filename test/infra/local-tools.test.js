import { initI18n } from '../../src/i18n/index.js'
initI18n('en')
import { createLocalTools, isPathAllowed, normalizePath } from '../../src/infra/local-tools.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

async function run() {
  console.log('Local tools tests')

  const testDir = join(tmpdir(), `presence-tools-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
  writeFileSync(join(testDir, 'hello.txt'), 'Hello World')
  mkdirSync(join(testDir, 'subdir'))
  writeFileSync(join(testDir, 'subdir', 'nested.txt'), 'Nested')

  const tools = createLocalTools({ allowedDirs: [testDir] })
  const byName = Object.fromEntries(tools.map(t => [t.name, t]))

  // --- isPathAllowed (순수) ---

  assert(isPathAllowed('/any/path', []) === true, 'isPathAllowed: empty dirs → always allowed')
  assert(isPathAllowed(join(testDir, 'hello.txt'), [testDir]) === true, 'isPathAllowed: inside allowed')
  assert(isPathAllowed('/etc/passwd', [testDir]) === false, 'isPathAllowed: outside denied')
  assert(isPathAllowed(testDir + '-evil/secret.txt', [testDir]) === false, 'isPathAllowed: sibling-prefix denied')
  assert(isPathAllowed(testDir, [testDir]) === true, 'isPathAllowed: exact dir match')

  // --- normalizePath ---
  {
    // 이미 허용 내부 절대경로 → 그대로
    const n1 = normalizePath(join(testDir, 'hello.txt'), [testDir])
    assert(n1 === join(testDir, 'hello.txt'), 'normalizePath correct absolute: kept as-is')

    // /hello.txt (잘못된 절대) + 실제 존재 → 허용 디렉토리 기준 재해석
    const n2 = normalizePath('/hello.txt', [testDir])
    assert(n2 === join(testDir, 'hello.txt'), 'normalizePath wrong absolute + exists: reinterpreted')

    // /etc/passwd (잘못된 절대) + 허용 내 미존재 → 재해석 안 됨
    const n3 = normalizePath('/etc/passwd', [testDir])
    assert(n3 === '/etc/passwd', 'normalizePath system path: not reinterpreted')
  }

  // --- file_read ---

  {
    const result = byName.file_read.handler({ path: join(testDir, 'hello.txt') })
    assert(result === 'Hello World', 'file_read: reads content')
  }

  {
    try {
      byName.file_read.handler({ path: join(testDir, 'nonexistent.txt') })
      assert(false, 'file_read missing: should throw')
    } catch (e) {
      assert(e.message.includes('not found'), 'file_read missing: error message')
    }
  }

  {
    try {
      byName.file_read.handler({ path: '/etc/passwd' })
      assert(false, 'file_read denied: should throw')
    } catch (e) {
      assert(e.message.includes('Access denied'), 'file_read denied: error message')
    }
  }

  // file_read maxLines
  {
    const multiline = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
    writeFileSync(join(testDir, 'multi.txt'), multiline)
    const full = byName.file_read.handler({ path: join(testDir, 'multi.txt') })
    assert(full.split('\n').length === 20, 'file_read: full file has 20 lines')
    const first5 = byName.file_read.handler({ path: join(testDir, 'multi.txt'), maxLines: 5 })
    assert(first5.split('\n').length === 5, 'file_read maxLines: returns 5 lines')
    assert(first5.startsWith('line 1\n'), 'file_read maxLines: starts from line 1')
    const noLimit = byName.file_read.handler({ path: join(testDir, 'multi.txt'), maxLines: 0 })
    assert(noLimit.split('\n').length === 20, 'file_read maxLines 0: returns all')
  }

  // --- file_write ---

  {
    const result = byName.file_write.handler({ path: join(testDir, 'output.txt'), content: 'Written!' })
    assert(result.includes('Written'), 'file_write: success message')

    const readBack = byName.file_read.handler({ path: join(testDir, 'output.txt') })
    assert(readBack === 'Written!', 'file_write: content persisted')
  }

  {
    try {
      byName.file_write.handler({ path: '/tmp/not-allowed/file.txt', content: 'x' })
      assert(false, 'file_write denied: should throw')
    } catch (e) {
      assert(e.message.includes('Access denied'), 'file_write denied: error message')
    }
  }

  // --- file_list ---

  {
    const result = byName.file_list.handler({ path: testDir })
    assert(result.includes('hello.txt'), 'file_list: includes file')
    assert(result.includes('subdir/'), 'file_list: marks directories with trailing /')
    assert(result.includes('├──') || result.includes('└──'), 'file_list: tree connectors')
  }

  {
    try {
      byName.file_list.handler({ path: join(testDir, 'nonexistent') })
      assert(false, 'file_list missing: should throw')
    } catch (e) {
      assert(e.message.includes('not found'), 'file_list missing: error message')
    }
  }

  // --- web_fetch ---

  {
    // 실 네트워크 대신 handler 시그니처만 확인
    assert(typeof byName.web_fetch.handler === 'function', 'web_fetch: handler exists')
    assert(byName.web_fetch.parameters.required[0] === 'url', 'web_fetch: requires url')
  }

  // --- shell_exec ---

  {
    const result = byName.shell_exec.handler({ command: 'echo hello' })
    assert(result === 'hello', 'shell_exec: captures stdout')
  }

  {
    try {
      byName.shell_exec.handler({ command: 'exit 1' })
      assert(false, 'shell_exec fail: should throw')
    } catch (e) {
      assert(e.message.includes('Command failed'), 'shell_exec fail: error message')
    }
  }

  // --- 도구 메타데이터 ---

  assert(tools.length === 6, 'tools: 6 registered')
  assert(tools.every(t => t.name && t.description && t.parameters && t.handler), 'tools: all have required fields')
  assert(byName.file_write.description.includes('APPROVE'), 'file_write: description mentions APPROVE')
  assert(byName.shell_exec.description.includes('APPROVE'), 'shell_exec: description mentions APPROVE')

  // Cleanup
  rmSync(testDir, { recursive: true, force: true })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
