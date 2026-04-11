export default {
  name: 'approve-prompt',
  description:
    '승인 프롬프트의 위험도 구분(FP-03)과 거부 피드백(FP-02)을 검증한다. ' +
    '낮은 위험(file_read)은 일반 레이블, 높은 위험(shell_exec rm -rf)은 HIGH RISK 레이블을 사용해야 하고, ' +
    '거부 후 ChatArea에 "거부됨" 기록이 남아야 한다.',
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
      label: '낮은 위험 승인 프롬프트 — file_read (일반 레이블이어야 함)',
      action: async (ctx) => {
        await ctx.setState('_approve', { description: 'file_read /tmp/safe.txt' })
        await ctx.wait(50)
      },
      assert: (frame) => frame.includes('승인 요청') && frame.includes('file_read') && !frame.includes('위험'),
    },
    {
      label: '높은 위험 승인 프롬프트로 교체 — shell_exec rm -rf (HIGH RISK 레이블이어야 함)',
      action: async (ctx) => {
        await ctx.setState('_approve', { description: 'shell_exec rm -rf /Users/testuser' })
        await ctx.wait(50)
      },
      assert: (frame) => frame.includes('위험') && frame.includes('rm -rf'),
    },
    {
      label: '거부 입력 n — ChatArea에 거부 기록이 남아야 함',
      action: async (ctx) => {
        await ctx.type('n')
        await ctx.wait(100)
        await ctx.setState('_approve', null)
        await ctx.wait(100)
      },
      assert: (frame) => frame.includes('거부됨') && frame.includes('rm -rf'),
    },
  ],
}
