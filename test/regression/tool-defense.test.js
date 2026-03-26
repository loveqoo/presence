/**
 * 도구 핸들러 방어 테스트
 * 모든 핸들러에 null, undefined, 빈 객체, 잘못된 타입을 전달.
 * 크래시 없이 에러를 던져야 함.
 */
import { initI18n } from '../../src/i18n/index.js'
initI18n('en')
import { createLocalTools } from '../../src/infra/local-tools.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assert, summary } from '../lib/assert.js'

async function run() {
  console.log('Tool handler defense tests')

  const testDir = join(tmpdir(), `presence-defense-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
  writeFileSync(join(testDir, 'test.txt'), 'hello')

  const tools = createLocalTools({ allowedDirs: [testDir] })
  const byName = Object.fromEntries(tools.map(t => [t.name, t]))

  const expectThrow = async (label, fn) => {
    try {
      await fn()
      assert(false, `${label}: should throw`)
    } catch (e) {
      assert(typeof e.message === 'string' && e.message.length > 0, `${label}: throws with message`)
    }
  }

  // === file_read 방어 ===

  await expectThrow('file_read(undefined)', () => byName.file_read.handler(undefined))
  await expectThrow('file_read(null)', () => byName.file_read.handler(null))
  await expectThrow('file_read({})', () => byName.file_read.handler({}))
  await expectThrow('file_read({path: 123})', () => byName.file_read.handler({ path: 123 }))
  await expectThrow('file_read({path: ""})', () => byName.file_read.handler({ path: '' }))
  await expectThrow('file_read nonexistent', () => byName.file_read.handler({ path: join(testDir, 'nope.txt') }))

  // 정상 케이스
  {
    const result = byName.file_read.handler({ path: join(testDir, 'test.txt') })
    assert(result === 'hello', 'file_read valid: returns content')
  }

  // === file_write 방어 ===

  await expectThrow('file_write(undefined)', () => byName.file_write.handler(undefined))
  await expectThrow('file_write({})', () => byName.file_write.handler({}))
  await expectThrow('file_write({path only})', () => byName.file_write.handler({ path: join(testDir, 'x.txt') }))
  await expectThrow('file_write({content only})', () => byName.file_write.handler({ content: 'hi' }))
  await expectThrow('file_write outside allowed', () => byName.file_write.handler({ path: '/etc/x', content: 'x' }))

  // 빈 문자열 content는 허용 (파일 비우기)
  {
    const emptyPath = join(testDir, 'empty.txt')
    const result = byName.file_write.handler({ path: emptyPath, content: '' })
    assert(result.includes('0 chars'), 'file_write empty content: allowed')
  }

  // === file_list 방어 ===

  await expectThrow('file_list(undefined)', () => byName.file_list.handler(undefined))
  await expectThrow('file_list({})', () => byName.file_list.handler({}))
  await expectThrow('file_list nonexistent', () => byName.file_list.handler({ path: join(testDir, 'nope') }))
  await expectThrow('file_list outside', () => byName.file_list.handler({ path: '/etc' }))

  {
    const result = byName.file_list.handler({ path: testDir })
    assert(result.includes('test.txt'), 'file_list valid: lists files')
  }

  // === web_fetch 방어 ===

  await expectThrow('web_fetch(undefined)', () => byName.web_fetch.handler(undefined))
  await expectThrow('web_fetch({})', () => byName.web_fetch.handler({}))
  await expectThrow('web_fetch({url: ""})', () => byName.web_fetch.handler({ url: '' }))
  await expectThrow('web_fetch invalid url', () => byName.web_fetch.handler({ url: 'not-a-url' }))

  // === shell_exec 방어 ===

  await expectThrow('shell_exec(undefined)', () => byName.shell_exec.handler(undefined))
  await expectThrow('shell_exec({})', () => byName.shell_exec.handler({}))
  await expectThrow('shell_exec({command: ""})', () => byName.shell_exec.handler({ command: '' }))
  await expectThrow('shell_exec bad command', () => byName.shell_exec.handler({ command: 'nonexistent_command_xyz' }))

  {
    const result = byName.shell_exec.handler({ command: 'echo ok' })
    assert(result === 'ok', 'shell_exec valid: returns stdout')
  }

  // === calculate 방어 ===

  await expectThrow('calculate(undefined)', () => byName.calculate.handler(undefined))
  await expectThrow('calculate({})', () => byName.calculate.handler({}))
  await expectThrow('calculate invalid expr', () => byName.calculate.handler({ expression: 'not math' }))
  await expectThrow('calculate infinity', () => byName.calculate.handler({ expression: '1/0' }))

  {
    const result = byName.calculate.handler({ expression: '7 * 13' })
    assert(result === '91', 'calculate valid: returns result')
  }

  // === 경로 트래버설 방어 ===

  await expectThrow('path traversal ../', () => byName.file_read.handler({ path: join(testDir, '../../../etc/passwd') }))
  await expectThrow('path traversal encoded', () => byName.file_read.handler({ path: testDir + '/%2e%2e/etc/passwd' }))

  rmSync(testDir, { recursive: true, force: true })

  summary()
}

run()
