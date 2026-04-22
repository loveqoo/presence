# Agent Identity Model — 에이전트 정체성 + governance

**Status**: 2026-04-21 v5 (경로 B — 필수 3 반영 후 구현 착수). plan-reviewer v4 이 `needs-attention` 판정 — 필수 3 결정 반영, 관찰 7 은 구현 단계 재검토 대상으로 §14 에 기록.
**Owner**: Presence core.
**관련 문서**: [`platform.md`](platform.md) (북극성), [`a2a-authorization.md`](a2a-authorization.md) (이 문서 확정 후 재설계), [`../completed.md`](../completed.md).

---

## 0. 이 문서의 이유

a2a-authorization v1~v4 가 반복 no-ship 판정된 근본 원인은 **"에이전트가 코드상 무엇인가" 의 공백**. 이 문서는 그 공백을 닫고, 사용자 governance 모델 (admin agent + user quota) 을 identity 층에 통합한다. 확정 후 authz v5 재작성의 토대.

---

## 1. 현재 코드 실태 (사실관계만)

| 질문 | 현재 코드 |
|---|---|
| Agent 식별자 | `AgentRegistry` entry 의 `name: string`. 단순 문자열 |
| Session → agent 연결 | `Session.agentId` **없음**. 세션 ID 문자열에 인코딩 (`agent-{name}`) |
| Qualified form | 없음 |
| Agent Card | 선언만 — 미사용 |
| Persona ↔ Agent | 독립. UserContext.persona 는 인스턴스 속성 |
| `capabilities` 필드 | 선언만. enforcement 없음 |
| `/a2a/*` 라우트 | 미구현 |
| 관리자 개념 | 없음 |
| Quota | 없음 |

---

## 2. 핵심 결정 요약

| 결정 | 내용 |
|---|---|
| **Agent = persona 로 정의된 실체** | identity / persona / execution ownership 을 한 객체에 합침 (§3.5 주의) |
| **Admin agent** (서버 공통 1개) | Reserved username `admin`. Agent ID `admin/manager`. 서버 첫 부팅 시 bootstrap 상태기계 (§7.3) |
| **User agent** | `{username}/{agentName}`. Kebab-case validator 단일 함수 (§3.2) |
| **계정 생성** | `npm run user -- init` 시 기본 페르소나의 user agent 1개 자동 (`{username}/default`) |
| **추가 user agent** | admin agent 경유. `maxAgentsPerUser` quota 기반 async 승인. 초과 시 pending (§8) |
| **Admin 본인 quota** | **면제** (§9.3) — governance 목적은 non-admin user 제한. Admin 은 리소스 배분자 |
| **Session 에 agentId 필수** | 모든 세션 (user/scheduled/agent) 이 agent 를 가짐 |
| **Persona 는 agent 가 포함** | UserContext.persona → agent.persona 로 이관 |
| **Agent 삭제 v1** | **Soft delete only** — `archived: true`. 의미: 새 session/delegate 만 차단. 기존 session 은 끝까지 정상 실행 (§5.4) |
| **`userAgentCount` 캐시 제거** | quota 체크 시 user config 의 `agents[].filter(!archived).length` 로 매번 계산 |
| **Agent 실행 진입점 5 곳 명시** | 모두 `canAccessAgent` 의무 호출 (§9.4) — `/api/sessions/*`, `/a2a/*`, WebSocket, scheduler job, `Op.Delegate` |
| **Pending 승인 idempotent replay** | config = 권위, pending 파일 = 요청. 재실행 시 config 확인 후 skip (§8.3.5) |
| **A2A 활성화 옵션** | `config.a2a.enabled` (기본 false). false 면 publicUrl / self card 불요 (§11.1) |
| **Op.Delegate qualifier 파싱** | target 에 `/` 있으면 절대 agentId, 없으면 current user qualify. Reserved username 은 무조건 절대 (§3.6) |

---

## 3. Agent ID — Canonical Form + Validator

### 3.1 형식

```
{username}/{agentName}
```

예: `admin/manager`, `anthony/default`, `anthony/daily-report`

### 3.2 Validator — 단일 함수가 truth

문서상 regex 는 보조. **실제 검증은 `validateAgentNamePart(name): Either<Error, string>` 함수가 유일 진실**. 모든 진입점 (CLI / 서버 / migration) 이 이 함수를 공유.

