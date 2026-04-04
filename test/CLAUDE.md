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
| 단위/통합 | `core/`, `infra/`, `ui/` 등 | mock 인터프리터, mock LLM |
| 서버 E2E | `e2e/server-e2e.test.js` | Express + mock LLM |
| TUI E2E | `e2e/tui-e2e.test.js` | ink-testing-library + 실제 서버(mock LLM) |

모든 테스트는 mock LLM 사용. 외부 API 키 불필요.

## Live 테스트

```bash
npm start                                              # 서버 먼저
node test/e2e/tui-live.test.js [--url http://...]      # 실제 LLM 검증
```

## --no-network

`listen()` 권한이 없는 환경(sandbox/CI)에서 12개 테스트를 건너뜀.
해당 테스트 목록은 `test/run.js`의 `NETWORK_TESTS` Set 참조.
