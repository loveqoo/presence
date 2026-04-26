// LocalUser 의 create_agent: RBAC 게이트만 (전부 허용).
// 의미론 (quota / autoApprove / hard limit) 은 호출 코드 분기에서 처리.
// Y' phase minimal seed — governance-cedar v2.1 phase 에서 의미론 통합.
permit (
  principal is LocalUser,
  action == Action::"create_agent",
  resource is User
);