```js
// packages/core/src/core/agent-id.js
const AGENT_NAME_REGEX = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$|^[a-z]$/
// ^ 첫 글자 소문자 / 끝 글자 소문자 또는 숫자 / 길이 1~63

const RESERVED_USERNAMES = Object.freeze(['admin'])

export const validateAgentNamePart = (name) => {
  if (typeof name !== 'string')           return Either.Left('name must be string')
  if (name.length < 1 || name.length > 63) return Either.Left('length 1~63')
  if (!AGENT_NAME_REGEX.test(name))        return Either.Left('kebab-case only, no trailing hyphen, no leading digit')
  if (name.includes('--'))                 return Either.Left('no consecutive hyphens')
  return Either.Right(name)
}

export const validateAgentId = (id) => {
  const parts = id.split('/')
  if (parts.length !== 2) return Either.Left('must be {username}/{agentName}')
  const [u, a] = parts
  return Either.flatMap(validateAgentNamePart(u), _u =>
         Either.flatMap(validateAgentNamePart(a), _a =>
         Either.Right(`${_u}/${_a}`)))
}

export const isReservedUsername = (u) => RESERVED_USERNAMES.includes(u)
```

**테스트 케이스** (모두 `agent-id.test.js` 에 포함):

| 입력 | 결과 |
|---|---|
| `anthony/default` | Right |
| `a/b` | Right |
| `anthony/daily-report` | Right |
| `anthony/abc-` | Left (끝 하이픈) |
| `anthony/-abc` | Left (시작 하이픈) |
| `anthony/a--b` | Left (연속 하이픈) |
| `Anthony/default` | Left (대문자) |
| `3bot/default` | Left (숫자 시작) |
| `anthony` | Left (슬래시 없음) |
| `a/b/c` | Left (슬래시 2 개) |
| `a_b/default` | Left (언더바) |

### 3.3 외부 peer 식별

외부 server 의 agent card 는 자신의 qualified ID 를 `x-presence.agentId` 에 담음. 같은 문자열 공간이지만 **server scope 다름** → authz 에서 Cedar entity type 로 구분. 상세는 authz 문서.

### 3.4 Identity / Persona / Execution 분리 — v1 struct 경계

Agent 는 세 가지를 합친 객체이지만, 각 측면은 다른 수준. **v1 에서도 struct 경계는 분리**:

| 측면 | 의미 | 수정 주체 | v1 표현 |
|---|---|---|---|
| Identity | agentId (`username/name`) | 생성 시 확정. 이후 불변 | `AgentId` type alias + `validateAgentId` |
| Persona | system prompt / tools / model | 유저 (admin 정책 허용 범위 내) | `Persona` interface (`{ systemPrompt, tools, model }`) |
| Execution ownership | 누가 실행 권한을 가지는가 | username 기반 (filesystem + JWT) | `canAccessAgent(jwtSub, agentId)` 함수 |

조기 분리 이유: ownership 판정이 agentId prefix 에 박혀있지 않고 **함수 경유**. 이후 persona 공유 / agent transfer / 공동 관리 같은 요구가 와도 struct 재편 없이 함수만 바꾸면 됨.

### 3.5 AgentId type 정의

```js
// packages/core/src/core/agent-id.js
// 의미적으로 AgentId 는 string 이지만 타입 경계를 주기 위해 alias
export type AgentId = string & { readonly __brand: 'AgentId' }

// factory — 유효한 AgentId 만 생산 (validation 필수)
export const makeAgentId = (s) => validateAgentId(s)
  .map(valid => valid)   // AgentId 로 type-narrowed
```

### 3.6 Op.Delegate qualifier 파싱 규칙

`Op.Delegate({ target, task })` 의 target 해석:

| 입력 | 해석 |
|---|---|
| `"summarizer"` (slash 없음) | `{currentUserId}/summarizer` 로 qualify (current session 의 username 기준) |
| `"anthony/summarizer"` (slash 있음) | 절대 agentId. 그대로 사용 |
| `"admin/manager"` | **항상 절대** — reserved username 은 qualifier 해석 대상 아님 |
| `"user1/agent/extra"` (slash 2 개+) | validation 에러 |

**계층 책임 분리**:
- **Parser** (`core/op.js`): target 문자열 그대로 보존
- **Resolver** (`interpreter/delegate.js` 또는 신규 `resolver.js`): 파싱 + qualifier 적용 + `validateAgentId`
- **Authz** (`canAccessAgent`): resolver 결과 기반으로 권한 판정

셋이 **순서대로** 호출. 중간 단계 우회 금지.

---

## 4. 계층 구조

