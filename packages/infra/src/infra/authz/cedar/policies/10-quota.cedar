// Non-admin LocalUser 의 create_agent: maxAgentsPerUser 초과 시 forbid.
// governance-cedar v2.4 §X — admin 은 별도 정책 (11-admin-limit.cedar) 으로 hardLimit 까지 허용.
// boot.js 가 50-* 정책 파일을 차단하므로, 본 정책 + 11-admin-limit 가 유일한 forbid →
// agent-governance.js interpretCedarDecision 이 deny = quota-exceeded 로 매핑.
forbid (
  principal is LocalUser,
  action == Action::"create_agent",
  resource is User
) when { !context.isAdmin && context.currentCount >= context.maxAgents };
