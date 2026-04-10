import { TurnState, TurnOutcome, TurnError, ERROR_KIND } from '@presence/core/core/policies.js'

export default {
  name: 'error-state',
  description:
    '에이전트가 에러 상태에 들어갔을 때 유저가 원인을 파악할 수 있는 경로를 검증한다. ' +
    'FP-01(StatusBar의 ✗ error만으로 원인 불명), FP-08(/status 출력의 내부 필드명 노출)을 재현한다.',
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
      label: 'working 진입',
      action: async (ctx) => {
        await ctx.setState('turnState', TurnState.working('복잡한 질문'))
        await ctx.wait(100)
      },
      assert: (frame) => frame.includes('thinking'),
    },
    {
      label: '에이전트 턴 실패 — planner_parse 에러',
      action: async (ctx) => {
        await ctx.setState(
          'lastTurn',
          TurnOutcome.failure('복잡한 질문', TurnError('invalid JSON in plan output', ERROR_KIND.PLANNER_PARSE), 'parse error response'),
        )
        await ctx.setState('turnState', TurnState.idle())
        await ctx.wait(150)
      },
      assert: (frame) => /error|✗/.test(frame),
    },
    {
      label: 'StatusBar 에러 프레임 — 원인이 표시되는가? — FP-01',
      action: async (ctx) => { await ctx.wait(50) },
      assert: (frame) => /planner_parse|JSON|parse/.test(frame),
    },
    {
      label: '/status 커맨드로 에러 조회',
      action: async (ctx) => {
        await ctx.type('/status')
        await ctx.press('enter')
        await ctx.wait(150)
      },
    },
    {
      label: '/status 출력 — 내부 필드명 노출 여부 — FP-08',
      action: async (ctx) => { await ctx.wait(50) },
      assert: (frame) => {
        // FP-08: 'last: failure' 같은 내부 태그가 그대로 보이면 재현 성공
        // 한국어 "마지막 결과: 실패" 로 번역되어 있으면 개선 완료
        return !/last:\s*failure|mem:\s*\d+|last:\s*none/.test(frame)
      },
    },
  ],
}
