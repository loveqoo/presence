// agent-identity §I5 — admin/manager (reserved owner) 는 archive 불가 (서버 불변식).
// governance-cedar v2.7 §X — archive_agent action 도입과 함께 Cedar 정책으로 흡수.
//
// reserved owner = 'admin' 등 isReservedUsername 이 true 인 system-owned agent.
// 의미론: archive_agent intent 가 들어오면 reserved owner 의 agent 는 forbid.
forbid (
  principal is LocalUser,
  action == Action::"archive_agent",
  resource is Agent
) when { context.reservedOwner };