```
[서버]
│
├─ admin/manager  (1 개, server-singleton)     ← admin username 계정만 접근
│    │
│    ├─ 책임:
│    │    · maxAgentsPerUser 정책 보유
│    │    · user agent 생성 요청 심사 (자동 + 수동)
│    │    · pending queue 관리
│    │
│    └─ Bootstrap: §7.3 상태기계
│
└─ users[]
     │
     ├─ anthony (role: 'user')
     │    ├─ anthony/default          (계정 생성 시 자동)
     │    └─ anthony/daily-report     (추가 — admin 승인)
     │
     └─ admin (role: 'admin')
          ├─ admin/manager            (관리자 에이전트 — bootstrap)
          └─ admin/personal           (admin 개인용 — quota 면제)
```

---

## 5. Session ↔ Agent 관계

### 5.1 모든 세션에 agentId 필수

```js
{
  id: string,
  type: 'user' | 'scheduled' | 'agent',
  userId: string,
  agentId: string,       // NEW — '{username}/{agentName}'. 생성 후 불변
  workingDir: string,
  ...
}
```

### 5.2 세션 종류별 agentId 결정

| 세션 종류 | agentId |
|---|---|
| 유저가 TUI 로 접속한 대화 세션 | `config.primaryAgentId` (기본 `{username}/default`) |
| `Op.Delegate` invoke 된 세션 | target agent 의 agentId |
| Scheduler 가 생성한 job 세션 | job 의 `owner_agent_id` |
| Admin 이 TUI 로 접속 | `admin/manager` (admin 기본 primary) |

### 5.3 `primaryAgentId` 변경

```bash
npm run user -- agent set-primary --username anthony --name daily-report
```

### 5.4 Agent 삭제 (v1 soft-delete only) — 운영 의미 명시

- **Hard delete 불가** (v1)
- User agent 는 `archived: true` 로 마킹. config.agents 에 유지
- `admin/manager` 는 archive 도 불가 (서버 불변식)

**"Archived" 의 운영 의미 (선택지 중 B 채택)** — 새 것만 차단, 기존은 정상:

**"Existing session" 판정 기준**: `session.createdAt < agent.archivedAt`. Agent 에 `archivedAt: ISO timestamp` 필드를 추가 (archive 시 기록). Session 의 `createdAt` 은 기존 필드 — 서버 재시작 후 persistence 에서 복원되어도 유지되므로 자연스럽게 existing 판정. 진행 중 긴 turn 은 그 session 의 continuation → 동일 intent 처리.

```js
const isExistingSession = (session, agent) =>
  agent.archivedAt && session.createdAt < agent.archivedAt
```


| 행위 | archived agent |
|---|---|
| 새 TUI 대화 세션 생성 (이 agent 로) | ❌ 차단 |
| `Op.Delegate` 로 타 session 에서 이 agent 호출 | ❌ 차단 |
| Scheduler 가 이 agent 로 새 job 실행 | ❌ 차단 |
| **기존 live session 의 계속 실행** (이미 열려있는 대화) | ✅ 정상 진행 (끝까지 실행) |
| **기존 session 의 history 읽기** | ✅ 허용 (과거 기록 확인 필요) |
| **기존 session 의 memory 읽기** | ✅ 허용 |
| **기존 session 의 memory 쓰기** (계속 실행 중 축적) | ✅ 허용 (실행 중 자연스러운 I/O) |

이유: archive 는 "이 agent 는 더 이상 **새 일을 받지 않음**" 의미. UX 파괴 없이 graceful retire. 유저가 기존 작업을 마무리할 수 있음.

**구현 지점**: `canAccessAgent` 에서 `archived` 체크 — **새 session/delegate/job 경로에서만** 거부. 기존 session 의 Op 실행 경로에서는 archived 체크 skip.

실제 "즉시 전면 중단" 이 필요한 사례가 나오면 v2 에서 "force archive" 로 분리 설계.

---

## 6. Persona ↔ Agent 결합

### 6.1 Persona 는 agent 의 필드

```json
{
  "username": "anthony",
  "role": "user",
  "primaryAgentId": "anthony/default",
  "agents": [
    {
      "name": "default",
      "persona": { "tools": ["*"], "systemPrompt": "..." },
      "workingDir": "...",
      "model": "...",
      "createdAt": "2026-04-21T...",
      "createdBy": "admin/manager",
      "archived": false,
      "archivedAt": null
    }
  ]
}
```

### 6.2 기본 페르소나 번들

`packages/infra/src/infra/persona/defaults/default-persona.json` — 일반 사용자용.
`packages/infra/src/infra/persona/defaults/admin-persona.json` — 관리자용 (§9).

---

## 7. 계정 + Agent 생성 흐름

### 7.1 Trust domain 분리

**OS-level admin** (파일시스템 쓰기 권한 + `npm run user -- *` 실행 가능) 과 **in-app admin** (username 이 `admin` 인 계정) 은 **별개**.

