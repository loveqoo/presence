#!/usr/bin/env node

import { createInterface } from 'node:readline'
import { createUserStore } from './auth-user-store.js'
import { ensureSecret } from './auth-token.js'

// =============================================================================
// Auth CLI: 사용자 관리 도구
//
// 사용법:
//   npm run user -- init --instance <id>
//   npm run user -- add --instance <id> --username <name>
//   npm run user -- remove --instance <id> --username <name>
//   npm run user -- list --instance <id>
//   npm run user -- passwd --instance <id> --username <name>
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

const cmdInit = async ({ instance }) => {
  const store = createUserStore(instance)
  if (store.hasUsers()) {
    console.error(`Instance '${instance}' already has users configured.`)
    console.error('Use "add" to add more users, or "passwd" to change a password.')
    process.exit(1)
  }

  console.log(`Initializing instance: ${instance}`)

  // Secret 생성
  ensureSecret(instance)
  console.log('  JWT secret generated.')

  // 첫 사용자 (admin)
  const username = await promptLine('Admin username: ')
  if (!username) { console.error('Username is required.'); process.exit(1) }

  const password = await promptPassword('Password: ')
  const confirm = await promptPassword('Confirm password: ')
  if (password !== confirm) { console.error('Passwords do not match.'); process.exit(1) }

  const user = await store.addUser(username, password)
  console.log(`  User '${user.username}' created with roles: [${user.roles.join(', ')}]`)
  console.log(`\nInstance '${instance}' is ready. Start the server with:`)
  console.log(`  npm start`)
}

const cmdAdd = async ({ instance, username }) => {
  ensureSecret(instance)
  const store = createUserStore(instance)

  const password = await promptPassword('Password: ')
  const confirm = await promptPassword('Confirm password: ')
  if (password !== confirm) { console.error('Passwords do not match.'); process.exit(1) }

  const user = await store.addUser(username, password)
  console.log(`User '${user.username}' added with roles: [${user.roles.join(', ')}]`)
}

const cmdRemove = ({ instance, username }) => {
  const store = createUserStore(instance)
  store.removeUser(username)
  console.log(`User '${username}' removed from instance '${instance}'.`)
}

const cmdList = ({ instance }) => {
  const store = createUserStore(instance)
  const users = store.listUsers()
  if (users.length === 0) {
    console.log(`No users configured for instance '${instance}'.`)
    return
  }
  console.log(`Users for instance '${instance}':`)
  for (const u of users) {
    console.log(`  ${u.username}  roles=[${u.roles.join(', ')}]  created=${u.createdAt}`)
  }
}

const cmdPasswd = async ({ instance, username }) => {
  const store = createUserStore(instance)

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
    console.log('  npm run user -- init --instance <id>')
    console.log('  npm run user -- add --instance <id> --username <name>')
    console.log('  npm run user -- remove --instance <id> --username <name>')
    console.log('  npm run user -- list --instance <id>')
    console.log('  npm run user -- passwd --instance <id> --username <name>')
    process.exit(0)
  }

  const instance = requireFlag(flags, 'instance')

  switch (command) {
    case 'init':
      return cmdInit({ instance })
    case 'add':
      return cmdAdd({ instance, username: requireFlag(flags, 'username') })
    case 'remove':
      return cmdRemove({ instance, username: requireFlag(flags, 'username') })
    case 'list':
      return cmdList({ instance })
    case 'passwd':
      return cmdPasswd({ instance, username: requireFlag(flags, 'username') })
    default:
      console.error(`Unknown command: ${command}`)
      process.exit(1)
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`)
  process.exit(1)
})
