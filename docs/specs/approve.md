# 승인(Approve) 플로우 정책

## 목적

에이전트가 위험한 작업을 실행하기 전 사용자에게 승인을 요청하는 플로우의 계약을 정의한다.
서버 측 Approve Op 처리, TUI 표시, 결정 기록, 위험도 분류 규칙을 포함한다.

## 불변식 (Invariants)

- I1. **Approve Op는 UI 없이 자동 승인**: `onApprove` 콜백이 없는 환경(백그라운드 세션, 테스트 등)에서 `Approve` Op는 자동으로 `true`를 반환한다 (`approval.js: onApprove 없으면 ST.of(f.next(true))`).
- I2. **승인 대기 상태는 `_approve` transient 경로에 기록**: `TurnController.onApprove(description)`는 `STATE_PATH.APPROVE`(`_approve`)에 `{ description }` 객체를 set하고 Promise resolve를 대기한다. `handleApproveResponse(approved)` 호출 시 resolve 후 `_approve`를 null로 clear한다.
- I3. **`_approve`는 디스크에 저장하지 않는다**: `_` 접두사 필드이므로 `stripTransient()`에 의해 persistence snapshot에서 제거된다. 재접속/재시작 시 승인 대기 상태는 복원되지 않는다.
- I4. **승인 결정 기록은 TUI local message에만 존재**: `App.handleApprove`가 `addMessage({ role: 'system', content: '[승인됨/거부됨] ...' })`를 호출하여 ChatArea에 기록한다. 이 기록은 `conversationHistory`(서버 세션 상태)에 저장되지 않는다. 새로고침 또는 세션 재접속 시 소멸한다. — 의도된 동작 (ephemeral audit, 현재 구현 범위)
- I5. **위험도 분류(`classifyRisk`)는 TUI 표시 전용**: `HIGH_RISK_PATTERNS` 패턴 매칭 결과는 TUI 렌더링(border 색상, 레이블)에만 영향을 준다. 서버 측 승인 승인/거부 로직에는 영향을 주지 않는다. 위험도가 높다고 해서 자동 거부되지 않는다.
- I6. **승인 키 입력은 `y`/`Y`(승인)과 `n`/`N`(거부) 두 가지만**: `ApprovePrompt`의 `useInput`이 이 두 경우만 처리한다. 그 외 키는 무시된다.
- I7. **승인 대기 중 일반 입력 비활성화**: `InputBar`의 `disabled` prop이 `!!agentState.approve`일 때 true로 설정된다. 승인 프롬프트가 활성화된 동안 새 채팅 입력은 불가능하다.

## 위험도 분류 규칙 (classifyRisk)

`HIGH_RISK_PATTERNS` (`ApprovePrompt.js`)에 해당하면 `'high'`, 그 외는 `'normal'`.

현재 HIGH 패턴:
- `/\bshell[_ ]exec\b/i`
- `/\brm\s+-/i`
- `/\bfile[_ ](write|delete)\b/i`
- `/\bsudo\b/i`
- `/\bdelete\b/i`
- `/\bDROP\s+TABLE\b/i`

시각적 차이: high → 빨간 double border + `⚠⚠ 위험 — 승인 요청:`, normal → 노란 single border + `⚠ 승인 요청:`.

## 경계 조건 (Edge Cases)

- E1. **`description`이 `null`/`undefined`**: `classifyRisk`는 `description ?? ''`로 방어한다. 빈 문자열은 어떤 패턴에도 매칭되지 않으므로 `'normal'`로 분류된다. `ApprovePrompt` 렌더링 시 `description` prop에 `undefined`가 전달되면 Ink의 `Text` 컴포넌트가 빈 문자열로 렌더링한다.
- E2. **false positive — 맥락 없는 delete 매칭**: `description`이 "delete 방법 안내" 같은 무해한 문자열이어도 `/\bdelete\b/i`에 매칭되어 HIGH로 분류된다. 현재 classifyRisk는 키워드 위치/맥락을 고려하지 않는다. — Known Gap (표시 전용이므로 기능적 부작용 없음)
- E3. **누락된 HIGH 패턴**: `curl ... | sh`, `chmod 777`, `kill -9`, `DROP DATABASE`, `TRUNCATE`, `eval(`, `exec(` 등은 현재 HIGH 패턴에 포함되지 않아 normal로 분류된다. — Known Gap
- E4. **승인 대기 중 세션 종료/재연결**: `_approve`가 transient이므로 재연결 후 승인 프롬프트는 사라진다. 서버 측 `TurnController.approveResolve`는 여전히 대기 중이지만 클라이언트로부터 응답을 받을 수 없다. 결국 turn abort 또는 타임아웃까지 서버 측에 Approve Promise가 pending 상태로 남는다. — Known Limitation
- E5. **`handleApproveResponse` 중복 호출 방어**: `approveResolve`가 null이면 early return한다. 연속 클릭이나 중복 POST 요청은 무시된다.
- E6. **승인 결정 기록과 conversationHistory 동기화 없음**: `useAgentMessages`의 `conversationHistory` sync effect는 `role: 'user'|'agent'|'error'` 외의 메시지를 `localOnly`로 보존한다. 승인 기록(`role: 'system'`)은 conversationHistory 재동기화 시에도 유지된다. 단, 페이지 새로고침/재마운트 시 소멸한다.
- E7. **백그라운드 세션(EphemeralSession)의 Approve 자동 승인**: I1에 의해 `onApprove` 없이 자동 true 반환. 위험도 분류 없음. i18n 키 `errors.approve_rejected_bg`는 별도 경로(REPL auto-reject 등)에서 사용된다.

## 테스트 커버리지

- I1 → `packages/core/test/interpreter/approval.test.js` (onApprove 없을 때 자동 true) — 확인 필요 ⚠️
- I2, I5, E5 → `packages/infra/test/session.test.js` (TurnController approve/response 흐름) — 확인 필요 ⚠️
- I4, I6, E1, HIGH 표시 → `packages/tui/test/scenarios/approve-prompt.scenario.js` (4/4 시나리오)
- E2, E3 → (단위 테스트 없음) ⚠️ classifyRisk 패턴 커버리지 — 각 HIGH_RISK_PATTERNS 분기별 단위 테스트 필요
- E4 → (테스트 없음) ⚠️ 재연결 중 pending approve 동작

## 관련 코드

- `packages/tui/src/ui/components/ApprovePrompt.js` — classifyRisk, 렌더링
- `packages/tui/src/ui/App.js` — handleApprove, addMessage 결정 기록
- `packages/core/src/interpreter/approval.js` — approvalInterpreterR
- `packages/infra/src/infra/sessions/internal/turn-controller.js` — onApprove, handleApproveResponse, resetApprove
- `packages/server/src/server/session-api.js` — `POST /sessions/:sessionId/approve`
- `packages/infra/src/i18n/ko.json`, `en.json` — approve.* i18n 키

## 변경 이력

- 2026-04-11: 초기 작성 — FP-02(결정 기록), FP-03(위험도 분류) 반영
