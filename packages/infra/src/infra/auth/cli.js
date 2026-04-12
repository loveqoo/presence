#!/usr/bin/env node

import { createInterface } from 'node:readline'
import { createUserStore } from './user-store.js'
import { ensureSecret } from './token.js'
import { removeUserCompletely } from './remove-user.js'
import { Config } from '../config.js'
import { loadUserMerged } from '../config-loader.js'
import { Memory } from '../memory.js'

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
  const flags = {}
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--') && args[i + 1] && !args[i + 1].startsWith('--')) {
      flags[args[i].slice(2)] = args[i + 1]
      i++
    }
  }
  return { command, ...flags }
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

// --- Main ---

const main = async () => {
  const { command, ...flags } = parseArgs()

  if (!command) {
    console.log('Usage:')
    console.log('  npm run user -- init [--username <name>]')
    console.log('  npm run user -- add --username <name>')
    console.log('  npm run user -- remove --username <name>')
    console.log('  npm run user -- list')
    console.log('  npm run user -- passwd --username <name>')
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
    default:
      console.error(`Unknown command: ${command}`)
      process.exit(1)
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`)
  process.exit(1)
})
