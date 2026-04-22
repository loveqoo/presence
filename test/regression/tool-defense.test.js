/**
 * 도구 핸들러 방어 테스트
 * 모든 핸들러에 null, undefined, 빈 객체, 잘못된 타입을 전달.
 * 크래시 없이 에러를 던져야 함.
 */
import { initI18n } from '@presence/infra/i18n'
initI18n('en')
import { createLocalTools, resolveInWorkingDir } from '@presence/infra/infra/tools/local-tools.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assert, summary } from '../lib/assert.js'

async function run() {
  console.log('Tool handler defense tests')

  const testDir = join(tmpdir(), `presence-defense-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
  writeFileSync(join(testDir, 'test.txt'), 'hello')

  const tools = createLocalTools()
  const byName = Object.fromEntries(tools.map(t => [t.name, t]))
  // 세션 context 시뮬 — tool handler 의 ctx.resolvePath 로 경계 검증 (docs/specs/agent-identity.md).
  const ctx = { resolvePath: (p) => resolveInWorkingDir(p, testDir), workingDir: testDir }

  const expectThrow = async (label, fn) => {
    try {
      await fn()
      assert(false, `${label}: should throw`)
    } catch (e) {
      assert(typeof e.message === 'string' && e.message.length > 0, `${label}: throws with message`)
    }
  }

  // === file_read 방어 ===

  await expectThrow('file_read(undefined)', () => byName.file_read.handler(undefined, ctx))
  await expectThrow('file_read(null)', () => byName.file_read.handler(null, ctx))
  await expectThrow('file_read({})', () => byName.file_read.handler({}, ctx))
  await expectThrow('file_read({path: 123})', () => byName.file_read.handler({ path: 123 }, ctx))
  await expectThrow('file_read({path: ""})', () => byName.file_read.handler({ path: '' }, ctx))
  await expectThrow('file_read nonexistent', () => byName.file_read.handler({ path: 'nope.txt' }, ctx))

  // 정상 케이스
  {
    const result = byName.file_read.handler({ path: 'test.txt' }, ctx)
    assert(result === 'hello', 'file_read valid: returns content')
  }

  // === file_write 방어 ===

  await expectThrow('file_write(undefined)', () => byName.file_write.handler(undefined, ctx))
  await expectThrow('file_write({})', () => byName.file_write.handler({}, ctx))
  await expectThrow('file_write({path only})', () => byName.file_write.handler({ path: 'x.txt' }, ctx))
  await expectThrow('file_write({content only})', () => byName.file_write.handler({ content: 'hi' }, ctx))
  await expectThrow('file_write outside workspace', () => byName.file_write.handler({ path: '/etc/x', content: 'x' }, ctx))

  // 빈 문자열 content는 허용 (파일 비우기)
  {
    const result = byName.file_write.handler({ path: 'empty.txt', content: '' }, ctx)
    assert(result.includes('0 chars'), 'file_write empty content: allowed')
  }

  // === file_list 방어 ===

  await expectThrow('file_list(undefined)', () => byName.file_list.handler(undefined, ctx))
  await expectThrow('file_list({})', () => byName.file_list.handler({}, ctx))
  await expectThrow('file_list nonexistent', () => byName.file_list.handler({ path: 'nope' }, ctx))
  await expectThrow('file_list outside', () => byName.file_list.handler({ path: '/etc' }, ctx))

  {
    const result = byName.file_list.handler({ path: '.' }, ctx)
    assert(result.includes('test.txt'), 'file_list valid: lists files')
  }

  // === web_fetch 방어 ===

  await expectThrow('web_fetch(undefined)', () => byName.web_fetch.handler(undefined))
  await expectThrow('web_fetch({})', () => byName.web_fetch.handler({}))
  await expectThrow('web_fetch({url: ""})', () => byName.web_fetch.handler({ url: '' }))
  await expectThrow('web_fetch invalid url', () => byName.web_fetch.handler({ url: 'not-a-url' }))

  // === shell_exec 방어 ===

  await expectThrow('shell_exec(undefined)', () => byName.shell_exec.handler(undefined, ctx))
  await expectThrow('shell_exec({})', () => byName.shell_exec.handler({}, ctx))
  await expectThrow('shell_exec({command: ""})', () => byName.shell_exec.handler({ command: '' }, ctx))
  await expectThrow('shell_exec bad command', () => byName.shell_exec.handler({ command: 'nonexistent_command_xyz' }, ctx))

  {
    const result = byName.shell_exec.handler({ command: 'echo ok' }, ctx)
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

  await expectThrow('path traversal ../', () => byName.file_read.handler({ path: '../../../etc/passwd' }, ctx))
  await expectThrow('path traversal encoded', () => byName.file_read.handler({ path: '%2e%2e/etc/passwd' }, ctx))

  rmSync(testDir, { recursive: true, force: true })

  summary()
}

run()