- OS admin = 서버를 운영하는 호스트 사용자. `npm run user -- init` / `agent add` 실행. 서버 프로세스 구동
- in-app admin = presence 에 로그인하는 계정. `admin/manager` agent 에 접근
- 대부분의 배포에서 둘이 같은 사람이지만 개념적으로 분리

### 7.2 CLI — `npm run user -- init` (OS 권한)

```bash
$ npm run user -- init --username anthony
유저 이름: anthony
에이전트 이름 [default]:
  > (엔터)
페르소나:
  1) 기본 페르소나  2) 파일  3) 에디터
  > 1
초기 비밀번호: ****
Created user 'anthony' with agent 'anthony/default'
```

**Atomicity**: CLI 는 tmp 디렉토리에 모두 작성 후 atomic rename. 중간 실패 시 사용자 config 파일 미생성 → 재실행 가능.

### 7.3 Admin Bootstrap — 상태기계 (블로커 #1 해결)

서버 부팅 시마다 다음 상태기계 실행. 각 단계 **idempotent**. 실패 시 서버 부팅 거부 + 명시 에러 + 복구 지침.

```
State 0: 초기
    ↓ admin config 존재?
    │     ├─ YES → State 1
    │     └─ NO  → create_admin_config()
    │                ├─ tmp dir 에 admin config 작성
    │                ├─ atomic rename
    │                ├─ 실패 시: 서버 부팅 거부
    │                └─ 성공 → State 1
State 1: admin 계정 있음
    ↓ admin/manager agent 등록?
    │     ├─ YES → State 2
    │     └─ NO  → register_admin_manager()
    │                ├─ admin/manager 를 config.agents 에 append
    │                ├─ persona = admin-persona.json
    │                └─ 성공 → State 2
State 2: admin/manager 존재
    ↓ agent-policies.json 존재?
    │     ├─ YES → State 3 (운영 가능)
    │     └─ NO  → create_policies()
    │                ├─ 기본 정책 작성 (maxAgentsPerUser: 5)
    │                └─ 성공 → State 3
State 3: 운영 가능
```

**재진입**: 각 단계 파일 존재 검사로 skip. 이미 완료된 단계 중복 실행 X.

**부분 실패**: State 1 까지 성공 + State 2 실패 → admin 계정 있지만 agent 없음. 다음 부팅 시 State 1 에서 재진입 → register_admin_manager 만 재실행.

**First boot 비밀번호 출력**: State 0 에서 admin 생성 시 랜덤 초기 비밀번호 생성 → 콘솔 + `~/.presence/admin-initial-password.txt` 양쪽 출력. 파일은 admin 첫 로그인 후 자동 삭제.

### 7.4 추가 agent 생성 — `npm run user -- agent add` (OS 권한, in-app admin 정책 적용)

```bash
$ npm run user -- agent add --username anthony --name daily-report --persona-file ./report.json
Requesting approval from admin/manager ...
  ✓ auto-approved (current: 1/5)
Created agent 'anthony/daily-report'
```

Quota 초과 시:
```
  ✗ quota exceeded (5/5)
    Request queued: ~/.presence/users/admin/pending/req-abc123.json
    Admin must review at: admin's TUI → /requests
```

---

## 8. Governance — Quota 기반 승인

### 8.1 `agent-policies.json` 구조 (블로커 #2 해결)

```json
// ~/.presence/users/admin/agent-policies.json
{
  "maxAgentsPerUser": 5,
  "autoApproveUnderQuota": true
}
```

**`userAgentCount` 필드 제거**. quota 체크는 매번 재계산:

```js
const getActiveAgentCount = (username) => {
  const config = loadUserConfig(username)
  return config.agents.filter(a => !a.archived).length
}
```

- 단일 진실원: user config 의 `agents[]`
- O(N) per check. N 은 유저당 agent 수 (최대 quota 근처) → 상수 시간
- CLI 직접 편집 / 부분 실패 시에도 drift 불가 (재계산이므로)

### 8.2 Pending queue — 요청당 별도 파일 (블로커 리팩토링 #7 해결)

```
~/.presence/users/admin/
├─ agent-policies.json
├─ pending/
│   ├─ req-abc123.json
│   └─ req-def456.json
├─ approved/                   ← approve 시 이동
└─ rejected/                   ← deny 시 이동
```

요청 파일 예:
```json
// pending/req-abc123.json
{
  "id": "req-abc123",
  "requester": "anthony",
  "agentName": "investigator",
  "persona": { ... },
  "submittedAt": "...",
  "status": "pending"
}
```

