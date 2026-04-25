# 승인(Approve) 플로우 정책

## 목적

에이전트가 위험한 작업을 실행하기 전 사용자에게 승인을 요청하는 플로우의 계약을 정의한다.
서버 측 Approve Op 처리, TUI 표시, 결정 기록, 위험도 분류 규칙을 포함한다.

## 불변식 (Invariants)

- I1. **Approve Op는 UI 없이 자동 승인**: `onApprove` 콜백이 없는 환경(백그라운드 세션, 테스트 등)에서 `Approve` Op는 자동으로 `true`를 반환한다 (`approval.js: onApprove 없으면 ST.of(f.next(true))`).
- I2. **승인 대기 상태는 `_approve` transient 경로에 기록**: `TurnController.onApprove(description)`는 `STATE_PATH.APPROVE`(`_approve`)에 `{ description }` 객체를 set하고 Promise resolve를 대기한다. `handleApproveResponse(approved)` 호출 시 resolve 후 `_approve`를 null로 clear한다.
- I3. **`_approve`는 디스크에 저장하지 않는다**: `_` 접두사 필드이므로 `stripTransient()`에 의해 persistence(disk) snapshot에서 제거된다. 이 제약은 디스크 저장 경로에만 적용된다. WS 브로드캐스트와 init snapshot은 별개 경로이며 `_approve`가 포함된다.
- I8. **재연결 시 `_approve` 복원 보장**: WS 재연결 후 서버의 `#handleJoin`이 `entry.session.state.snapshot()`을 init 메시지에 담아 전송한다. 이 snapshot은 `stripTransient()`를 거치지 않으므로 `_approve` 필드가 포함된다. 클라이언트 `MirrorState.applySnapshot()`이 `SNAPSHOT_PATHS`에 등록된 `_approve`를 cache에 반영하고 HookBus를 통해 publish하면, `useAgentState`의 `STATE_PATH.APPROVE` 핸들러가 `setApprove`를 호출하여 `ApprovePrompt`가 복원된다. 서버 측 `TurnController.approveResolve`는 메모리에 유지되므로 `POST /api/sessions/:id/approve`로 정상 resolve 가능하다. — 통합 테스트 S20으로 검증됨.
- I4. **승인 결정 기록은 TUI local message에만 존재**: `App.handleApprove`가 `addMessage({ role: 'system', content: '[승인됨/거부됨] ...' })`를 호출하여 ChatArea에 기록한다. 이 기록은 `conversationHistory`(서버 세션 상태)에 저장되지 않는다. 새로고침 또는 세션 재접속 시 소멸한다. — 의도된 동작 (ephemeral audit, 현재 구현 범위)
- I5. **위험도 분류(`classifyRisk`)는 TUI 표시 전용**: `HIGH_RISK_PATTERNS` 패턴 매칭 결과는 TUI 렌더링(border 색상, 레이블)에만 영향을 준다. 서버 측 승인 승인/거부 로직에는 영향을 주지 않는다. 위험도가 높다고 해서 자동 거부되지 않는다.
- I6. **승인 키 입력은 `y`/`Y`(승인)과 `n`/`N`(거부) 두 가지만**: `ApprovePrompt`의 `useInput`이 이 두 경우만 처리한다. 그 외 키는 무시된다.
- I7. **승인 대기 중 일반 입력 비활성화**: `InputBar`의 `disabled` prop이 `!!agentState.approve`일 때 true로 설정된다. 승인 프롬프트가 활성화된 동안 새 채팅 입력은 불가능하다.

## 위험도 분류 규칙 (classifyRisk)

`HIGH_RISK_PATTERNS` (`ApprovePrompt.js`)에 해당하면 `'high'`, 그 외는 `'normal'`.

현재 HIGH 패턴 (20개, 실질 19 unique — `TRUNCATE`가 line 15/25에 중복, 카테고리별):

**명령 실행**: `shell_exec`, `sudo`

**파괴적 파일 조작**: `rm -`, `file_write`, `file_delete`, `delete`, `truncate`

**DB 파괴**: `DROP TABLE/DATABASE/SCHEMA`, `TRUNCATE`

**원격 스크립트 즉시 실행**: `curl ... | sh|bash|zsh|ksh|dash`, `wget ... | sh|bash|zsh|ksh|dash`

**권한 전체 개방**: `chmod 777|666|X7Y7`, `chmod -R`

**프로세스 강제 종료**: `kill -9`, `pkill`

**Git 히스토리 파괴**: `git push --force/-f`, `git reset --hard`

**파일시스템 파괴**: `mkfs`, `dd if=`, `> /dev/sd[a-z]`

시각적 차이: high → 빨간 double border + `⚠⚠ 위험 — 승인 요청:`, normal → 노란 single border + `⚠ 승인 요청:`.

## 경계 조건 (Edge Cases)

