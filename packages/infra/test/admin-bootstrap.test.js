import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createUserStore } from '@presence/infra/infra/auth/user-store.js'
import {
  runAdminBootstrap,
  deleteInitialPasswordFile,
  ADMIN_USERNAME,
  ADMIN_AGENT_NAME,
  ADMIN_AGENT_ID,
  INITIAL_PASSWORD_FILENAME,
  DEFAULT_POLICIES,
} from '@presence/infra/infra/admin-bootstrap.js'
import { assert, summary } from '../../../test/lib/assert.js'

const createTmpDir = () => {
  const dir = join(tmpdir(), `presence-admin-bs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

async function run() {
  console.log('Admin bootstrap tests')

  // AB1. Fresh bootstrap — 3 단계 모두 실행
  {
    const dir = createTmpDir()
    const userStore = createUserStore({ basePath: dir })
    const result = await runAdminBootstrap({ userStore, presenceDir: dir, logger: silentLogger })

    assert(result.createdAccount === true, 'AB1: admin account created')
    assert(typeof result.initialPassword === 'string' && result.initialPassword.length >= 12, 'AB1: random password generated')
    assert(result.registeredAgent === true, 'AB1: admin/manager agent registered')
    assert(result.createdPolicies === true, 'AB1: agent-policies.json created')

    // 파일 존재 검증
    const pwdFile = join(dir, INITIAL_PASSWORD_FILENAME)
    assert(existsSync(pwdFile), 'AB1: admin-initial-password.txt exists')
    const pwdFileContent = readFileSync(pwdFile, 'utf-8').trim()
    assert(pwdFileContent === result.initialPassword, 'AB1: password file content matches')

    const configFile = join(dir, 'users', ADMIN_USERNAME, 'config.json')
    assert(existsSync(configFile), 'AB1: admin config.json exists')
    const config = JSON.parse(readFileSync(configFile, 'utf-8'))
    assert(Array.isArray(config.agents) && config.agents.length === 1, 'AB1: admin config has 1 agent')
    assert(config.agents[0].name === ADMIN_AGENT_NAME, 'AB1: agent name = manager')
    assert(typeof config.agents[0].persona === 'object', 'AB1: agent has persona')
    assert(typeof config.agents[0].persona.systemPrompt === 'string', 'AB1: persona has systemPrompt')
    assert(config.agents[0].archived === false, 'AB1: agent not archived')

    const policiesFile = join(dir, 'users', ADMIN_USERNAME, 'agent-policies.json')
    assert(existsSync(policiesFile), 'AB1: agent-policies.json exists')
    const policies = JSON.parse(readFileSync(policiesFile, 'utf-8'))
    assert(policies.maxAgentsPerUser === DEFAULT_POLICIES.maxAgentsPerUser, 'AB1: default quota')
    assert(policies.autoApproveUnderQuota === true, 'AB1: default autoApprove')

    // User store 검증
    const admin = userStore.findUser(ADMIN_USERNAME)
    assert(admin !== null, 'AB1: admin user in userStore')
    assert(admin.roles.includes('admin'), 'AB1: admin role set')
    assert(admin.mustChangePassword === true, 'AB1: mustChangePassword=true')

    rmSync(dir, { recursive: true, force: true })
  }

  // AB2. Idempotent 재진입 — 모든 상태 skip
  {
    const dir = createTmpDir()
    const userStore = createUserStore({ basePath: dir })
    await runAdminBootstrap({ userStore, presenceDir: dir, logger: silentLogger })
    const second = await runAdminBootstrap({ userStore, presenceDir: dir, logger: silentLogger })

    assert(second.createdAccount === false, 'AB2: re-run skips account creation')
    assert(second.initialPassword === null, 'AB2: re-run returns null password')
    assert(second.registeredAgent === false, 'AB2: re-run skips agent registration')
    assert(second.createdPolicies === false, 'AB2: re-run skips policies')

    rmSync(dir, { recursive: true, force: true })
  }

  // AB3. 부분 완료 재개 — account 있고 config 없으면 config 만 생성
  {
    const dir = createTmpDir()
    const userStore = createUserStore({ basePath: dir })
    // State 0 만 수동 실행 — admin 계정 생성 후 config/policies 지움
    await userStore.addUser(ADMIN_USERNAME, 'manual-password-123')

    const result = await runAdminBootstrap({ userStore, presenceDir: dir, logger: silentLogger })
    assert(result.createdAccount === false, 'AB3: account already exists → skip')
    assert(result.registeredAgent === true, 'AB3: config 없었으므로 생성')
    assert(result.createdPolicies === true, 'AB3: policies 없었으므로 생성')

    // admin-initial-password.txt 는 생성 안됨 (account skip)
    const pwdFile = join(dir, INITIAL_PASSWORD_FILENAME)
    assert(!existsSync(pwdFile), 'AB3: password file 미생성 (skip 시)')

    rmSync(dir, { recursive: true, force: true })
  }

  // AB4. 부분 완료 — config 존재 + agents[] 에 manager 없음 → append
  {
    const dir = createTmpDir()
    const userStore = createUserStore({ basePath: dir })
    await userStore.addUser(ADMIN_USERNAME, 'manual-password-123')
    // admin config 을 먼저 만들되 다른 agent 만
    const adminDir = join(dir, 'users', ADMIN_USERNAME)
    mkdirSync(adminDir, { recursive: true })
    writeFileSync(join(adminDir, 'config.json'), JSON.stringify({
      agents: [{ name: 'legacy', description: 'pre-existing', capabilities: [], archived: false }],
    }))

    const result = await runAdminBootstrap({ userStore, presenceDir: dir, logger: silentLogger })
    assert(result.registeredAgent === true, 'AB4: manager 없으면 append')

    const config = JSON.parse(readFileSync(join(adminDir, 'config.json'), 'utf-8'))
    assert(config.agents.length === 2, 'AB4: 기존 legacy + 신규 manager 모두 존재')
    assert(config.agents.some(a => a.name === 'legacy'), 'AB4: legacy agent 유지')
    assert(config.agents.some(a => a.name === ADMIN_AGENT_NAME), 'AB4: manager agent 추가')

    rmSync(dir, { recursive: true, force: true })
  }

  // AB5. Initial password 파일 권한 0600
  {
    const dir = createTmpDir()
    const userStore = createUserStore({ basePath: dir })
    await runAdminBootstrap({ userStore, presenceDir: dir, logger: silentLogger })

    const pwdFile = join(dir, INITIAL_PASSWORD_FILENAME)
    const mode = statSync(pwdFile).mode & 0o777
    assert(mode === 0o600, `AB5: password file mode 0600 (got ${mode.toString(8)})`)

    rmSync(dir, { recursive: true, force: true })
  }

  // AB6. deleteInitialPasswordFile — 존재 시 삭제, 없으면 no-op
  {
    const dir = createTmpDir()
    const userStore = createUserStore({ basePath: dir })
    await runAdminBootstrap({ userStore, presenceDir: dir, logger: silentLogger })

    const pwdFile = join(dir, INITIAL_PASSWORD_FILENAME)
    assert(existsSync(pwdFile), 'AB6: password file 존재 확인')
    deleteInitialPasswordFile(dir)
    assert(!existsSync(pwdFile), 'AB6: 삭제 후 파일 없음')
    // Double-call safe
    deleteInitialPasswordFile(dir)
    assert(!existsSync(pwdFile), 'AB6: 재호출 시에도 안전 (no-op)')

    rmSync(dir, { recursive: true, force: true })
  }

  // AB7. 검증: required deps 누락 시 throw
  {
    let thrown = null
    try {
      await runAdminBootstrap({ presenceDir: '/tmp', logger: silentLogger })
    } catch (e) { thrown = e }
    assert(thrown && /userStore and presenceDir required/.test(thrown.message), 'AB7: userStore 누락 throw')

    thrown = null
    try {
      await runAdminBootstrap({ userStore: {}, logger: silentLogger })
    } catch (e) { thrown = e }
    assert(thrown && /userStore and presenceDir required/.test(thrown.message), 'AB7: presenceDir 누락 throw')
  }

  // AB8. Atomic write — tmp 파일이 남지 않음 (정상 실행)
  {
    const dir = createTmpDir()
    const userStore = createUserStore({ basePath: dir })
    await runAdminBootstrap({ userStore, presenceDir: dir, logger: silentLogger })

    const { readdirSync } = await import('fs')
    const tmpInDir = readdirSync(dir).filter(f => f.includes('.tmp-'))
    assert(tmpInDir.length === 0, `AB8: 루트 디렉토리에 tmp 잔여 없음 (${tmpInDir.join(',')})`)
    const adminDir = join(dir, 'users', ADMIN_USERNAME)
    const tmpInAdmin = readdirSync(adminDir).filter(f => f.includes('.tmp-'))
    assert(tmpInAdmin.length === 0, `AB8: admin 디렉토리에 tmp 잔여 없음 (${tmpInAdmin.join(',')})`)

    rmSync(dir, { recursive: true, force: true })
  }

  // AB9. ADMIN_AGENT_ID 상수 형식
  {
    assert(ADMIN_AGENT_ID === 'admin/manager', `AB9: ADMIN_AGENT_ID = admin/manager (got ${ADMIN_AGENT_ID})`)
  }

  summary()
}

run()
