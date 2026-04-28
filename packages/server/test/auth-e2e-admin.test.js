/**
 * Auth E2E — Admin bootstrap (AE16-18).
 *  AE16. Admin bootstrap — initial-password 파일 생성 + 변경 시 자동 삭제
 *  AE17. Admin bootstrap idempotent — 재부팅 시 admin 재생성 안됨
 *  AE18 (KG-16). admin POST /sessions 가 config.primaryAgentId 사용 — 'admin/manager'
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { inspectAccessInvocations, resetAccessInvocations } from '@presence/infra/infra/authz/agent-access.js'
import { assert, summary } from '../../../test/lib/assert.js'
import { createMockLLM, delay, request, setupAuthServer } from './auth-e2e-helpers.js'

async function run() {
  console.log('Auth E2E — Admin bootstrap (AE16-18)')

  const mockLLM = createMockLLM()
  const llmPort = await mockLLM.start()

  // AE16. Admin bootstrap — initial-password 파일 + 변경 시 자동 삭제
  //       (docs/design/agent-identity-model.md §7.3)
  {
    const { server, shutdown, tmpDir } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      const pwdFile = join(tmpDir, 'admin-initial-password.txt')
      assert(existsSync(pwdFile), 'AE16: admin-initial-password.txt 생성됨')
      const initialPassword = readFileSync(pwdFile, 'utf-8').trim()
      assert(initialPassword.length >= 12, `AE16: 초기 비밀번호 길이 (got ${initialPassword.length})`)

      const loginRes = await request(port, 'POST', '/api/auth/login', {
        username: 'admin', password: initialPassword,
      })
      assert(loginRes.status === 200, `AE16: admin 로그인 성공 (got ${loginRes.status})`)
      assert(loginRes.body.mustChangePassword === true, 'AE16: mustChangePassword=true')

      const changeRes = await request(port, 'POST', '/api/auth/change-password', {
        currentPassword: initialPassword, newPassword: 'new-admin-password-456',
      }, { token: loginRes.body.accessToken })
      assert(changeRes.status === 200, `AE16: 비밀번호 변경 성공 (got ${changeRes.status})`)

      await delay(50)
      assert(!existsSync(pwdFile), 'AE16: initial-password 파일 자동 삭제됨')
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // AE17. Admin bootstrap idempotent — 재부팅 시 admin 재생성 안됨
  {
    const { shutdown: sd1, tmpDir, userStore } = await setupAuthServer(llmPort)
    await sd1()

    const adminBefore = userStore.findUser('admin')
    assert(adminBefore !== null, 'AE17: 첫 부팅 후 admin 존재')
    const hashBefore = adminBefore.passwordHash

    process.env.PRESENCE_DIR = tmpDir
    const { loadUserMerged } = await import('@presence/infra/infra/config-loader.js')
    const config = loadUserMerged('auth-test', { basePath: tmpDir })
    const { startServer } = await import('@presence/server')
    const result = await startServer(config, { port: 0, persistenceCwd: tmpDir, instanceId: 'auth-test' })
    try {
      const adminAfter = userStore.findUser('admin')
      assert(adminAfter !== null, 'AE17: 재부팅 후에도 admin 존재')
      assert(adminAfter.passwordHash === hashBefore, 'AE17: passwordHash 변경 없음 (재생성 안됨)')
    } finally {
      await result.shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // AE18 (KG-16). admin POST /sessions 가 config.primaryAgentId 사용
  //               — 'admin/manager' (hardcode 'admin/default' 가 아님)
  {
    const { server, shutdown, tmpDir } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      const pwdFile = join(tmpDir, 'admin-initial-password.txt')
      assert(existsSync(pwdFile), 'AE18: admin-initial-password.txt 존재')
      const initialPassword = readFileSync(pwdFile, 'utf-8').trim()

      const loginRes = await request(port, 'POST', '/api/auth/login', { username: 'admin', password: initialPassword })
      assert(loginRes.status === 200, `AE18: admin login (got ${loginRes.status})`)
      await request(port, 'POST', '/api/auth/change-password', {
        currentPassword: initialPassword, newPassword: 'admin-new-password-789',
      }, { token: loginRes.body.accessToken })

      const re = await request(port, 'POST', '/api/auth/login', { username: 'admin', password: 'admin-new-password-789' })
      const token = re.body.accessToken

      resetAccessInvocations()
      const createRes = await request(port, 'POST', '/api/sessions', { type: 'user' }, { token })
      assert(createRes.status === 201, `AE18: POST /sessions 201 (got ${createRes.status} ${JSON.stringify(createRes.body)})`)

      const calls = inspectAccessInvocations()
      const newSession = calls.find(c => c.intent === 'new-session')
      assert(newSession, 'AE18 (KG-16): new-session intent invocation 존재')
      assert(newSession?.agentId === 'admin/manager', `AE18 (KG-16): agentId = admin/manager (got ${newSession?.agentId})`)
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  await mockLLM.close()
  summary()
}

run()