- Append / approve / deny 모두 **파일 단위 atomic** (create / rename)
- 동시 CLI 실행 시 파일명 기반 → 충돌 없음
- 정책 파일 (agent-policies.json) 과 큐는 **분리 디렉토리**. 정책 변경이 큐 lifecycle 과 무관

### 8.3 승인 플로우 + idempotent replay

```
유저가 'agent add' 실행
  ↓
CLI 가 agent-policies.json 읽음
  ↓
getActiveAgentCount(username) < maxAgentsPerUser ?
  │
  ├─ YES + autoApproveUnderQuota=true
  │    → 즉시 생성. user config 에 append (atomic write)
  │
  └─ NO 또는 autoApproveUnderQuota=false
       → pending/{reqId}.json 작성
       → admin 이 검토 후 approve/deny
       → approve 시: user config append + pending→approved 이동
       → deny 시: pending→rejected 이동
```

### 8.3.5 다중 파일 일관성 — idempotent replay (리뷰 #2 해결)

**문제**: approve 는 두 단계 — (1) user config append, (2) pending→approved 이동. 중간 실패 시 "config 반영됨 + 파일은 pending 잔존" 불일치.

**해법**: **config = 권위. pending 은 단순 요청 큐. 재처리 safe**

```js
// approve handler
const approve = (reqId) => {
  const req = readPending(reqId)
  const config = loadUserConfig(req.requester)

  // (1) Idempotency 체크 — 이미 반영되어 있으면 skip
  if (config.agents.some(a => a.name === req.agentName && !a.archived)) {
    movePendingToApproved(reqId)   // 파일만 정리
    return { ok: true, status: 'already_applied' }
  }

  // (2) config 에 반영 (atomic write)
  config.agents.push({ name: req.agentName, persona: req.persona, ... })
  saveUserConfig(config)

  // (3) 파일 이동 — 실패해도 재실행 시 (1) 에서 skip
  try { movePendingToApproved(reqId) } catch { /* 다음 실행에서 복구 */ }
}
```

- **재실행 안전**: 중간 실패 후 `presence agent approve --id X` 재실행 시 step (1) 에서 이미 반영 감지 → 파일만 정리
- **고아 pending 파일**: config 에 이미 있는 agent 에 해당하는 pending → 정기적 cleanup CLI (`presence agent cleanup`)
- **중복 승인 방지**: config append 전에 `agents.some` 체크 → 동일 agentName + !archived 가 있으면 skip

Config 이 항상 진실. Pending 파일은 보조적.

### 8.4 관리자 CLI

```bash
npm run user -- agent review                       # pending 목록
npm run user -- agent approve --id req-abc123
npm run user -- agent deny --id req-abc123 --reason "over-quota"
```

### 8.5 Cedar 와의 관계

이 승인 로직이 **첫 실질 authz 사용처**. `Action::"create_agent"` 을 Cedar 로 평가:

```cedar
permit (principal, action == Action::"create_agent", resource)
when { context.currentCount < context.maxAgentsPerUser };
```

상세는 a2a-authorization v5.

---

## 9. Admin Agent

### 9.1 특성

| 속성 | 값 |
|---|---|
| Username | `admin` (reserved) |
| Agent ID | `admin/manager` (bootstrap 자동) |
| 접근 권한 | `admin` 계정으로 로그인한 JWT 만 |
| 생성 시점 | 서버 부팅 시 bootstrap 상태기계 (§7.3) |
| Persona | `admin-persona.json` |
| Archive 가능? | 불가 (서버 불변식) |

### 9.2 기능 (v1)

- User agent 생성 요청 심사
- Quota 정책 관리
- Pending / approved / rejected 검토

향후: 서버 전역 설정 (MCP registry, 기본 모델 등).

### 9.3 Admin 본인의 quota (블로커 리팩토링 #6 해결)

**Admin 은 quota 면제**. 이유:
- Governance 목적 = "non-admin user 의 리소스 사용 제한"
- Admin 은 리소스 배분 주체. 자기 자신을 심사하는 구조적 모순 회피
- 실제 차이: `role === 'admin'` 이면 quota 체크 스킵

```js
if (userRole === 'admin') return { allowed: true, reason: 'admin exempt' }
```

단, 악의적 admin 방지를 위한 **하드 상한** 은 있음: 환경 변수 `PRESENCE_ADMIN_AGENT_HARD_LIMIT` (기본 50).

### 9.3.5 Admin singleton session — 동시 승인 race 차단 (v5)

v1 은 **admin 계정 단일 session 강제**. Admin 이 TUI 로 접속할 때 기존 admin session 이 이미 있으면 신규 접속 거부 (exclusive).

