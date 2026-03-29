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

## 모나드 역할 경계 (강제 규칙)

각 모나드는 하나의 관심사만 담당한다. 역할을 혼용하지 않는다.

| 모나드 | 역할 | 사용처 | 금지 |
|--------|------|--------|------|
| **Reader** | 의존성 전파 | factory의 deps 합성·전달 | 상태 변경, 부수 출력 |
| **Writer** | 관찰 정보 축적 | trace, audit log append | 의존성 주입, 상태 변경 |
| **State** | 순수 설정/빌더 | config merge 파이프라인 | 비동기 효과, 리액티브 hooks |
| **StateT(Task)** | 턴 실행 상태 + 비동기 | Free 인터프리터 상태 스레딩 | 의존성 주입, 관찰 축적 |
| **Either** | 동기 에러 분기 | 검증, 파싱, 분기 | 비동기, 상태 |
| **Task** | 비동기 실행 | 지연 실행, 합성 async | 상태 스레딩 |

### 의존성 주입: Reader만 사용

```javascript
// ✅ Reader.asks로 deps 추출
const handler = Reader.asks(({ tokenService, userStore }) => (req, res) => { ... })

// ❌ 클로저 DI 신규 작성 금지
const createHandler = (tokenService, userStore) => (req, res) => { ... }
```

- 모든 factory는 `xR = Reader.asks(...)` 패턴
- 레거시 브릿지: `const createX = (deps) => xR.run(deps)` — 단일 라인 위임만 허용
- 신규 클로저 DI(`const createX = (deps) => { ... }`) 작성 금지

### 상태 전파: StateT 또는 State.modify만 사용

```javascript
// ✅ State.modify chain
const merged = buildConfig([layer1, layer2]).run(DEFAULTS)[0]

// ❌ 중첩 호출, 직접 변이
const merged = mergeConfig(mergeConfig(base, a), b)
obj.history.push(entry)
```

### 관찰 축적: Writer.tell만 사용

```javascript
// ✅ Writer.tell로 append
traceWriter = traceWriter.chain(() => Writer.tell([entry]))

// ❌ 가변 배열 push
trace.push(entry)
trace.length = 0
```

### 횡단 관심사 체크리스트

새 기능 구현 시 반드시 확인:
- 쿠키/인증: 이 변경이 WS, API, 브라우저 모든 경로에서 동작하는가?
- 상태 초기화: 비동기 상태 변경이 렌더링 순서에 영향을 주는가?
- 토큰: refresh rotation이 다른 클라이언트/테스트에 영향을 주는가?

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
├── orchestrator/        ← @presence/orchestrator
│   └── src/orchestrator/
│       ├── index.js          ← instances.json → N개 서버 fork + 관리 API
│       └── child-manager.js  ← 자식 프로세스 fork, 감시, 자동 재시작
├── server/              ← @presence/server
│   └── src/server/      ← Express + WebSocket 서버 (인스턴스 1개)
├── tui/                 ← @presence/tui
│   └── src/
│       ├── ui/          ← Ink 컴포넌트 (App, StatusBar, ChatArea, InputBar 등)
│       └── main.js      ← 클라이언트 설정 로드 + 원격 접속
└── web/                 ← @presence/web
    └── src/             ← React 웹 클라이언트
```

## 설정 파일 구조 (멀티-인스턴스)

```
~/.presence/
├── server.json              ← 공통 서버 설정 (모든 인스턴스의 base)
├── instances.json           ← compose 파일: 인스턴스 목록 + 포트 (필수)
├── instances/
│   ├── anthony.json         ← 인스턴스별 override (LLM, 메모리, locale 등)
│   └── team-backend.json
└── clients/
    ├── anthony.json         ← 클라이언트 접속 설정 (서버 URL)
    └── team-backend.json
```

설정 머지 체인: `DEFAULTS → server.json → instances/{id}.json → 환경변수`

### 아키텍처

```
오케스트레이터 :3010 (프로세스 매니저 + 관리 API)
  ├── fork @presence/server (anthony)    :3001  ← 클라이언트/A2A 직접 접속
  ├── fork @presence/server (team-be)    :3002  ← 클라이언트/A2A 직접 접속
  └── 관리 API: GET/POST /api/instances
