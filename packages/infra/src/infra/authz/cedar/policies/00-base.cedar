// LocalUser 의 RBAC 게이트 (전부 허용). 의미론은 forbid 정책 (10-quota / 11-admin-limit
// / 20-archived) 또는 코드 분기에서 처리.
// governance-cedar v2.4~v2.5 — Cedar 흡수가 늘어나도 base 는 단순 permit 유지.
permit (
  principal is LocalUser,
  action == Action::"create_agent",
  resource is User
);

permit (
  principal is LocalUser,
  action == Action::"access_agent",
  resource is Agent
);
