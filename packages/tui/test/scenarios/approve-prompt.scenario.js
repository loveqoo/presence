export default {
  name: 'approve-prompt',
  description:
    '승인 프롬프트의 위험도 구분(FP-03)과 거부 피드백(FP-02)을 검증한다. ' +
    '낮은 위험(file_read)과 높은 위험(shell_exec rm -rf)을 같은 시각적 포맷으로 보여주는지, ' +
    '거부 후 ChatArea에 결정 기록이 남는지 확인한다.',
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
      label: '낮은 위험 승인 프롬프트 — file_read',
      action: async (ctx) => {
        await ctx.setState('_approve', { description: 'file_read /tmp/safe.txt' })
      },
      assert: (frame) => frame.includes('APPROVE') && frame.includes('file_read'),
    },
    {
      label: '낮은 위험 승인 — 프레임 스냅샷',
      action: async (ctx) => { await ctx.wait(50) },
    },
    {
      label: '높은 위험 승인 프롬프트로 교체 — shell_exec rm -rf',
      action: async (ctx) => {
        await ctx.setState('_approve', { description: 'shell_exec rm -rf /Users/testuser' })
      },
      assert: (frame) => frame.includes('APPROVE') && frame.includes('rm -rf'),
    },
    {
      label: '높은 위험 승인 — 프레임 스냅샷 (낮은 위험과 시각적으로 구분되는가?)',
      action: async (ctx) => { await ctx.wait(50) },
    },
    {
      label: '거부 입력 n',
      action: async (ctx) => {
        await ctx.type('n')
        await ctx.wait(100)
        await ctx.setState('_approve', null)
      },
    },
    {
      label: '거부 후 화면 — ChatArea에 거부 기록이 남는가?',
      action: async (ctx) => { await ctx.wait(100) },
      assert: (frame) => /거부|reject|rejected/i.test(frame),
    },
  ],
}
