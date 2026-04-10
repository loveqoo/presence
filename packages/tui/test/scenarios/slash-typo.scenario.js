export default {
  name: 'slash-typo',
  description:
    '등록되지 않은 슬래시 커맨드 입력을 검증한다. ' +
    'FP-7(알 수 없는 /command가 에이전트 턴으로 그대로 전달됨)을 재현한다. ' +
    'session.md E12에 Known Gap으로 명시된 사안.',
  timeout: 3000,
  setup: {
    app: {
      agentName: 'TestBot',
      model: 'mock-model',
      // onInput은 호출되면 안 되는 경로. 호출 여부를 기록만 한다.
      onInput: async (input) => {
        globalThis.__slashTypoRouted = (globalThis.__slashTypoRouted || [])
        globalThis.__slashTypoRouted.push(input)
        return `(fake echo) ${input}`
      },
    },
    session: { initialSessionId: 'testuser-default' },
  },
  steps: [
    {
      label: '초기 화면 — routed 버퍼 초기화',
      action: async (ctx) => {
        globalThis.__slashTypoRouted = []
        await ctx.mount()
      },
      assert: (frame) => frame.includes('idle'),
    },
    {
      label: '알 수 없는 슬래시 커맨드 입력 — /mem (실제는 /memory)',
      action: async (ctx) => {
        await ctx.type('/mem')
        await ctx.press('enter')
        await ctx.wait(150)
      },
    },
    {
      label: '입력 후 화면 — "알 수 없는 커맨드" 안내가 표시되는가 (기대: 실패 = FP-7 재현)',
      action: async (ctx) => { await ctx.wait(100) },
      assert: (frame) => /알 수 없는 커맨드|unknown command/i.test(frame),
    },
    {
      label: '또 다른 오타 /model (실제는 /models)',
      action: async (ctx) => {
        await ctx.type('/model')
        await ctx.press('enter')
        await ctx.wait(150)
      },
    },
    {
      label: '오타가 에이전트 onInput까지 도달했는지 확인 (기대: 도달 = FP-7 재현)',
      action: async (ctx) => { await ctx.wait(50) },
      assert: () => {
        // 도달했으면 __slashTypoRouted에 '/mem' 또는 '/model'이 있음.
        // 도달하지 않아야 정상(graceful block) — 그래서 빈 배열을 기대.
        return (globalThis.__slashTypoRouted?.length ?? 0) === 0
      },
    },
  ],
}
