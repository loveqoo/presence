# CLAUDE.md

## 프로젝트 개요

**presence** — 개인 업무 대리 에이전트 플랫폼. Free Monad 기반 FP 아키텍처.

## 구현 플랜

- `PLAN.md` — TODO + 미착수 Phase + 운영 결정 (현행)
- `docs/architecture.md` — 아키텍처 설계 문서 (Phase 1-6 확정)
- `docs/completed.md` — 완료된 Phase + TODO 이력

## 핵심 의존성

- **fun-fp-js**: `packages/core/src/lib/fun-fp.js`에 복사본 배치. 원본은 `../fun-fp-js/dist/fun-fp.js`.
  - ESM default export: `import fp from '../../lib/fun-fp.js'`
  - 주요 모듈: Free, State, Task, Writer, Reader, Either, Maybe, identity

## 코딩 원칙

- **FP 우선**: 순수 함수, 불변 데이터, 모나딕 합성 선호
- **클래스**: 합리적일 때만 사용 (예: 외부 라이브러리 인터페이스)
- **ESM**: `type: "module"`, import/export 사용
- **테스트 우선**: mock 인터프리터를 먼저 만들어 LLM 없이 테스트 가능하게

## 패키지 구조 (npm workspaces)

```
packages/
├── core/                ← @presence/core
│   └── src/
│       ├── core/
│       │   ├── op.js         ← Agent Op ADT + DSL
│       │   ├── plan.js       ← Plan parser (JSON → Free)
│       │   ├── prompt.js     ← 프롬프트 조립 + budget fitting
│       │   ├── agent.js      ← Incremental Planning Engine + 상태 ADT
│       │   ├── repl.js       ← REPL + slash commands
│       │   └── policies.js   ← 정책 상수 (HISTORY, MEMORY, PROMPT)
│       ├── interpreter/
│       │   ├── test.js       ← Mock 인터프리터
│       │   ├── traced.js     ← 트레이싱 래퍼
│       │   └── dryrun.js     ← Dry-run 인터프리터
│       └── lib/              ← fun-fp.js 벤더 복사본
├── infra/               ← @presence/infra
│   └── src/
│       ├── infra/       ← llm, tools, state, memory, config, persistence 등
│       ├── interpreter/ ← 프로덕션 인터프리터 (prod.js)
│       └── i18n/        ← ko.json, en.json
├── server/              ← @presence/server
│   └── src/server/      ← Express + WebSocket 서버
├── tui/                 ← @presence/tui
│   └── src/
│       ├── ui/          ← Ink 컴포넌트 (App, StatusBar, ChatArea, InputBar 등)
│       └── main.js      ← 조립 (createGlobalContext + createSession + UI 렌더링)
└── web/                 ← @presence/web
    └── src/             ← React 웹 클라이언트
```

## 테스트

```bash
# 전체 테스트 (Node.js + Playwright 브라우저 E2E 포함)
npm test
# 또는
node test/run.js

# 개별 파일
node test/core/agent.test.js
node test/core/plan.test.js
node test/infra/memory.test.js
```

### 테스트 계층

| 계층 | 파일 | 특징 |
|------|------|------|
| 워크스페이스 smoke | `test/workspace/smoke.test.js` | npm 워크스페이스 import map 검증 (가장 먼저 실행) |
| 단위/통합 | `test/core/`, `test/infra/`, `test/ui/` 등 | mock 인터프리터, mock LLM |
| 서버 E2E | `test/e2e/server-e2e.test.js` | Express + mock LLM, HTTP 직접 검증 |
| TUI E2E | `test/e2e/tui-e2e.test.js` | ink-testing-library + 실제 서버(mock LLM) |
| 브라우저 E2E | `web/e2e/chat.spec.js` | Playwright + 실제 서버(mock LLM) |

> 위 테스트는 모두 mock LLM을 사용하므로 외부 API 키 불필요.
> `node test/run.js`가 Node.js 테스트 + Playwright 테스트를 모두 실행합니다.

### 실제 LLM E2E (live 테스트)

설정된 LLM으로 실제 동작을 검증합니다. 서버를 먼저 실행해야 합니다.

```bash
# 서버 시작
node packages/server/src/server/index.js

# TUI live E2E (별도 터미널)
node test/e2e/tui-live.test.js

# 브라우저 live E2E
cd packages/web && npx playwright test --config=playwright.live.config.js
```

### --no-network 플래그

샌드박스·CI 등 `listen()` 권한이 제한된 환경(EPERM)에서는 네트워크 바인딩이 필요한
테스트 10개를 건너뜁니다.

```bash
node test/run.js --no-network
```

건너뛰는 테스트 (HTTP/WebSocket 서버를 직접 생성):

| 파일 | 이유 |
|------|------|
| `test/infra/llm.test.js` | mock LLM HTTP 서버 |
| `test/infra/mcp-sse.test.js` | SSE 서버 |
| `test/infra/remote-state.test.js` | WebSocket 서버 |
| `test/infra/session.test.js` | mock LLM HTTP 서버 |
| `test/infra/supervisor-session.test.js` | mock LLM HTTP 서버 |
| `test/e2e/bootstrap.test.js` | mock LLM HTTP 서버 |
| `test/e2e/server-e2e.test.js` | Express + mock LLM |
| `test/e2e/tui-e2e.test.js` | Express + mock LLM + WebSocket |
| `test/server/server.test.js` | Express 서버 |
| `test/server/supervisor.test.js` | Express 서버 |

> 이 테스트들은 외부 서비스가 아닌 localhost 포트를 점유하므로, 코드 자체의 문제가
> 아니라 실행 환경의 네트워크 바인딩 권한 부족일 때만 실패합니다.

## 주의사항

- AgentOp ADT의 `map`은 data가 아닌 continuation(next)에 적용해야 함 (docs/architecture.md의 Op 설계 참조)
- 인터프리터는 효과 실행 후 `op.next(result)`로 다음 Free step 반환
- `Free.runWithTask(interpreter)(program)`으로 프로그램 실행
- 정책 상수(max history, compaction threshold 등)는 `packages/core/src/core/policies.js`에 통합 — 파일별 로컬 상수 금지
- MemoryGraph 내부 상태(`store.data.nodes/edges`)는 외부에서 직접 변경 금지 — `removeNodes(predicate)` 등 메서드 사용
