import { TurnState, TurnOutcome } from '@presence/core/core/policies.js'

export default {
  name: 'streaming-response',
  description:
    '에이전트 응답 스트리밍 경험을 검증한다. ' +
    'FP-29(입력 비활성 상태 이유 미표시), FP-30("receiving N chars..." 내부 용어 노출)을 재현한다.',
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
      label: 'working 전이 — thinking 표시',
      action: async (ctx) => {
        await ctx.setState('turnState', TurnState.working('오늘 날씨 알려줘'))
        await ctx.wait(100)
      },
      assert: (frame) => frame.includes('thinking'),
    },
    {
      label: '스트리밍 시작 — content 도착 전 receiving 단계',
      action: async (ctx) => {
        await ctx.setState('_streaming', { status: 'receiving', length: 42, content: '' })
        await ctx.wait(100)
      },
      assert: (frame) => /receiving/.test(frame),
    },
    {
      label: '스트리밍 중 — "receiving N chars..." 내부 용어 노출 재현',
      action: async (ctx) => { await ctx.wait(50) },
    },
    {
      label: '스트리밍 content 도착 — 마크다운 렌더로 전환',
      action: async (ctx) => {
        await ctx.setState('_streaming', {
          status: 'receiving',
          length: 120,
          content: '오늘 서울의 날씨는 맑습니다. 기온은 섭씨 22도이며 습도는 낮은 편입니다.',
        })
        await ctx.wait(100)
      },
      assert: (frame) => frame.includes('서울의 날씨'),
    },
    {
      label: '턴 완료 — success + idle 복귀',
      action: async (ctx) => {
        await ctx.setState('lastTurn', TurnOutcome.success('오늘 날씨 알려줘', '오늘 서울의 날씨는 맑습니다. 기온은 섭씨 22도이며 습도는 낮은 편입니다.'))
        await ctx.setState('_streaming', null)
        await ctx.setState('turnState', TurnState.idle())
        await ctx.wait(150)
      },
      assert: (frame) => frame.includes('idle'),
    },
    {
      label: '완료 후 프레임 — 응답이 ChatArea에 남아있는가',
      action: async (ctx) => { await ctx.wait(50) },
    },
  ],
}
