// LocalUser 의 create_agent: quota 초과 시 forbid.
// governance-cedar v2.3 §X — quota 의미론을 Cedar 정책으로 흡수 (옵션 Y' hybrid).
// boot.js 가 50-* 정책 파일을 차단하므로, 본 정책이 유일한 forbid →
// agent-governance.js 의 interpretCedarDecision 이 deny = quota-exceeded 로 매핑.
forbid (
  principal is LocalUser,
  action == Action::"create_agent",
  resource is User
) when { context.currentCount >= context.maxAgents };
