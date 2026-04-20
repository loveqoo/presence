import { initI18n } from '@presence/infra/i18n'
initI18n('en')
import { createLocalTools, isPathAllowed, normalizePath, resolveInWorkingDir, analyzeWebFetchResult } from '@presence/infra/infra/tools/local-tools.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assert, summary } from '../../../test/lib/assert.js'

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
    const last3 = byName.file_read.handler({ path: join(testDir, 'multi.txt'), tailLines: 3 })
    assert(last3.split('\n').length === 3, 'file_read tailLines: returns 3 lines')
    assert(last3.endsWith('line 20'), 'file_read tailLines: ends with last line')
    assert(last3.startsWith('line 18'), 'file_read tailLines: starts from correct offset')
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

  // --- resolveInWorkingDir (워킹 디렉토리 기준 해석) ---

  {
    // 정상: workingDir 기준 상대경로 → 절대경로
    const result = resolveInWorkingDir('hello.txt', testDir, [testDir])
    assert(result === join(testDir, 'hello.txt'), 'resolveInWorkingDir: 상대경로 정상')
  }

  {
    // workingDir 누락 → throw
    let thrown = null
    try { resolveInWorkingDir('x', null, [testDir]) } catch (e) { thrown = e }
    assert(thrown && /workingDir required/.test(thrown.message), 'resolveInWorkingDir: workingDir 누락 throw')
  }

  {
    // allowedDirs 밖 → throw
    let thrown = null
    try { resolveInWorkingDir('/etc/passwd', testDir, [testDir]) } catch (e) { thrown = e }
    assert(thrown && /denied|outside|access/i.test(thrown.message), 'resolveInWorkingDir: allowedDirs 밖 throw')
  }

  {
    // `..` 로 경계 탈출 시도 → throw
    let thrown = null
    try { resolveInWorkingDir('../../../etc/passwd', testDir, [testDir]) } catch (e) { thrown = e }
    assert(thrown, 'resolveInWorkingDir: `..` 경계 탈출 throw')
  }

  // --- analyzeWebFetchResult (FP-62 결과 품질 점검) ---

  {
    // 정상 응답 → not suspicious
    const longNormal = 'a'.repeat(500)
    assert(analyzeWebFetchResult('https://example.com', longNormal).suspicious === false,
      'analyzeWebFetchResult: 정상 긴 응답 → not suspicious')
  }

  {
    // 빈 응답 → suspicious empty
    const r = analyzeWebFetchResult('https://example.com', '')
    assert(r.suspicious === true && r.reason === 'empty_response',
      'analyzeWebFetchResult: 빈 응답 → suspicious (empty_response)')
  }

  {
    // whitespace 만 있는 응답 → suspicious empty (trim 후 empty)
    const r = analyzeWebFetchResult('https://example.com', '   \n\n  ')
    assert(r.suspicious === true && r.reason === 'empty_response',
      'analyzeWebFetchResult: whitespace only → empty_response')
  }

  {
    // 짧은 응답 (< WEB_FETCH_MIN_CONTENT) → suspicious short
    const r = analyzeWebFetchResult('https://example.com', 'just 50 chars short content')
    assert(r.suspicious === true && r.reason === 'very_short_response',
      'analyzeWebFetchResult: 짧은 응답 → very_short_response')
  }

  {
    // Wikipedia disambiguation 페이지 → suspicious disambiguation
    const disambig = 'FSM may refer to: Finite-state machine... ' + 'x'.repeat(300)
    const r = analyzeWebFetchResult('https://en.wikipedia.org/wiki/FSM', disambig)
    assert(r.suspicious === true && r.reason === 'disambiguation_page',
      'analyzeWebFetchResult: Wikipedia may refer to → disambiguation_page')
  }

  {
    // Wikipedia "does not have an article" → suspicious missing
    const missing = 'Wikipedia does not have an article with this exact name... ' + 'x'.repeat(300)
    const r = analyzeWebFetchResult('https://en.wikipedia.org/wiki/Nonexistent', missing)
    assert(r.suspicious === true && r.reason === 'missing_article',
      'analyzeWebFetchResult: Wikipedia missing → missing_article')
  }

  {
    // 일반 긴 Wikipedia 응답 → not suspicious (disambiguation/missing 패턴 없음)
    const normalWiki = 'Finite-state machine is a computational model... ' + 'content '.repeat(100)
    const r = analyzeWebFetchResult('https://en.wikipedia.org/wiki/Finite-state_machine', normalWiki)
    assert(r.suspicious === false,
      'analyzeWebFetchResult: 정상 Wikipedia 문서 → not suspicious')
  }

  // --- 도구 메타데이터 ---

  assert(tools.length === 6, 'tools: 6 registered')
  assert(tools.every(t => t.name && t.description && t.parameters && t.handler), 'tools: all have required fields')
  assert(byName.file_write.description.includes('APPROVE'), 'file_write: description mentions APPROVE')
  assert(byName.shell_exec.description.includes('APPROVE'), 'shell_exec: description mentions APPROVE')

  // Cleanup
  rmSync(testDir, { recursive: true, force: true })

  summary()
}

run()
