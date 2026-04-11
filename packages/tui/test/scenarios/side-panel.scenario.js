export default {
  name: 'side-panel',
  description:
    'SidePanel을 열어 Agents/Tools/Memory/TODOs/Events 5개 섹션의 가시성을 검증한다. ' +
    'FP-06(deadLetter 미표시), FP-07(TODO 상태 없음), FP-11(도구 목록 잘림)을 재현한다.',
  timeout: 3000,
  setup: {
    app: {
      agentName: 'TestBot',
      model: 'mock-model',
      tools: Array.from({ length: 12 }, (_, i) => ({ name: `tool_${String(i + 1).padStart(2, '0')}` })),
      agents: [
        { id: 'writer', name: 'Writer' },
        { id: 'coder', name: 'Coder' },
      ],
    },
    session: { initialSessionId: 'testuser-default' },
    initialState: {
      turnState: { tag: 'idle' },
      lastTurn: null,
      turn: 0,
      context: { memories: new Array(7).fill({}), conversationHistory: [] },
      todos: [
        { id: 't1', title: '보고서 작성', status: 'ready' },
        { id: 't2', title: '이메일 확인', status: 'done' },
        { id: 't3', title: '회의 준비', status: 'blocked' },
      ],
      events: {
        queue: [{ id: 'e1' }, { id: 'e2' }],
        deadLetter: [{ id: 'dead1', reason: 'processing failed' }, { id: 'dead2', reason: 'timeout' }],
      },
      delegates: { pending: [] },
      _toolResults: [],
    },
  },
  steps: [
    {
      label: '초기 화면 — 패널 닫힘',
      action: async (ctx) => { await ctx.mount() },
      assert: (frame) => frame.includes('idle') && !frame.includes('Agents'),
    },
    {
      label: '/panel 로 사이드 패널 열기',
      action: async (ctx) => {
        await ctx.type('/panel')
        await ctx.press('enter')
        await ctx.wait(150)
      },
      assert: (frame) => frame.includes('에이전트') && frame.includes('도구'),
    },
    {
      label: '패널 펼침 — 모든 섹션이 보이는가',
      action: async (ctx) => { await ctx.wait(50) },
      assert: (frame) =>
        frame.includes('에이전트') &&
        frame.includes('도구') &&
        frame.includes('메모리') &&
        frame.includes('할 일') &&
        frame.includes('이벤트'),
    },
    {
      label: '도구 12개 중 잘림 표시 — FP-11',
      action: async (ctx) => { await ctx.wait(30) },
      assert: (frame) => /\+\d+개 더보기/.test(frame),
    },
    {
      label: 'TODO 상태 표시 — FP-07',
      action: async (ctx) => { await ctx.wait(30) },
      assert: (frame) => /done|✓|완료|blocked/.test(frame),
    },
    {
      label: 'deadLetter 노출 — FP-06',
      action: async (ctx) => { await ctx.wait(30) },
      assert: (frame) => /dead|실패|failed|2\s*(개|dead|fail)/i.test(frame),
    },
  ],
}