- 이유: §8.3.5 의 idempotent replay 는 crash recovery 에는 충분하나 **concurrent approve race** (두 admin 세션 동시) 를 막지 못함. Singleton session 이 이 race 자체를 제거
- 구현: `canAccessAgent({ agentId: 'admin/manager', intent: 'new-session' })` 호출 시 기존 active session 확인 → 있으면 deny
- Admin 이 실수로 두 터미널에서 접속 시: 두 번째 접속에서 "기존 세션이 있습니다. /force-takeover 로 강제 탈취" 메시지. 수동 takeover 만 허용 (race 아닌 명시적 전환)

이 제약은 **admin 계정만**. 일반 user 는 multi-session 허용.

### 9.4 접근 제한 구현 — 5 진입점 모두 필수 (리뷰 #4 해결)

**단일 함수 `canAccessAgent(caller, agentId, intent)`** 가 유일 truth.

```js
// packages/infra/src/authz/agent-access.js
const canAccessAgent = ({ jwtSub, agentId, intent }) => {
  // intent: 'new-session' | 'continue-session' | 'delegate' | 'scheduled-run'

  // 1. Reserved (admin/*) 는 JWT sub==='admin' 만
  if (agentId.startsWith('admin/')) {
    if (jwtSub !== 'admin') return { allow: false, reason: 'admin-only' }
  }

  // 2. 일반 agent: username prefix 일치
  if (!agentId.startsWith(`${jwtSub}/`) && !agentId.startsWith('admin/')) {
    return { allow: false, reason: 'not-owner' }
  }

  // 3. Archived agent — 새 사용만 차단. 기존 session 계속은 허용 (§5.4)
  const agent = registry.get(agentId)
  if (agent?.archived && intent !== 'continue-session') {
    return { allow: false, reason: 'archived' }
  }

  return { allow: true }
}
```

**Intent taxonomy 노트**: v1 의 4 intent (`new-session`/`continue-session`/`delegate`/`scheduled-run`) 는 **시작점이지 종결점 아님**. Cedar 정책이 세부 구분을 요구하면 authz v5 에서 추가 (`read-history`/`write-memory`/`tool-call-on-behalf` 등). Identity 문서는 coarse-grained 4 개로 출발.

**의무 호출 진입점 5 곳** (문서 불변식):

| # | 진입점 | 파일:함수 | intent |
|---|---|---|---|
| 1 | HTTP `/api/sessions/*` | `packages/server/src/server/session-api.js` | `'new-session'` 또는 `'continue-session'` |
| 2 | HTTP `/a2a/*` | (신규 authz phase) | `'delegate'` |
| 3 | WebSocket session join | `packages/server/src/server/ws-handler.js` | `'continue-session'` |
| 4 | Scheduler job run | `packages/server/src/server/scheduler-factory.js` | `'scheduled-run'` |
| 5 | `Op.Delegate` interpreter | `packages/infra/src/interpreter/delegate.js` | `'delegate'` |

**불변식 (테스트로 강제)**:
- 5 곳 외에서는 agent execution 진입 금지
- 각 진입점은 실행 **이전** 에 `canAccessAgent` 호출. 결과 `allow=false` 시 즉시 거부
- 통합 테스트 (`test/regression/agent-access-enforcement.test.js`) — 각 진입점이 mock canAccessAgent 를 호출했는지 spy 로 확인

`isAdmin` 플래그 제거. Registry entry 에 권한 필드 없음.

---

## 10. Agent Registry 범위

### 10.1 포함

- 로컬 all agents (admin/manager + 모든 user agents)
- Peer cache (`users/{username}/peers/`)

### 10.2 Entry 스키마

```js
AgentRegistry entry = {
  agentId: string,              // '{username}/{name}' (로컬) 또는 peer x-presence.agentId
  description: string,
  capabilities: string[],       // 선언만
  type: 'local' | 'remote',
  persona?: object,             // 로컬만
  archived?: boolean,           // 로컬 user agent (v1 soft-delete)
  run?: Function,               // 로컬만
  endpoint?: string,            // 원격만
  agentCard?: object,           // 원격만
}
```

**`isAdmin` 필드 제거**. admin 판별은 agentId prefix (`admin/`).

---

## 11. Self Agent Card + `/a2a` 서버 wiring

### 11.1 A2A 활성화 옵션 + Self Agent Card (리뷰 #10 해결)

**`config.a2a.enabled` 플래그** (기본 `false`):

```json
// server config
{
  "a2a": {
    "enabled": false,       // 기본값 — 로컬 dev / 단일 사용자 테스트
    "publicUrl": null       // enabled=true 시 필수
  }
}
```