```

- 인스턴스당 별도 프로세스 (스케줄러 경합 방지, 장애 격리)
- 게이트웨이 없음 — 클라이언트/A2A 모두 인스턴스에 직접 접속
- `PRESENCE_INSTANCE_ID` 환경변수로 인스턴스 식별

### 인증

- **Password + JWT**: bcrypt 해시 + HMAC-SHA256 JWT (node:crypto)
- 인스턴스별 독립 사용자/시크릿 (`instances/{id}.users.json`, `instances/{id}.secret.json`)
- Access token (15분) + Refresh token (7일, HttpOnly 쿠키, rotation)
- `POST /api/auth/login`, `/api/auth/refresh`, `/api/auth/logout`
- TUI: `--instance` → 비밀번호 프롬프트 → JWT 메모리 저장
- Web: 로그인 폼 → access token 메모리, refresh token HttpOnly 쿠키
- 사용자 관리: `npm run user -- init/add/remove/list/passwd --instance <id>`

## 실행

```bash
# 최초 설정: 인스턴스별 사용자 등록 (필수, 사용자 없으면 서버 시작 불가)
npm run user -- init --instance anthony

# 오케스트레이터 시작 (instances.json의 모든 인스턴스 fork)
npm start

# TUI 클라이언트 (비밀번호 프롬프트 → 로그인)
npm run start:cli -- --instance anthony

# 사용자 관리
npm run user -- add --instance anthony --username bob
npm run user -- list --instance anthony
npm run user -- passwd --instance anthony --username bob
```

## 테스트

```bash
# 전체 테스트 (Node.js + Playwright 브라우저 E2E 포함)
npm test
# 또는
node test/run.js

# 개별 파일
node test/core/agent.test.js
node test/infra/config.test.js
```

### 테스트 계층

| 계층 | 파일 | 특징 |
|------|------|------|
| 워크스페이스 smoke | `test/workspace/smoke.test.js` | npm 워크스페이스 import map 검증 (가장 먼저 실행) |
| 단위/통합 | `test/core/`, `test/infra/`, `test/ui/` 등 | mock 인터프리터, mock LLM |
| 서버 E2E | `test/e2e/server-e2e.test.js` | Express + mock LLM, HTTP 직접 검증 |
| TUI E2E | `test/e2e/tui-e2e.test.js` | ink-testing-library + 실제 서버(mock LLM) |
| 오케스트레이터 E2E | `test/orchestrator/orchestrator-e2e.test.js` | 실제 fork + 관리 API + 인스턴스 접속 (mock LLM) |
| 브라우저 E2E | `web/e2e/chat.spec.js` | Playwright + 실제 서버(mock LLM) |

> 위 테스트는 모두 mock LLM을 사용하므로 외부 API 키 불필요.
> `node test/run.js`가 Node.js 테스트 + Playwright 테스트를 모두 실행합니다.

### 실제 LLM E2E (live 테스트)

설정된 LLM으로 실제 동작을 검증합니다. 오케스트레이터를 먼저 실행해야 합니다.

```bash
# 오케스트레이터 시작 (instances.json에 2개 이상 인스턴스 필요)
npm start

# 멀티-인스턴스 live E2E (별도 터미널, 25개 시나리오 86 assertions)
node test/e2e/multi-instance-live.test.js [--orchestrator http://127.0.0.1:3010]

# TUI live E2E (단일 인스턴스 대상)
node test/e2e/tui-live.test.js [--url http://127.0.0.1:3001]

# 브라우저 live E2E
cd packages/web && npx playwright test --config=playwright.live.config.js
```

### --no-network 플래그

샌드박스·CI 등 `listen()` 권한이 제한된 환경(EPERM)에서는 네트워크 바인딩이 필요한
테스트 11개를 건너뜁니다.

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
| `test/orchestrator/orchestrator-e2e.test.js` | 오케스트레이터 + 서버 fork |

> 이 테스트들은 외부 서비스가 아닌 localhost 포트를 점유하므로, 코드 자체의 문제가
> 아니라 실행 환경의 네트워크 바인딩 권한 부족일 때만 실패합니다.

## 주의사항

- AgentOp ADT의 `map`은 data가 아닌 continuation(next)에 적용해야 함 (docs/architecture.md의 Op 설계 참조)
- 인터프리터는 효과 실행 후 `op.next(result)`로 다음 Free step 반환
- `Free.runWithTask(interpreter)(program)`으로 프로그램 실행
- 정책 상수(max history, compaction threshold 등)는 `packages/core/src/core/policies.js`에 통합 — 파일별 로컬 상수 금지
- MemoryGraph 내부 상태(`store.data.nodes/edges`)는 외부에서 직접 변경 금지 — `removeNodes(predicate)` 등 메서드 사용
