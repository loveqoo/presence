#!/usr/bin/env node

// CLI 진입점 — 서버 단독 실행
import { createUserStore } from '@presence/infra/infra/auth/user-store.js'
import { loadServer } from '@presence/infra/infra/config-loader.js'
import { startServer } from './index.js'

const port = Number(process.env.PORT) || 3000
const host = process.env.HOST || '127.0.0.1'

const userStore = createUserStore()
if (!userStore.hasUsers()) {
  console.error('No users configured.')
  console.error('Run: npm run user -- init')
  process.exit(1)
}

const config = loadServer()
console.log(`Starting Presence server on ${host}:${port}...`)
startServer(config, { port, host }).catch(err => {
  console.error(`\nFailed to start server: ${err.message}`)
  if (err.code === 'EADDRINUSE') console.error(`  Port ${port} is already in use. Set a different port with PORT=<n>`)
  else if (err.code === 'EACCES') console.error(`  Permission denied. Try a port above 1024.`)
  process.exit(1)
})
