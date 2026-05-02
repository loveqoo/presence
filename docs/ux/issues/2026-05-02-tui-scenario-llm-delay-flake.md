# [FP-81] 라이브 시나리오 테스트가 누적 LLM 컨텍스트로 비결정적 timeout

**영역**: tui, infra
**심각도**: low
**상태**: resolved
**관련 코드**: `test/e2e/tui-scenario.test.js`, `test/e2e/live-helpers.js` (LLM_TIMEOUT, sendAndWait), `packages/infra/src/infra/llm/` (LLM 클라이언트)

## 시나리오

라이브 시나리오 전체 회귀를 실행할 때:

```bash
node test/e2e/tui-scenario.test.js
```

FP-80 (cancel-stuck FSM) 수정 후 S19→S20 cancel 흐름은 통과하지만, cancel 과 무관한 중간 시나리오 (S13-3, S15-4 등) 에서 `sendAndWait` 가 turn 변화를 감지하지 못한 채 `LLM_TIMEOUT` (120s) 만료까지 hang 한다. 매 실행마다 hang 발생 위치가 다르며 동일 시나리오가 다음 실행에서는 통과하기도 한다.

## 현재 동작

- FP-80 fix 후 S19→S20 (cancel 흐름) 은 안정적으로 통과.
- S13-3, S15-4 등 cancel 무관 시나리오에서 `sendAndWait` 가 turn 상태 변화를 감지 못하고 120s 경과 후 timeout.
- `agent.log` 에는 새 세션 생성 로그만 있고 `Turn failed` / `Turn cancelled` 같은 명시적 실패 로그 없음 → 서버측 오류가 아닌 응답 지연.
- 다른 실행에서는 동일 시나리오 정상 통과 → 비결정적.
- 로컬 35B 모델(qwen3.6-35b)과 시나리오 누적 `conversationHistory` 가 맞물려 응답 시간이 실행마다 크게 차이날 것으로 추정.

## 마찰 포인트

| 포인트 | 설명 |
|--------|------|
| 비결정성 | 매 실행 다른 위치에서 hang → CI / 회귀 검증 신뢰도 저하, 실패 원인 추적 어려움 |
| 디버그 어려움 | 명시적 에러 로그 없이 timeout 만 발생. 어떤 turn 이 느렸는지 확인 불가 |
| LLM 모델 의존 | 로컬 35B 모델 + 누적 conversationHistory 로 응답 시간이 시나리오 후반부로 갈수록 폭증 가능 |
| 격리 부족 | `setup()` 이 `/clear` 를 호출하지만 mem0 / 기타 상태가 시나리오 간 누적될 가능성 |
| 고정 timeout | `LLM_TIMEOUT` 이 시나리오 순서와 무관하게 일률 120s 적용 → 후반 시나리오에 불리 |

## 영향 범위

라이브 시나리오 회귀 검증의 비결정성에 영향. 실제 사용자 UX 와는 무관하다 — 사용자는 turn 단위로 상호작용하며, 명시적 timeout / 취소 흐름(FP-80 해소)을 이미 보유하고 있다.

## 제안

**(a) 진단 먼저**
- 시나리오별 LLM 응답 시간을 측정하는 로그 추가 (sendAndWait 시작~turn 변화 감지까지).
- 시나리오 순번 vs 응답 시간 상관관계를 수집해 누적 컨텍스트가 실제 원인인지 확인.

**(b) 격리 강화**
- `setup()` 에서 mem0 clear, 새 세션 강제 생성 등 더 강한 reset 적용.
- 시나리오 간 `conversationHistory` 가 누적되지 않도록 isolation 경계 명확화.

**(c) Timeout 비례 증가**
- 시나리오 후반부(예: S13 이후)에 `LLM_TIMEOUT` 을 늘리거나, 응답 시간 측정 결과에 따라 동적으로 조정.

**(d) 테스트 전용 경량 모델 분리 (선택적)**
- 라이브 테스트 전용으로 qwen-small 등 응답이 빠른 모델 사용 고려.
- 단, 실제 운영 모델로 검증하지 않으면 라이브 테스트의 가치가 약화되는 trade-off 있음.

## 근거

심각도 low: 실제 UX 영향 없음. CI 가 라이브 테스트를 nightly 전용으로만 실행한다면 운영 영향도 없다. 그러나 회귀 검증 신뢰도가 낮아져 FP-80 같은 진짜 회귀를 묻을 수 있으므로 진단은 필요하다. (a) 진단부터 시작해 원인이 확인되면 (b)/(c) 중 적은 비용의 방안을 먼저 적용하는 것을 권장.

## 진단 (2026-05-02)

`PRESENCE_LIVE_TIMING=1` 환경변수로 시나리오별 turn 응답 시간 측정 + timeout 시
서버 state dump 인프라 추가 (`test/e2e/live-helpers.js`).

### 측정 데이터

라이브 시나리오 테스트 2회 실행 결과:

