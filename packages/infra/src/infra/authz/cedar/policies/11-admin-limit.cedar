// Admin 의 create_agent: hardLimit (PRESENCE_ADMIN_AGENT_HARD_LIMIT, 기본 50) 초과 시 forbid.
// governance-cedar v2.4 §X — agent-identity.md I8 (admin quota 면제 + 하드 상한) 의 Cedar 흡수.
// 일반 quota (maxAgents) 는 admin 면제 — 10-quota.cedar 가 !isAdmin 조건.
forbid (
  principal is LocalUser,
  action == Action::"create_agent",
  resource is User
) when { context.isAdmin && context.currentCount >= context.hardLimit };
