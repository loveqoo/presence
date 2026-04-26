# TUI 컴포넌트 현황

현재 TUI(Ink 기반) 주요 컴포넌트의 사용자 가시 요소 스냅샷.

---

## StatusBar

**위치**: `packages/tui/src/ui/components/StatusBar.js`
**표시 영역**: 화면 하단 고정 라인

### 표시 항목 (DEFAULT_ITEMS 기준)

| 세그먼트 | 표시 형식 | 데이터 출처 |
|---------|----------|-----------|
| status indicator | `● idle` / `◌ thinking...` / `✗ error` | agentState.status |
| session | `session: ${sessionId}` | RemoteSession.currentSessionId |
| budget | `budget: ${N}%` (컬러) | agentState.debug.assembly |
| model | LLM 모델명 | config.llm.model |
| dir | `ws: ${basename}` | agentState.workingDir |
| branch | `branch: ${name}` | git rev-parse |

### agentName prop — 렌더링 미사용 (KG-16 관련 관찰)

App.js는 `agentName: config.persona?.name || 'Presence'` 를 StatusBar에 전달하지만,
StatusBar 컴포넌트는 이 값을 화면에 출력하지 않는다.
agentId(`admin/manager`, `${userId}/default` 등 내부 식별자)도 StatusBar에 노출되지 않는다.

**KG-16 영향 평가 (2026-04-26)**:
KG-16이 부트 세션의 agentId를 `${userId}/default` → `config.primaryAgentId`(`admin/manager` 등)로
변경하더라도 StatusBar에는 가시 변화 없음. sessionId 형식(`${username}-default`)은 별도 상수
(`defaultSessionId`)를 사용하므로 KG-16 변경과 무관하다.
결론: **no impact** — 사용자 가시 영역에 도달하지 않음.

---

## ChatArea

**위치**: `packages/tui/src/ui/components/ChatArea.js`

대화 메시지 목록 표시. role(user/assistant/system)별 렌더링.
내부 agentId/agentName은 메시지 content에 포함되지 않는 한 표시되지 않음.

---

## TranscriptOverlay

**위치**: `packages/tui/src/ui/components/TranscriptOverlay.js`
**진입**: `Ctrl+T`

debug/opTrace/iterationHistory를 표시. 내부 구현 상세가 노출되는 유일한 경로.
일반 사용자가 능동적으로 열어야만 보이므로 기본 UX 경로에서는 비가시.
