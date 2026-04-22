#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { createUserStore } from './user-store.js'
import { ensureSecret } from './token.js'
import { removeUserCompletely } from './remove-user.js'
import { Config } from '../config.js'
import { loadUserMerged } from '../config-loader.js'
import { Memory } from '../memory.js'
import {
  STATUS as GV_STATUS,
  submitUserAgent,
  approveUserAgent,
  denyUserAgent,
  listPending,
  loadAgentPolicies,
} from '../authz/agent-governance.js'

// =============================================================================
// Auth CLI: 사용자 관리 도구
//
// 사용법:
//   npm run user -- init --username <name>
//   npm run user -- add --username <name>
//   npm run user -- remove --username <name>
//   npm run user -- list
//   npm run user -- passwd --username <name>
// =============================================================================

const promptPassword = (prompt = 'Password: ') => new Promise((resolve) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const origWrite = rl._writeToOutput
  rl._writeToOutput = (s) => {
    if (s.includes(prompt)) origWrite.call(rl, s)
    else origWrite.call(rl, '*')
  }
  rl.question(prompt, (answer) => {
    rl._writeToOutput = origWrite
    rl.close()
    console.log() // 줄바꿈
    resolve(answer)
  })
})

const promptLine = (prompt) => new Promise((resolve) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()) })
})

const parseArgs = () => {
  const args = process.argv.slice(2)
  const command = args[0]
  // `agent <action>` 2-단계 subcommand 지원. 나머지는 기존 동작 유지.
  const action = command === 'agent' ? args[1] : null
  const flagStart = command === 'agent' ? 2 : 1
  const flags = {}
  for (let i = flagStart; i < args.length; i++) {
    if (args[i].startsWith('--') && args[i + 1] && !args[i + 1].startsWith('--')) {
      flags[args[i].slice(2)] = args[i + 1]
      i++
    }
  }
  return { command, action, ...flags }
}

const requireFlag = (flags, name) => {
  if (!flags[name]) {
    console.error(`--${name} is required`)
    process.exit(1)
  }
  return flags[name]
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
  try {
    const config = loadUserMerged(username)
    memory = await Memory.create(config)
  } catch (err) {
    console.warn(`Memory init skipped: ${err.message}`)
  }

  const { memoryCount, dirRemoved } = await removeUserCompletely({
    store, memory, username, userDir: Config.userDataPath(username),
  })

  if (memoryCount > 0) console.log(`Memory cleared: ${memoryCount} entries.`)
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

// --- Agent subcommands ---

const loadPersonaFromFile = (filePath) => {
  if (!filePath) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch (err) {
    console.error(`Failed to read persona file: ${err.message}`)
    process.exit(1)
  }
}

const defaultPersona = () => ({
  name: 'Presence',
  systemPrompt: null,
  rules: [],
  tools: [],
})

async function cmdAgentAdd(params) {
  const presenceDir = Config.presenceDir()
  const persona = params.personaPath ? loadPersonaFromFile(params.personaPath) : defaultPersona()
  const result = submitUserAgent({
    requester: params.requester, agentName: params.name, persona,
    basePath: presenceDir, presenceDir,
  })
  switch (result.status) {
    case GV_STATUS.APPROVED:
      console.log(`Agent '${params.requester}/${params.name}' auto-approved. ${result.detail || ''}`)
      return
    case GV_STATUS.PENDING:
      console.log(`Agent '${params.requester}/${params.name}' pending admin review.`)
      console.log(`  reqId: ${result.reqId}`)
      console.log(`  Admin can approve:  npm run user -- agent approve --id ${result.reqId}`)
      return
    case GV_STATUS.ALREADY_EXISTS:
      console.error(`Agent '${params.requester}/${params.name}' already exists.`)
      process.exit(1)
      return
  }
}

function cmdAgentReview() {
  const presenceDir = Config.presenceDir()
  const pending = listPending(presenceDir)
  if (pending.length === 0) {
    console.log('No pending agent requests.')
    return
  }
  const policies = loadAgentPolicies(presenceDir)
  console.log(`Pending requests (${pending.length}):`)
  console.log(`  policy: maxAgentsPerUser=${policies.maxAgentsPerUser}, autoApproveUnderQuota=${policies.autoApproveUnderQuota}`)
  for (const req of pending) {
    console.log('')
    console.log(`  [${req.id}]`)
    console.log(`    requester: ${req.requester}`)
    console.log(`    agentName: ${req.agentName}`)
    console.log(`    submitted: ${req.submittedAt}`)
    console.log(`    reason:    ${req.reason} (current ${req.currentCount}/${req.maxAgentsPerUser})`)
  }
  console.log('')
  console.log('Approve: npm run user -- agent approve --id <reqId>')
  console.log('Deny:    npm run user -- agent deny --id <reqId> --reason "<text>"')
}

function cmdAgentApprove(params) {
  const presenceDir = Config.presenceDir()
  const result = approveUserAgent(params.id, { presenceDir, basePath: presenceDir })
  switch (result.status) {
    case GV_STATUS.APPROVED:
      console.log(`Request ${params.id} approved.`)
      return
    case GV_STATUS.ALREADY_APPLIED:
      console.log(`Request ${params.id} already applied (idempotent replay, file cleaned).`)
      return
    case GV_STATUS.NOT_FOUND:
      console.error(`Request ${params.id} not found in pending.`)
      process.exit(1)
      return
  }
}

function cmdAgentDeny(params) {
  const presenceDir = Config.presenceDir()
  const reason = params.reason || 'denied by admin'
  const result = denyUserAgent(params.id, reason, { presenceDir })
  switch (result.status) {
    case GV_STATUS.REJECTED:
      console.log(`Request ${params.id} denied. Reason: ${reason}`)
      return
    case GV_STATUS.NOT_FOUND:
      console.error(`Request ${params.id} not found in pending.`)
      process.exit(1)
      return
  }
}

const dispatchAgent = (action, flags) => {
  switch (action) {
    case 'add':
      return cmdAgentAdd({
        requester: requireFlag(flags, 'requester'),
        name: requireFlag(flags, 'name'),
        personaPath: flags.persona,
      })
    case 'review':
      return cmdAgentReview()
    case 'approve':
      return cmdAgentApprove({ id: requireFlag(flags, 'id') })
    case 'deny':
      return cmdAgentDeny({ id: requireFlag(flags, 'id'), reason: flags.reason })
    default:
      console.error(`Unknown agent action: ${action}`)
      console.error('Actions: add, review, approve, deny')
      process.exit(1)
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
    default:
      console.error(`Unknown command: ${command}`)
      process.exit(1)
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`)
  process.exit(1)
})
