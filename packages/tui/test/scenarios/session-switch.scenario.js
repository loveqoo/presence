export default {
  name: 'session-switch',
  description:
    '멀티세션을 생성하고 전환할 때, 현재 세션이 StatusBar 또는 화면 어딘가에 표시되는지 확인한다. ' +
    '현재는 StatusBar에 session 항목이 없으므로 전환 후에도 화면에 세션명이 나타나지 않을 것으로 예상된다. ' +
    '이 시나리오는 해당 UX 공백을 재현하기 위한 것이다.',
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
        // 가설: StatusBar에 'work' 세션명이 나타나지 않음. 이 assert가 실패하면 UX 공백 재현 성공.
        // StatusBar 영역(첫 줄)에만 한정해서 확인한다.
        const firstLine = frame.split('\n')[0] ?? ''
        return firstLine.includes('work')
      },
    },
  ],
}