| `a2a.enabled` | 동작 |
|---|---|
| `false` (기본) | `/a2a/*` 라우트 미등록. self card 미생성. publicUrl 불요. 서버 정상 부팅 |
| `true` | `/a2a/*` 활성. `publicUrl` 필수 — 없으면 부팅 거부 |

**Self Agent Card** (enabled=true 일 때만):

```json
{
  "name": "anthony/daily-report",
  "url": "https://home.anthony.example/a2a/anthony/daily-report",
  "x-presence": {
    "agentId": "anthony/daily-report",
    "publicKey": "-----BEGIN PUBLIC KEY-----...",
    "roles": ["owner"]
  }
}
```

- URL = `config.a2a.publicUrl + '/a2a/' + agentId`
- 각 로컬 agent 마다 1개 self card (로딩 시 자동)

### 11.2 라우트 분리

```js
app.use('/api/auth', publicAuthRouter)
app.use('/api', authMiddleware, protectedApiRouter)    // user JWT
app.use('/a2a', a2aAuthMiddleware, a2aRouter)           // A2A JWT 별도
```

---

## 12. Migration (블로커 원자성 해결)

### 12.1 단계

| 단계 | 내용 | Atomicity 전략 |
|---|---|---|
| **M1** | Session 에 `agentId` 필드 추가 + 기존 sessions 재로딩 시 runtime 주입 | 코드 변경만 |
| **M2** | Admin bootstrap 상태기계 (§7.3) — 서버 부팅 시 자동 | 단계별 idempotent |
| **M3** | 기존 user 각각에 `primaryAgentId` + `{username}/default` agent 자동 추가 | **유저별 파일 단위 atomic** |
| **M4** | UserContext.persona → default agent.persona 로 이관 | M3 와 같은 유저 파일 안에서 수행 (한 번의 atomic write) |
| **M5** | `AgentRegistry` entry `name` → `agentId` rename (로컬 자동 qualifying) | 메모리. 부팅 시 재구축 |
| **M6** | agent-policies.json 생성 (기본값) | 단일 파일 atomic |
| **M7** | JobStore schema migration (`ALTER TABLE` — authz §9) | PRAGMA user_version |
| **M8** | `/a2a` 라우트 + self card 생성 (authz phase) | — |

### 12.2 실패 시 서버 부팅 거부

M2~M6 중 하나라도 실패 시 서버 부팅 실패 + 에러 로그에 복구 지침. 재시작 시 완료된 단계 skip.

```
[ERROR] Migration M4 failed for user 'bob': persona file corrupted
  Fix: Restore ~/.presence/users/bob/config.json from backup,
       or delete persona field to use default.
  Then restart server.
```

### 12.3 기존 설치 부분 완료 처리

| 현재 상태 | 부팅 시 동작 |
|---|---|
| admin 계정 있지만 admin/manager 없음 | M2 의 State 1 → State 2 만 실행 |
| admin 정책 파일 없음 | M6 만 실행 |
| 일부 user 만 `primaryAgentId` 없음 | 해당 user 만 M3 ~ M4 실행 |

### 12.4 롤백

- 각 단계 완료 전 `~/.presence/users/{username}/config.json.backup-preM3` 생성
- Migration 실패 시 사용자가 backup 수동 복원 → 이전 버전 서버 계속 사용 가능
- 롤백 자동화는 v2

---

## 13. 이 문서가 답하지 않는 것 (authz 로 위임)

- CallerIdentity 의 위조 방지 — authz
- JWT claim 구조 / 서명 — authz
- Cedar 정책 파일 합성 — authz
- `Action::"create_agent"` Cedar policy 구체 — authz
- Peer fetching 자동화 — v2
- Agent 간 실질 격리 (tool / memory sandbox) — v2

---

## 14. 미결 / 후속

### 14.1 v2 설계 대기

- Agent hard delete (현재 soft-only)
- **Force archive** — "즉시 전면 중단" 요구 생기면 재설계 (§5.4)
- Multi-admin (현재 admin 1 명)
- Agent rename / transfer / 공동 관리
- Pending queue TTL
- Admin TUI 에서 pending 알림
- Persona 변경 이력
- Quota 초과 시 유저 UX

### 14.2 구현 단계 재검토 필요 (plan-reviewer v4 관찰)

코드 구현 시 재확인할 지점. 문서 선언만 있고 강제 수단이 약한 것들:

