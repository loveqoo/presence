# [FP-80] cancel 직후 다음 입력이 새 turn 시작 못하는 stall (라이브 시나리오 S19→S20)

**영역**: tui, server
**심각도**: low
**상태**: resolved
**관련 코드**: `test/e2e/tui-scenario.test.js:425-477` (S19 → S20), `packages/server/src/server/ws-handler.js`, `packages/tui/src/remote-session.js`

## 시나리오

라이브 e2e 시나리오 테스트를 실행한다.

```bash
npm test -- test/e2e/tui-scenario.test.js
```

S1~S19 (45 assertions) 는 통과한다. S19 는 "긴 작업 ESC 취소" 시나리오다. 그 직후 S20 ("새 세션에 마커 설정 → /session 목록 확인") 의 setup() 이 실행되고, S20-1 의 첫 메시지 `sendAndWait("SESSION-A-MARKER")` 에서 LLM_TIMEOUT (120s) 까지 hang 한다.

## 현재 동작

1. S19: 유저가 긴 작업 중 ESC 를 누름 → 서버가 turn 을 cancel → `Turn cancelled by user` 로그 기록
2. S20 setup(): `/api/sessions/{id}/state` 폴링이 `idle` 을 확인 → setup 성공으로 판단
3. S20-1 `sendAndWait("SESSION-A-MARKER")`: 메시지를 전송하지만 서버에서 새 turn 이 시작되지 않음 → agent.log 에 turn-start 로그 미기록 → 120s 대기 후 timeout

## 마찰 포인트

| 포인트 | 설명 |
|--------|------|
| 증상 모호함 | timeout 메시지만 발생하고 "왜 turn 이 시작되지 않았는가" 를 유저(또는 테스트 작성자)가 알 수 없음 |
| cancel 상태 누수 가능성 | 서버 측 cancellation flag 가 S19 완료 후에도 clearr되지 않아 S20 첫 메시지를 차단할 수 있음 |
| MirrorState 재연결 race 가능성 | setup() 이 idle 확인 후 S20-1 메시지 전송 사이에 TUI 의 MirrorState 가 아직 재연결 중이면 메시지가 유실될 수 있음 |
| 테스트 vs 실제 UX 구분 필요 | 현재 stall 이 라이브 테스트 환경 한정인지, 실제 유저가 cancel 직후 즉시 입력할 때도 동일하게 발생하는지 미확인 |

## 영향 범위

- 라이브 e2e 시나리오 테스트가 S20 이후 항목 전체를 검증하지 못하는 비결정성 발생
- 실제 UX 영향 미확인: 사용자가 cancel 직후 즉시 입력하는 자연스러운 흐름에서 동일 stall 이 재현되면 medium 이상으로 격상 필요

## 제안

### (a) 진단 우선

1. **서버 cancellation flag lifetime 점검** — `ws-handler.js` 에서 turn cancel 후 flag 초기화 위치와 타이밍 확인. idle 상태 노출 이전에 flag 가 정리되지 않는 경로가 있는지 확인
2. **MirrorState 재연결 race 점검** — `remote-session.js` 에서 setup 의 idle 확인 완료 후 메시지 전송 가능 상태가 보장되는지 확인. `idle` REST 응답과 WS 채널 준비 완료 사이의 간극 여부 점검
3. **TUI 수동 재현** — 실제 TUI 세션에서 긴 작업 중 ESC → 즉시 새 메시지 입력 흐름 수동 확인. 재현되면 medium 격상

### (b) 테스트 한정 임시 회피

S19 종료 후 S20 setup() 진입 전 짧은 대기(`await sleep(500)` 수준)를 추가하여 cancellation flag 정리 타이밍 확보. 근본 원인 확인 전까지 임시 조치.

### (c) 근본 해결 방향

서버가 turn cancel 완료 시 명시적인 "cancel-ack" 신호를 WS 로 내려보내고, TUI 가 그 신호를 받은 후에만 다음 메시지 입력을 활성화하는 흐름을 고려. 이렇게 하면 cancel 직후 즉시 입력 시나리오에서도 유저가 "아직 처리 중" 임을 인지할 수 있음.

## 근거

심각도 low: 현재까지 라이브 시나리오 테스트에서만 관찰됨. 실제 UX 에서 cancel + 즉시 재시도는 자연스러운 흐름이므로, 수동 재현 성공 시 medium 으로 격상한다.

## 해소 (2026-05-02)

원인 — turnGateFSM 에 `cancelling + complete` / `cancelling + failure` 트랜지션 부재.
LLM SDK 가 abort 신호를 무시하고 정상 완료할 경우 (또는 cancel 이 turn 종료 직전에 도착할
경우), executor 가 `complete` 이벤트를 submit 하지만 FSM 은 `cancelling` 상태에서 이를
거부 (no-match) → FSM 이 영구히 `cancelling` 에 stuck. Bridge 가 `cancelling → working`
projection 을 유지하면서 `state.turnState = 'working'` 도 영구. TUI 의 `InputBar` 는
`disabled = isWorking` 으로 입력을 차단하므로, 사용자/테스트의 다음 typeInput 이 무시되어
`POST /chat` 자체가 발생하지 않음 → 다음 turn 시작 못함.

수정 — `packages/infra/src/infra/fsm/turn-gate-fsm.js` 에 두 트랜지션 추가:

- `cancelling + complete → idle` + `turn.cancelled` emit (cancel 시도 보존)
- `cancelling + failure → idle` + `turn.cancelled` emit

LLM 이 abort 를 무시했든 cancel 이 늦게 도착했든, turn 자체가 끝나면 idle 로 수렴.

회귀 — A7 / A8 (turn-gate-fsm.test.js) 단위 테스트 + isolated 재현 스크립트로 검증
(cancel 후 idle 복귀 10ms, 다음 chat turn 증가 정상).

테스트 측면 — 라이브 시나리오 테스트의 S19→S20 전이는 본 수정으로 해소. 단, 별도 LLM
응답 지연 (qwen3.6-35b 로컬 모델 + 누적 컨텍스트 길어짐) 으로 인한 sendAndWait timeout
은 독립 이슈로 잔존 — 본 ticket 범위 밖.
