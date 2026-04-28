/**
 * TUI E2E 공통 setup — tui-e2e-{basic,slash,input,regression}.test.js 가 공유.
 *
 * setupTuiE2E(mockHandler) → { port, remoteState, lastFrame, stdin, post, get, tools, llmCalls, cleanup }
 * typeInput(stdin, text) — 한 글자씩 입력 후 Enter
 * connectMirrorState(wsUrl, sessionId, token) — MirrorState WS 연결 대기
 */

import React from 'react'
import { render } from 'ink-testing-library'
import { createMirrorState } from '@presence/infra/infra/states/mirror-state.js'
import { App } from '@presence/tui/ui/App.js'
import { createTestServer, request, delay } from '../lib/mock-server.js'

const h = React.createElement

export const typeInput = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch)
    await delay(10)
  }
  stdin.write('\r')
  await delay(20)
}

export const connectMirrorState = (wsUrl, sessionId, token) => new Promise((resolve) => {
  const rs = createMirrorState({
    wsUrl,
    sessionId,
    headers: { Authorization: `Bearer ${token}` },
  })
  const check = () => {
    if (rs.get('turnState') !== undefined) { resolve(rs); return }
    setTimeout(check, 20)
  }
  setTimeout(check, 20)
})

export const setupTuiE2E = async (mockHandler) => {
  const ctx = await createTestServer(mockHandler)
  const { port, token, defaultSessionId: sid, mockLLM, shutdown } = ctx

  const remoteState = await connectMirrorState(`ws://127.0.0.1:${port}`, sid, token)

  const post = (path, body) => request(port, 'POST', path, body, { token })
  const get = (path) => request(port, 'GET', path, null, { token })

  const toolsRes = await get(`/api/sessions/${sid}/tools`)
  const tools = Array.isArray(toolsRes.body) ? toolsRes.body : []

  const onInput = (input) =>
    post(`/api/sessions/${sid}/chat`, { input }).then(res => res.body?.content ?? null)

  const onApprove = (approved) => post(`/api/sessions/${sid}/approve`, { approved })
  const onCancel = () => post(`/api/sessions/${sid}/cancel`)

  const { lastFrame, stdin, unmount } = render(h(App, {
    state: remoteState,
    onInput,
    onApprove,
    onCancel,
    tools,
    agents: [],
    cwd: process.cwd(),
    gitBranch: '',
    model: 'test',
    config: {},
    memory: null,
    llm: null,
    toolRegistry: null,
    initialMessages: [],
  }))

  const cleanup = async () => {
    unmount()
    remoteState.disconnect()
    await shutdown()
  }

  return { port, remoteState, lastFrame, stdin, post, get, tools, llmCalls: mockLLM.calls, cleanup }
}