1. **`AgentId` branded type 의 JS runtime 무효** — `string & { __brand }` 는 TS 관용. JS ESM 에서는 런타임 효과 없음. 실제 경계는 `makeAgentId` 호출 discipline. 구현 시 factory 경유를 통합 테스트로 강제
2. **Parser → Resolver → Authz 순서 강제 수단** — §3.6 에서 선언만. JS 에서 타입으로 강제 어려움. 각 단계 함수 시그니처 (`UnresolvedTarget` / `ResolvedAgentId` / `AuthorizedExecution`) 을 서로 다른 객체 shape 로 표현하는 게 최소 방어
3. **5 진입점 enforce 가 spy test 만** — 내부 factory (`findOrCreateSession`, `sessions.create`, scheduler dispatch 등) 가 숨은 진입점. 실제 강제 지점은 **session 생성 / agent execution 공통 boundary** 에서 `canAccessAgent` 호출. 바깥 라우트 리뷰는 보조
4. **`a2a.enabled=false` 기본의 의미론 긴장** — "선택 기능" 으로 읽힐 위험. §11.1 에 "노출 surface 만 닫히고 identity 규칙은 동일" 을 명시했으나 구현 시 sanity check
5. **Integration test 가 spy 수준이면 부족** — agentId × intent × archived × cross-user matrix 로 확장. 구현 시 테스트 설계 시점에 matrix 도출 + negative path 포함
6. **Bootstrap rollback 범위** — v2 자동화 전에도 **단계별 복구 가능/불가능 범위** 를 구현 시 표로 정리 (서버 로그에 출력)
7. **First-login password 삭제 시점** — **"비밀번호 변경 성공 직후"** 로 못박음 (authz 와 엇갈리지 않기 위해). 실제 trigger 는 auth handler 의 change-password 성공 경로

### 14.3 세부 미결

- **Reserved username 확장 시 grandfathering** — 현재 v1 은 `['admin']` 하나. 추가 시 기존 유저 충돌 정책 필요

---

## 15. 검증 체크리스트

- ✅ Agent = persona 보유 실체 (§3.5 분리 인식)
- ✅ Kebab-case 단일 validator 함수 (§3.2)
- ✅ Reserved username (`admin`)
- ✅ Admin agent server-singleton + bootstrap 상태기계 (§7.3)
- ✅ User agent quota async 승인 — `userAgentCount` 캐시 제거 (§8.1)
- ✅ Pending 요청당 파일 분리 (§8.2)
- ✅ Admin quota 면제 + hard limit (§9.3)
- ✅ Admin 접근은 agentId prefix + JWT sub check (§9.4)
- ✅ `isAdmin` 플래그 제거
- ✅ Session agentId 필수
- ✅ Persona agent 내부 이관
- ✅ Agent 삭제 v1 soft-only (§5.4)
- ✅ Migration 유저별 atomic + 부분 완료 재진입 (§12)
- ✅ OS admin vs in-app admin 분리 (§7.1)

authz v5 재작성 가능한 토대 확보.

---

## Changelog

- 2026-04-21 v1: `_primary` 예약어 초안
- 2026-04-21 v2: Governance 모델 추가 (admin agent + quota)
- 2026-04-21 v3: plan-reviewer v2 지적 3 블로커 반영 — bootstrap 상태기계 (§7.3), userAgentCount 캐시 제거 (§8.1), agent v1 soft-delete only (§5.4).
- 2026-04-21 v4: plan-reviewer v3 지적 반영:
  - §5.4 soft-delete 운영 의미 명시 (옵션 B — 새 것만 차단, 기존 session 정상)
  - §8.3.5 승인 idempotent replay (config=권위, pending=요청, 재실행 safe)
  - §9.4 5 진입점 목록 + `canAccessAgent(caller, agentId, intent)` 의무 호출 + 통합 테스트
  - §11.1 `config.a2a.enabled` 플래그 (기본 false) — 로컬 dev 부팅 거부 완화
  - §3.4~3.6 AgentId type alias + Persona interface + Op.Delegate qualifier 파싱 규칙
  - §14 v2 미결 목록 확장
- 2026-04-21 v5: plan-reviewer v4 `needs-attention`. 경로 B 선택 — 필수 3 반영 + 관찰 7 을 §14.2 구현 단계 재검토 대상으로 기록:
  - §5.4 existing session 판정 기준 = `session.createdAt < agent.archivedAt`. `archivedAt` 필드 추가
  - §9.3.5 Admin singleton session — concurrent approve race 차단 (admin 계정 단일 session 강제, 수동 takeover 만 허용)
  - §9.4 intent taxonomy 노트 — 4 개는 시작점이지 종결점 아님. 세부는 authz v5 에서 필요 시 추가
  - §14.2 구현 단계 재검토 7 항목 기록
