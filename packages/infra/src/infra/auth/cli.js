#!/usr/bin/env node

import { createUserStore } from './user-store.js'
import { ensureSecret } from './token.js'
import { removeUserCompletely } from './remove-user.js'
import { Config } from '../config.js'
import { loadUserMerged } from '../config-loader.js'
import { Memory } from '../memory.js'
import { getSubsystemAuditStatus } from '../authz/cedar/index.js'
import { requireFlag, promptPassword, promptLine } from './cli-utils.js'
import { dispatchAgent } from './cli-agent.js'
import { dispatchPolicy } from './cli-policy.js'
import { dispatchAdmin } from './cli-admin.js'
import { CORE_AGENT_NAMES } from '@presence/core/core/policies.js'

// Auth CLI — 사용법은 main() 의 usage 출력 참조 (init / add / remove / list / passwd / agent ...).

const parseArgs = () => {
  const args = process.argv.slice(2)
  const command = args[0]
  // `agent <action>` / `policy <action>` / `admin <action>` 2-단계 subcommand 지원. 나머지는 기존 동작 유지.
  const action = (command === 'agent' || command === 'policy' || command === 'admin') ? args[1] : null
  const flagStart = (command === 'agent' || command === 'policy' || command === 'admin') ? 2 : 1
  const flags = {}
  for (let i = flagStart; i < args.length; i++) {
    if (args[i].startsWith('--') && args[i + 1] && !args[i + 1].startsWith('--')) {
      flags[args[i].slice(2)] = args[i + 1]
      i++
    }
  }
  return { command, action, ...flags }
}

// --- Commands ---

const cmdInit = async ({ username }) => {
  const store = createUserStore()
  if (store.hasUsers()) {
    console.error('Users are already configured.')
    console.error('Use "add" to add more users, or "passwd" to change a password.')
    process.exit(1)
  }

  // Secret 생성
  ensureSecret()
  console.log('JWT secret generated.')

  // 첫 사용자 (admin): --username flag 또는 프롬프트
  const name = username || await promptLine('Admin username: ')
  if (!name) { console.error('Username is required.'); process.exit(1) }

  const password = await promptPassword('Password: ')
  const confirm = await promptPassword('Confirm password: ')
  if (password !== confirm) { console.error('Passwords do not match.'); process.exit(1) }

  const user = await store.addUser(name, password)
  console.log(`User '${user.username}' created with roles: [${user.roles.join(', ')}]`)
  console.log('\nReady. Start the server with:')
  console.log('  npm start')
}

const cmdAdd = async ({ username }) => {
  ensureSecret()
  const store = createUserStore()

  const password = await promptPassword('Password: ')
  const confirm = await promptPassword('Confirm password: ')
  if (password !== confirm) { console.error('Passwords do not match.'); process.exit(1) }

  const user = await store.addUser(username, password)
  console.log(`User '${user.username}' added with roles: [${user.roles.join(', ')}]`)
}

const cmdRemove = async ({ username }) => {
  const store = createUserStore()
  if (!store.findUser(username)) {
    console.error(`User not found: ${username}`)
    process.exit(1)
  }

  // Memory 인스턴스 부팅 — embed credentials 없으면 null 이므로 1 단계는 skip.
  let memory = null
  let config = null
  try {
    config = loadUserMerged(username)
    memory = await Memory.create(config)
  } catch (err) {
    console.warn(`Memory init skipped: ${err.message}`)
  }

  // 유저의 현재 알려진 agent 이름 집합 — core agents + config.agents.
  // Memory 는 agent 단위 격리이므로 각 agent 마다 clearAll 호출 (data-scope-alignment §9).
  // 과거 agent orphan 은 잔존 — 같은 이름 재사용 전까지 미조회 (설계 수용).
  const names = new Set(CORE_AGENT_NAMES)
  for (const agentDef of (config?.agents || [])) {
    if (agentDef?.name) names.add(agentDef.name)
  }
  const agentIds = [...names].map(name => `${username}/${name}`)

  const { memoryCount, dirRemoved } = await removeUserCompletely({
    store, memory, username, userDir: Config.userDataPath(username), agentIds,
  })

  if (memoryCount > 0) console.log(`Memory cleared: ${memoryCount} entries across ${agentIds.length} agent(s).`)
  if (dirRemoved) console.log(`Removed user directory.`)
  console.log(`User '${username}' removed.`)
}

