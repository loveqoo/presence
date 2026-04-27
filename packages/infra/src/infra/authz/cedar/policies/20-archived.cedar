// Archived agent 의 access_agent: continue-session 외 intent → forbid.
// agent-identity-model.md §5.4 graceful retire — archived 마킹된 agent 는
// 기존 세션 계속 실행만 허용 (새 세션, 위임, 스케줄 실행은 차단).
// governance-cedar v2.5 §X — 의미론 Cedar 정책 흡수 (canAccessAgent 의 archived 분기).
forbid (
  principal is LocalUser,
  action == Action::"access_agent",
  resource is Agent
) when { context.archived && context.intent != "continue-session" };
