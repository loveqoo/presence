# 테스트

## 실행

```bash
npm test                              # 전체 (node test/run.js)
node test/core/agent.test.js          # 개별 파일
node test/run.js --no-network         # 네트워크 바인딩 불가 환경
```

## 계층

| 계층 | 위치 | 특징 |
|------|------|------|
| 워크스페이스 smoke | `workspace/` | import map 검증 (가장 먼저) |
| 단위/통합 | `packages/*/test/` | mock 인터프리터, mock LLM |
| 서버 E2E | `e2e/server-e2e.test.js` | Express + mock LLM |
| TUI E2E | `e2e/tui-e2e.test.js` | ink-testing-library + 실제 서버(mock LLM) |
| TUI Live | `e2e/tui-live.test.js` | 실제 서버 + 실제 LLM |
| TUI 시나리오 | `e2e/tui-scenario.test.js` | 실제 서버 + 실제 LLM, 사용자 시나리오 |

## Mock 테스트

`npm test`로 실행되는 테스트는 모두 mock LLM 사용. 외부 API 키 불필요.

## Live 테스트

실제 서버 + 실제 LLM이 필요. 서버를 먼저 실행해야 한다.

```bash
npm start                                                    # 서버 먼저
node test/e2e/tui-live.test.js [--url http://...] [--username X] [--password X]
node test/e2e/tui-scenario.test.js [--url http://...] [--username X] [--password X]
```

### tui-live.test.js — 기능 검증 (15개)

개별 기능 단위: 초기 UI, LLM 응답, 도구 실행, 슬래시 커맨드, 히스토리, 세션 관리.

### tui-scenario.test.js — 시나리오 검증 (40+개)

연속된 사용자 흐름:

| 단계 | 시나리오 |
|------|----------|
| 1단 | 멀티턴 맥락, 도구 연쇄, /clear, 디렉토리 탐색, 계산 연쇄 |
| 2단 | 다중 파일 비교, 조건 분기, 4턴 체인, 도구+판단, 커맨드 혼합 |
| 3단 | 에러 복구, 6턴 맥락, 도구 3턴 연쇄, /clear+도구, 커맨드↔대화 교차 |
| 4단 | streaming, 멀티 이터레이션, approve, cancel, 세션 전환 |

### live-helpers.js — 공용 인프라

`connect()`, `setup()`, `sendAndWait()`, `waitIdle()`, `typeInput()` 등 live 테스트 공통 유틸.

## --no-network

`listen()` 권한이 없는 환경(sandbox/CI)에서 네트워크 테스트를 건너뜀.
해당 테스트 목록은 `test/run.js`의 `NETWORK_TESTS` Set 참조.
