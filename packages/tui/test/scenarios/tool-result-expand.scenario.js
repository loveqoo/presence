const LONG_FILE_CONTENT = Array.from({ length: 120 }, (_, i) => `line ${String(i + 1).padStart(3, '0')}: sample content`).join('\n')

export default {
  name: 'tool-result-expand',
  description:
    '도구 결과가 접힌 상태에서 펼치는 경험을 검증한다. ' +
    'FP-10(접힌 상태 가시성 없음), FP-04(Ctrl+O 키바인딩 미노출), FP-13(CodeView 80줄 제한)을 재현한다.',
  timeout: 3000,
  setup: {
    app: { agentName: 'TestBot', model: 'mock-model' },
    session: { initialSessionId: 'testuser-default' },
  },
  steps: [
    {
      label: '초기 idle 화면',
      action: async (ctx) => { await ctx.mount() },
      assert: (frame) => frame.includes('idle'),
    },
    {
      label: '도구 결과 1개 주입 — 120줄 file_read',
      action: async (ctx) => {
        await ctx.setState('_toolResults', [
          { tool: 'file_read', args: { path: '/tmp/long.log' }, result: LONG_FILE_CONTENT },
        ])
        await ctx.wait(100)
      },
      assert: (frame) => frame.includes('file_read') && frame.includes('120'),
    },
    {
      label: '접힌 상태 — 펼침 키 안내가 보이는가?',
      action: async (ctx) => { await ctx.wait(50) },
      assert: (frame) => /Ctrl\+O|\^O|펼치기/.test(frame),
    },
    {
      label: 'Ctrl+O로 펼치기',
      action: async (ctx) => {
        await ctx.press('ctrl-o')
        await ctx.wait(100)
      },
    },
    {
      label: '펼친 상태 — 내용이 보이고 80줄 제한 표시가 있는가?',
      action: async (ctx) => { await ctx.wait(50) },
      assert: (frame) => frame.includes('line 001') && /\+\d+ lines|more|\.\.\./.test(frame),
    },
    {
      label: 'Ctrl+O로 다시 접기',
      action: async (ctx) => {
        await ctx.press('ctrl-o')
        await ctx.wait(100)
      },
    },
    {
      label: '접힌 상태 복귀 프레임',
      action: async (ctx) => { await ctx.wait(50) },
    },
  ],
}
