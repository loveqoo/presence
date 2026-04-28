/**
 * TUI E2E — slash commands (TE8-15).
 *  TE8.  /help — i18n 번역 내용 표시
 *  TE9.  /clear
 *  TE10. /tools
 *  TE11. /mcp list
 *  TE12. /memory
 *  TE13. /todos
 *  TE14. /session
 *  TE15. /models
 */

import { delay, waitFor } from '../lib/mock-server.js'
import { assert, summary } from '../lib/assert.js'
import { setupTuiE2E, typeInput } from './tui-e2e-helpers.js'

async function run() {
  console.log('TUI E2E — slash commands (TE8-15)')

  // TE8. /help — i18n 번역 내용 표시
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '응답' })
    )
    try {
      await delay(100)
      await typeInput(stdin, '/help')
      await waitFor(() => lastFrame().includes('/clear'), { timeout: 3000 })
      assert(lastFrame().includes('/clear'), 'TE8: /help에 /clear 커맨드 포함')
      assert(!lastFrame().includes('help.commands'), 'TE8: i18n 키가 아닌 번역 내용 표시')
    } finally {
      await cleanup()
    }
  }

  // TE9. /clear
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '안녕!' })
    )
    try {
      await delay(100)
      await typeInput(stdin, '안녕하세요')
      await waitFor(() => lastFrame().includes('안녕!'), { timeout: 10000 })
      await typeInput(stdin, '/clear')
      await waitFor(() => !lastFrame().includes('안녕!'), { timeout: 3000 })
      assert(!lastFrame().includes('안녕!'), 'TE9: /clear 후 메시지 초기화')
      assert(lastFrame().includes('idle'), 'TE9: /clear 후 idle 유지')
    } finally {
      await cleanup()
    }
  }

  // TE10. /tools
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '응답' })
    )
    try {
      await delay(100)
      await typeInput(stdin, '/tool list')
      await waitFor(() => lastFrame().includes('file_'), { timeout: 3000 })
      assert(lastFrame().includes('file_'), 'TE10: /tools에 도구 목록 표시')
    } finally {
      await cleanup()
    }
  }

  // TE11. /mcp list
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '응답' })
    )
    try {
      await delay(100)
      await typeInput(stdin, '/mcp list')
      await waitFor(() => lastFrame().includes('MCP') || lastFrame().includes('mcp'), { timeout: 3000 })
      assert(lastFrame().includes('MCP') || lastFrame().includes('No'), 'TE11: /mcp list 결과 표시')
    } finally {
      await cleanup()
    }
  }

  // TE12. /memory
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '응답' })
    )
    try {
      await delay(100)
      await typeInput(stdin, '/memory')
      await waitFor(
        () => lastFrame().includes('메모리') || lastFrame().includes('memory'),
        { timeout: 3000 }
      )
      assert(
        lastFrame().includes('메모리') || lastFrame().includes('memory'),
        'TE12: /memory 결과 표시'
      )
    } finally {
      await cleanup()
    }
  }

  // TE13. /todos
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '응답' })
    )
    try {
      await delay(100)
      await typeInput(stdin, '/todo list')
      await waitFor(() => lastFrame().includes('todos'), { timeout: 3000 })
      assert(lastFrame().includes('todos'), 'TE13: /todos 결과 표시')
    } finally {
      await cleanup()
    }
  }

  // TE14. /session
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '응답' })
    )
    try {
      await delay(100)
      await typeInput(stdin, '/session')
      await waitFor(
        () => lastFrame().includes('세션') || lastFrame().includes('session'),
        { timeout: 3000 }
      )
      assert(
        lastFrame().includes('세션') || lastFrame().includes('session'),
        'TE14: /session 결과 표시'
      )
    } finally {
      await cleanup()
    }
  }

  // TE15. /models
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '응답' })
    )
    try {
      await delay(100)
      await typeInput(stdin, '/models')
      await waitFor(
        () => lastFrame().includes('LLM') || lastFrame().includes('사용할 수 없'),
        { timeout: 3000 }
      )
      assert(
        lastFrame().includes('LLM') || lastFrame().includes('사용할 수 없'),
        'TE15: /models 미사용 메시지 표시'
      )
    } finally {
      await cleanup()
    }
  }

  summary()
}

run()
