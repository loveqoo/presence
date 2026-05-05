// Archived agent 와의 새 A2A 세션 시작 차단 (agent-session.md I-AS-AUTH).
// archived = 운영 종료된 자아 — 외부 에이전트와의 새 만남은 절대 차단.
// 기존 만남 (이미 시작된 세션) 은 본 정책 영향 없음.
// 20-archived.cedar 와 archived 카테고리 공유 (prefix 매핑 cedar/index.js).
forbid (
  principal is LocalUser,
  action == Action::"start_a2a_session",
  resource is Agent
) when { context.archived };