const cmdList = () => {
  const store = createUserStore()
  const users = store.listUsers()
  if (users.length === 0) {
    console.log('No users configured.')
    return
  }
  console.log('Users:')
  for (const u of users) {
    console.log(`  ${u.username}  roles=[${u.roles.join(', ')}]  created=${u.createdAt}`)
  }
}

const cmdPasswd = async ({ username }) => {
  const store = createUserStore()

  const password = await promptPassword('New password: ')
  const confirm = await promptPassword('Confirm password: ')
  if (password !== confirm) { console.error('Passwords do not match.'); process.exit(1) }

  await store.changePassword(username, password)
  console.log(`Password changed for '${username}'. All existing sessions invalidated.`)
}

// FP-70 — admin audit log 가시성. size / 백업 개수 / 백업별 size + .gz 열람 안내.
function cmdAuditStatus() {
  const formatBytes = (bytes) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const presenceDir = Config.presenceDir()
  const status = getSubsystemAuditStatus({ presenceDir })
  const pct = status.maxBytes > 0 ? Math.round((status.currentSize / status.maxBytes) * 100) : 0
  console.log(`Audit log: ${status.logPath}`)
  console.log(`  Current size: ${formatBytes(status.currentSize)} / ${formatBytes(status.maxBytes)} (${pct}%)`)
  console.log(`  Backups: ${status.backups.length}/${status.maxBackups}`)
  if (status.backups.length > 0) {
    console.log('  Backup files:')
    for (const backup of status.backups) {
      console.log(`    ${backup.path}  (${formatBytes(backup.size)})`)
    }
    console.log('')
    console.log('  Tip: gunzip <file>.gz | jq . — 압축 백업 열람')
  }
}

// --- Main ---

const main = async () => {
  const { command, action, ...flags } = parseArgs()

  if (!command) {
    console.log('Usage:')
    console.log('  npm run user -- init [--username <name>]')
    console.log('  npm run user -- add --username <name>')
    console.log('  npm run user -- remove --username <name>')
    console.log('  npm run user -- list')
    console.log('  npm run user -- passwd --username <name>')
    console.log('')
    console.log('Agent governance:')
    console.log('  npm run user -- agent add --requester <user> --name <agent> [--persona <path>]')
    console.log('  npm run user -- agent review')
    console.log('  npm run user -- agent approve --id <reqId>')
    console.log('  npm run user -- agent deny --id <reqId> --reason "<text>"')
    console.log('')
    console.log('Audit:')
    console.log('  npm run user -- audit-status')
    console.log('')
    console.log('Admin (FP-73 — admin token 자동 저장):')
    console.log('  npm run user -- admin login [--username <name>]   (기본: admin)')
    console.log('  npm run user -- admin logout')
    console.log('  npm run user -- admin whoami')
    console.log('')
    console.log('Cedar policy:')
    console.log('  npm run user -- policy lint --file <path.cedar>')
    console.log('  npm run user -- policy list')
    console.log('  npm run user -- policy reload                      (서버 재시작 없이 정책 즉시 적용)')
    console.log('  npm run user -- policy version                     (현재 활성 정책 버전 확인)')
    console.log('  policy reload / version: \'admin login\' 후 ENV 없이 자동 동작 (또는 PRESENCE_ADMIN_TOKEN env).')
    process.exit(0)
  }

  switch (command) {
    case 'init':
      return cmdInit({ username: flags.username })
    case 'add':
      return cmdAdd({ username: requireFlag(flags, 'username') })
    case 'remove':
      return cmdRemove({ username: requireFlag(flags, 'username') })
    case 'list':
      return cmdList()
    case 'passwd':
      return cmdPasswd({ username: requireFlag(flags, 'username') })
    case 'agent':
      if (!action) {
        console.error('agent: action required (add / review / approve / deny)')
        process.exit(1)
      }
      return dispatchAgent(action, flags)
    case 'audit-status':
      return cmdAuditStatus()
    case 'policy':
      if (!action) {
        console.error('policy: action required (lint / list / reload)')
        process.exit(1)
      }
      return dispatchPolicy(action, flags)
    case 'admin':
      if (!action) {
        console.error('admin: action required (login / logout / whoami)')
        process.exit(1)
      }
      return dispatchAdmin(action, flags)
    default:
      console.error(`Unknown command: ${command}`)
      process.exit(1)
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`)
  process.exit(1)
})
