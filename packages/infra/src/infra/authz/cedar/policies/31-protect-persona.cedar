// agent-identity-model.md §6 (persona) + I-CEDAR-PERSONA — admin/* (reserved owner)
// agent 의 persona 는 admin 만 변경 가능. ownership 경로 외 fallback 게이트.
// governance-cedar v2.9 §X — set_persona fail-open → fail-closed 전환 시점.
//
// 정상 server 경로: session middleware (canAccessAgent) 가 owner 검증 → 비-admin 의
// admin/* 접근 자체가 차단. 이 정책은 future paths (admin CLI / a2a / interpreter)
// 에서 ownership middleware 우회 시에도 admin/* persona 보호.
forbid (
  principal is LocalUser,
  action == Action::"set_persona",
  resource is Agent
) when { context.reservedOwner && !context.isAdmin };