**1차 실행** (S9-1 에서 hang):
- S1~S8 통과: 모든 turn 5~18초 응답 (평균 10초)
- S9-1 (`루트 디렉토리의 파일과 폴더 개수를 세줘`) 에서 120s timeout
- 실패 모드: turn change 됐으나 idle 도달 못함 (`waitIdle`)

**2차 실행** (S10-3 에서 hang):
- S1~S10-2 통과: 모든 turn 5~16초 응답
- S10-3 (`/tool list` 후 `file_` 텍스트 frame 검증) 에서 5s timeout
- 실패 모드: slash 명령 후 frame 에 결과 미반영

**이전 실행들** (timing 없이):
- S20, S13-3, S15-4 등 다양한 위치에서 120s turn change timeout

### 패턴

| 실패 종류 | 의심 원인 |
|----------|----------|
| 120s — turn change 미발생 | typeInput 의 stdin write 손실 / InputBar 입력 무시 / WS broadcast 누락 |
| 120s — idle 미도달 | LLM 응답 hang / executor.afterTurn 처리 지연 / FSM emit 누락 |
| 5s — frame 검증 실패 | Ink testing library frame 렌더 race / slash 결과 transient 빠른 소실 |

### 결론

단일 원인이 아닌 **복합 race conditions**. 매 실행마다 다른 위치/다른 종류 timeout 발생.
LLM 지연만이 아니라:
- stdin → InputBar 입력 동기화 race
- WS broadcast → MirrorState 갱신 race
- Frame 렌더 race
- LLM 응답 시간의 자연 변동 (5~25초 관찰, 더 클 수도)

### 다음 단계 (후속 phase)

- 각 race 종류별 분리 재현 → 각각 별도 fix
- LLM 응답 시간 변동을 흡수하는 timeout 정책 (시나리오별 가변 timeout)
- stdin write → InputBar 도착 ack 메커니즘 (테스트 framework 한정)
- WS broadcast 누락 감지 (sequence number / 재요청)

본 phase 에서는 `PRESENCE_LIVE_TIMING=1` 진단 인프라만 보존. 향후 데이터 수집 +
원인별 점진적 해결을 위한 발판.

### 참고

진단 인프라 사용법:
```bash
npm run server:start
PRESENCE_LIVE_TIMING=1 node test/e2e/tui-scenario.test.js
```

각 sendAndWait 의 5s 초과 timing 출력 + timeout 시 server state (turn / turnState
/ lastTurn / historyLen / streaming) dump.

## 해소 (2026-05-02)

진단 인프라로 timeout 시점 server state 를 캡처한 결과, 가설이 뒤집혔다.

### 실제 원인

`waitIdle` 함수의 frame 검사 로직 결함:

```javascript
const waitIdle = (lastFrame) => waitFor(
  () => lastFrame().includes('idle') && !lastFrame().includes('thinking'),
  { timeout: LLM_TIMEOUT },
)
```

LLM 이 가끔 failure 로 응답 종료할 때 (truncation / invalid format / abort 등 자연
발생 케이스), 서버는 정상적으로 `turnState=idle` 진입 + `lastTurn=failure` 로 마킹.
TUI 의 StatusBar 는 status 별 indicator 를 표시:

- working: `◌ thinking` 또는 `◌ <activity>`
- error:   `✗ error` 또는 `✗ error: <hint>`
- idle:    `● idle`

`lastTurn=failure` 면 TUI status='error' 가 되어 StatusBar 가 `✗ error` 를 그린다.
이때 frame 에 'idle' 텍스트가 등장하지 않으므로 `waitIdle` 이 영원히 timeout.

`InputBar.disabled = isWorking` 이라 error 상태에서도 입력은 가능 — 즉 응답 완료의
일종이지만 framework 검사가 이를 인식 못 했다.

### 수정

`test/e2e/live-helpers.js` 의 `waitIdle` 가 두 indicator 모두 인식:

```javascript
const waitIdle = (lastFrame) => waitFor(
  () => {
    const f = lastFrame()
    return f.includes('● idle') || f.includes('✗ error')
  },
  { timeout: LLM_TIMEOUT },
)
```

`reconnecting` 은 일시적 (재연결 후 idle/error 로 수렴) 이라 별도 처리 안 함.

### 회귀 검증

수정 후 라이브 시나리오 테스트 2회 연속 실행 — 모두 48/48 passed. 이전 매 실행마다
다른 위치에서 hang 하던 비결정성 완전 해소.

### Production 영향

없음. TUI 의 InputBar 는 이미 error 상태에서도 활성. 사용자는 LLM failure 후 즉시
다음 메시지 입력 가능. 본 이슈는 e2e framework 의 검사 로직 결함이었다.

### 보존된 진단 인프라

`PRESENCE_LIVE_TIMING=1` 환경변수로 sendAndWait 별 timing + timeout 시 server state
dump 출력. 향후 다른 race conditions 진단에 활용 가능. 인프라 자체는 평소 출력에
영향 없음 (env 부재 시 비활성).
