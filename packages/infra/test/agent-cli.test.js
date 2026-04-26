import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runAdminBootstrap } from '@presence/infra/infra/admin-bootstrap.js'
import { createUserStore } from '@presence/infra/infra/auth/user-store.js'
import { assert, summary } from '../../../test/lib/assert.js'

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }
const CLI = 'node packages/infra/src/infra/auth/cli.js'
const REPO_ROOT = process.cwd()

const createTmpDir = () => {
  const dir = join(tmpdir(), `presence-agent-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const runCli = (args, presenceDir) => {
  try {
    const out = execSync(`${CLI} ${args}`, {
      env: { ...process.env, PRESENCE_DIR: presenceDir },
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { code: 0, stdout: out, stderr: '' }
  } catch (err) {
    return {
      code: err.status ?? -1,
      stdout: err.stdout?.toString() || '',
      stderr: err.stderr?.toString() || '',
    }
  }
}

const writeUserConfig = (dir, username, data) => {
  const userDir = join(dir, 'users', username)
  mkdirSync(userDir, { recursive: true })
  writeFileSync(join(userDir, 'config.json'), JSON.stringify(data, null, 2))
}

const readUserConfig = (dir, username) => {
  return JSON.parse(readFileSync(join(dir, 'users', username, 'config.json'), 'utf-8'))
}

async function run() {
  console.log('Agent CLI tests')

  // AC1. agent add — autoApprove 경로
  {
    const dir = createTmpDir()
    const userStore = createUserStore({ basePath: dir })
    await runAdminBootstrap({ userStore, presenceDir: dir, logger: silentLogger })
    writeUserConfig(dir, 'anthony', { agents: [] })

    const result = runCli('agent add --requester anthony --name assistant', dir)
    assert(result.code === 0, `AC1: exit 0 (got ${result.code}, stderr: ${result.stderr})`)
    assert(/auto-approved/.test(result.stdout), 'AC1: stdout says auto-approved')

    const config = readUserConfig(dir, 'anthony')
    assert(config.agents.some(a => a.name === 'assistant'), 'AC1: config 에 agent 반영')
    rmSync(dir, { recursive: true, force: true })
  }

  // AC2. agent add — quota 초과 → pending
  {
    const dir = createTmpDir()
    const userStore = createUserStore({ basePath: dir })
    await runAdminBootstrap({ userStore, presenceDir: dir, logger: silentLogger })
    // policy override
    writeFileSync(join(dir, 'users', 'admin', 'agent-policies.json'),
      JSON.stringify({ maxAgentsPerUser: 1, autoApproveUnderQuota: true }, null, 2))
    writeUserConfig(dir, 'bob', { agents: [{ name: 'a', archived: false }] })

    const result = runCli('agent add --requester bob --name b', dir)
    assert(result.code === 0, 'AC2: exit 0')
    assert(/pending admin review/.test(result.stdout), 'AC2: stdout says pending')
    const pendingDir = join(dir, 'users', 'admin', 'pending')
    assert(existsSync(pendingDir) && readdirSync(pendingDir).length === 1, 'AC2: pending 파일 1개')
    rmSync(dir, { recursive: true, force: true })
  }

  // AC3. agent review — pending 출력
  {
    const dir = createTmpDir()
    const userStore = createUserStore({ basePath: dir })
    await runAdminBootstrap({ userStore, presenceDir: dir, logger: silentLogger })
    writeFileSync(join(dir, 'users', 'admin', 'agent-policies.json'),
      JSON.stringify({ maxAgentsPerUser: 0, autoApproveUnderQuota: true }, null, 2))
    writeUserConfig(dir, 'carol', { agents: [] })

    const add = runCli('agent add --requester carol --name x', dir)
    const reqId = (add.stdout.match(/reqId: (req-\w+)/) || [])[1]
    assert(reqId, 'AC3: reqId 추출')

    const review = runCli('agent review', dir)
    assert(review.code === 0, 'AC3: review exit 0')
    assert(review.stdout.includes(reqId), 'AC3: review 출력에 reqId')
    assert(review.stdout.includes('carol'), 'AC3: review 출력에 requester')
    assert(review.stdout.includes('quota-exceeded'), 'AC3: review 출력에 reason')
    rmSync(dir, { recursive: true, force: true })
  }

  // AC4. agent approve
  {
    const dir = createTmpDir()
    const userStore = createUserStore({ basePath: dir })
    await runAdminBootstrap({ userStore, presenceDir: dir, logger: silentLogger })
    writeFileSync(join(dir, 'users', 'admin', 'agent-policies.json'),
      JSON.stringify({ maxAgentsPerUser: 0, autoApproveUnderQuota: true }, null, 2))
    writeUserConfig(dir, 'dave', { agents: [] })

    const add = runCli('agent add --requester dave --name report', dir)
    const reqId = (add.stdout.match(/reqId: (req-\w+)/) || [])[1]

    const approve = runCli(`agent approve --id ${reqId}`, dir)
    assert(approve.code === 0, 'AC4: approve exit 0')
    assert(/approved\./.test(approve.stdout), 'AC4: approve stdout')

    const config = readUserConfig(dir, 'dave')
    assert(config.agents.some(a => a.name === 'report'), 'AC4: config 에 report agent')
    // pending → approved 이동 확인
    assert(readdirSync(join(dir, 'users', 'admin', 'pending')).length === 0, 'AC4: pending 비어있음')

    // AC4b — governance-cedar v2.1 GC3: manual_approve audit 기록
    const auditPath = join(dir, 'logs', 'authz-audit.log')
    assert(existsSync(auditPath), 'AC4b: audit log 파일 생성')
    const auditLines = readFileSync(auditPath, 'utf-8').split('\n').filter(l => l.length > 0)
    const approveEntries = auditLines.map(l => JSON.parse(l)).filter(e => e.action === 'manual_approve')
    assert(approveEntries.length === 1, `AC4b: manual_approve 1건 (got ${approveEntries.length})`)
    const ent = approveEntries[0]
    assert(ent.caller === 'admin' && ent.resource === 'dave', 'AC4b: caller=admin / resource=dave')
    assert(ent.decision === 'allow' && ent.reqId === reqId, 'AC4b: decision=allow + reqId 동봉')
    assert(ent.agentName === 'report' && ent.idempotent === false, 'AC4b: agentName + idempotent=false')
    rmSync(dir, { recursive: true, force: true })
  }

  // AC5. agent deny
  {
    const dir = createTmpDir()
    const userStore = createUserStore({ basePath: dir })
    await runAdminBootstrap({ userStore, presenceDir: dir, logger: silentLogger })
    writeFileSync(join(dir, 'users', 'admin', 'agent-policies.json'),
      JSON.stringify({ maxAgentsPerUser: 0, autoApproveUnderQuota: true }, null, 2))
    writeUserConfig(dir, 'eve', { agents: [] })

    const add = runCli('agent add --requester eve --name spam', dir)
    const reqId = (add.stdout.match(/reqId: (req-\w+)/) || [])[1]

    const deny = runCli(`agent deny --id ${reqId} --reason "too-many"`, dir)
    assert(deny.code === 0, 'AC5: deny exit 0')
    assert(/denied/.test(deny.stdout), 'AC5: deny stdout')

    const config = readUserConfig(dir, 'eve')
    assert(!(config.agents || []).some(a => a.name === 'spam'), 'AC5: config 에 추가 안됨')
    assert(readdirSync(join(dir, 'users', 'admin', 'rejected')).length === 1, 'AC5: rejected 1 개')
    rmSync(dir, { recursive: true, force: true })
  }

  // AC6. agent approve — 미존재 reqId → 비 0 종료
  {
    const dir = createTmpDir()
    const userStore = createUserStore({ basePath: dir })
    await runAdminBootstrap({ userStore, presenceDir: dir, logger: silentLogger })

    const approve = runCli('agent approve --id req-ghost', dir)
    assert(approve.code !== 0, 'AC6: 미존재 reqId → exit 비 0')
    assert(/not found/.test(approve.stderr), 'AC6: stderr 에 not found')
    rmSync(dir, { recursive: true, force: true })
  }

  // AC7. agent add — 중복 (already exists) → 비 0 종료
  {
    const dir = createTmpDir()
    const userStore = createUserStore({ basePath: dir })
    await runAdminBootstrap({ userStore, presenceDir: dir, logger: silentLogger })
    writeUserConfig(dir, 'frank', { agents: [{ name: 'existing', archived: false }] })

    const result = runCli('agent add --requester frank --name existing', dir)
    assert(result.code !== 0, 'AC7: 중복 → exit 비 0')
    assert(/already exists/.test(result.stderr), 'AC7: stderr 에 already exists')
    rmSync(dir, { recursive: true, force: true })
  }

  // AC8. Unknown action
  {
    const dir = createTmpDir()
    const userStore = createUserStore({ basePath: dir })
    await runAdminBootstrap({ userStore, presenceDir: dir, logger: silentLogger })

    const result = runCli('agent bogus', dir)
    assert(result.code !== 0, 'AC8: unknown action → exit 비 0')
    assert(/Unknown agent action/.test(result.stderr), 'AC8: stderr 에 메시지')
    rmSync(dir, { recursive: true, force: true })
  }

  summary()
}

run()