- E1. **`description`이 `null`/`undefined`**: `classifyRisk`는 `description ?? ''`로 방어한다. 빈 문자열은 어떤 패턴에도 매칭되지 않으므로 `'normal'`로 분류된다. `ApprovePrompt` 렌더링 시 `description` prop에 `undefined`가 전달되면 Ink의 `Text` 컴포넌트가 빈 문자열로 렌더링한다.
- E2. **false positive — 맥락 없는 delete 매칭**: `description`이 "delete 방법 안내" 같은 무해한 문자열이어도 `/\bdelete\b/i`에 매칭되어 HIGH로 분류된다. 현재 classifyRisk는 키워드 위치/맥락을 고려하지 않는다. — Known Gap (표시 전용이므로 기능적 부작용 없음)
- E3. **false negative — 정규식 한계**: `eval(`, `exec(`, `Function(`, base64 우회 패턴 등은 현재 HIGH 패턴에 포함되지 않아 normal로 분류된다. 정규식 키워드 매칭의 구조적 한계로 우회 가능한 잔여 영역이 존재한다. — Known Gap
- E4. **승인 대기 중 WS 재연결 (정상 경로)**: 백오프 재연결(close 코드 4001/4002/4003 외의 경우) 시 `_approve`는 init snapshot에 포함되어 복원된다 (I8 참조). `TurnController.approveResolve`는 서버 메모리에 유지되며, 클라이언트가 `POST /api/sessions/:id/approve`를 전송하면 정상적으로 resolve된다. — 통합 테스트 S20으로 검증됨.
- E4b. **승인 대기 중 복구 불가 연결 끊김 (`onUnrecoverable` 발동)**: close 코드 4002/4003 또는 4001 refresh 실패 시 재연결이 중단되며 TUI가 배너("TUI를 재시작하세요")를 렌더링한다. 이 경우 클라이언트가 WS 자체를 다시 연결하지 않으므로 pending approve 해소 수단이 없다. TUI를 재시작하면 새 WS 연결로 init snapshot이 수신되어 E4(정상 재연결 경로)로 처리된다. — `tui-server-contract.md I13` 참조.
- E5. **`handleApproveResponse` 중복 호출 방어**: `approveResolve`가 null이면 early return한다. 연속 클릭이나 중복 POST 요청은 무시된다.
- E6. **승인 결정 기록과 conversationHistory 동기화 없음**: `useAgentMessages`의 `conversationHistory` sync effect는 `role: 'user'|'agent'|'error'` 외의 메시지를 `localOnly`로 보존한다. 승인 기록(`role: 'system'`)은 conversationHistory 재동기화 시에도 유지된다. 단, 페이지 새로고침/재마운트 시 소멸한다.
- E7. **백그라운드 세션(EphemeralSession)의 Approve 자동 승인**: I1에 의해 `onApprove` 없이 자동 true 반환. 위험도 분류 없음. i18n 키 `errors.approve_rejected_bg`는 별도 경로(REPL auto-reject 등)에서 사용된다.

## 테스트 커버리지

- I1 → `packages/core/test/interpreter/approval.test.js` (onApprove 없을 때 자동 true) — 확인 필요 ⚠️
- I2, I5, E5 → `packages/infra/test/session.test.js` (TurnController approve/response 흐름) — 확인 필요 ⚠️
- I4, I6, E1, HIGH 표시 → `packages/tui/test/scenarios/approve-prompt.scenario.js` (5/5 시나리오, step 4에 `curl ... | sh` 회귀 케이스 추가)
- HIGH 패턴 단위 (14개 HIGH + 음성 3개) → `packages/tui/test/app.test.js` 단위 56-57
- E2 → (단위 테스트 없음) ⚠️ false positive 맥락 구분 미커버
- E3 → (단위 테스트 없음) ⚠️ eval/exec/base64 우회 false negative 미커버
- I8, E4 → `packages/server/test/server.test.js` S20 (재연결 시 _approve 복원 + POST /approve 정상 resolve 전체 흐름)
- E4b → (테스트 없음) ⚠️ onUnrecoverable 발동 시 pending approve 해소 불가 경로

## 관련 코드

- `packages/tui/src/ui/components/ApprovePrompt.js` — classifyRisk, 렌더링
- `packages/tui/src/ui/App.js` — handleApprove, addMessage 결정 기록
- `packages/core/src/interpreter/approval.js` — approvalInterpreterR
- `packages/infra/src/infra/sessions/internal/turn-controller.js` — onApprove, handleApproveResponse, resetApprove
- `packages/server/src/server/session-api.js` — `POST /sessions/:sessionId/approve`
- `packages/infra/src/i18n/ko.json`, `en.json` — approve.* i18n 키

## 변경 이력

- 2026-04-11: 초기 작성 — FP-02(결정 기록), FP-03(위험도 분류) 반영
- 2026-04-11: FP-46 resolved — HIGH_RISK_PATTERNS 6개 → 21개 확장, E3 잔여 false negative만 남김, E4를 KG-07로 격상
- 2026-04-11: FP-22 해소와 KG-07 경계 명시 — E4에 onUnrecoverable 발동 시(복구 불가 경로)에도 pending approve 해소 불가임을 명시. tui-server-contract.md I13 참조 링크 추가.
- 2026-04-11: KG-07 재검증으로 정정 — `_approve`의 transient 범위를 persistence 한정으로 명확화. I3 범위 정정, I8(재연결 시 _approve 복원 보장) 신규 추가, E4를 정상 경로로 전환, E4b(복구 불가 경로)로 분리, 테스트 커버리지 S20 매핑 추가.
- 2026-04-25: HIGH_RISK_PATTERNS 카운트 정정 — 21 → 20 (실질 19 unique). `TRUNCATE`가 line 15/25에 중복 등록되어 있음. FP-46 확장 시점 이후 변동 없음, 초기 카운트 오기.
