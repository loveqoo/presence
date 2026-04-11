export default {
  name: 'session-switch',
  description:
    '멀티세션을 생성하고 전환할 때, 현재 세션이 StatusBar에 표시되는지 확인한다. ' +
    'FP-14 수정 이후 StatusBar 기본 항목에 session이 포함되어 전환 후 세션명이 즉시 보여야 한다.',
  timeout: 3000,
  setup: {
    app: {
      agentName: 'TestBot',
      model: 'mock-model',
    },
    session: {
      initialSessionId: 'testuser-default',
    },
  },
  steps: [
    {
      label: '초기 화면',
      action: async (ctx) => { await ctx.mount() },
      assert: (frame) => frame.includes('idle'),
    },
    {
      label: '세션 목록 조회',
      action: async (ctx) => {
        await ctx.type('/sessions list')
        await ctx.press('enter')
        await ctx.wait(150)
      },
    },
    {
      label: '새 세션 work 생성',
      action: async (ctx) => {
        await ctx.type('/sessions new work')
        await ctx.press('enter')
        await ctx.wait(150)
      },
    },
    {
      label: '세션 work로 전환 요청',
      action: async (ctx) => {
        await ctx.type('/sessions switch work')
        await ctx.press('enter')
        await ctx.wait(250)
      },
    },
    {
      label: '전환 후 화면 — 현재 세션 가시성',
      action: async (ctx) => { await ctx.wait(100) },
      assert: (frame) => {
        // StatusBar는 렌더 트리 마지막 줄. 'session: work' 표기가 보여야 한다.
        const lines = frame.split('\n').filter(l => l.trim().length > 0)
        const statusLine = lines[lines.length - 1] ?? ''
        return statusLine.includes('session: work')
      },
    },
  ],
}
