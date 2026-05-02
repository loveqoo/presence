# [FP-81] 라이브 시나리오 테스트가 누적 LLM 컨텍스트로 비결정적 timeout

**영역**: tui, infra
**심각도**: low
**상태**: open
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
