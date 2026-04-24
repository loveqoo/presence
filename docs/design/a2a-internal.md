# A2A Phase 1 — 내부 에이전트 통신 설계

**Status**: 2026-04-24 v8. S1 + S2 + S3 완료 + v8 네이밍 범용화 착수. 사용자 지적 (2026-04-24) 으로 "TODO" 고정 네이밍을 범용 A2A 프리미티브로 전환 — `Op.SendTodo` → `Op.SendA2aMessage`, `todo_messages` → `a2a_messages`, EVENT_TYPE 도 동일. category 필드로 분류. 다음 단계 S4 (큐 상한 + 재시작 회복).

**Owner**: Presence core.

**관련 문서**:
- [`platform.md`](platform.md) — 북극성
- [`agent-identity-model.md`](agent-identity-model.md) — 에이전트 식별 기반
- [`a2a-transport.md`](a2a-transport.md) — Phase 2 (원격 에이전트 통신) 입력물로 보존
- [`a2a-authorization.md`](a2a-authorization.md) — Cedar 기반 권한 설계 (Phase 1 권한 모델이 의존)
- [`governance-cedar.md`](governance-cedar.md) — 에이전트 생성 권한 (A2A 와 독립)

---

## 0. 이 문서의 이유

A2A 권한 + 전송 설계가 수차례 수렴하지 못한 근본 원인은 **사용 시나리오 없이 인프라부터 설계** 한 것. "Cedar 가 필요하다", "JWT 가 필요하다" 로 시작하면 scope 경계가 없어서 adversarial review 가 매번 새 경계 문제를 찾는다.

사용자 원래 의도는 **"에이전트들이 의견을 주고받고 요청하고 응답하는 관계"** 이며, 가장 확실한 축약형이 **TODO 전달**. 또한 원격 에이전트는 필수가 아니며, 내부 에이전트 디스커버리 + 통신이 먼저.

이 문서는 Phase 1 (내부) 의 시나리오 + 범위를 고정한다. 이 안에서 실제로 뭐가 공유 상태이고 뭐가 인터페이스인지 드러나면, Phase 2 (원격) 는 그 지점을 네트워크로 확장하는 일만 하게 된다.

---

## 1. 범위 경계

### 1.1 Phase 1 에 포함

- 같은 presence 서버 프로세스 안의 에이전트끼리 통신
- 디스커버리: "어떤 에이전트들이 있나" 조회
- 메시지 전달: 일반 A2A 메시지 (요청 + 응답). 현재 구현은 `category='todo'` 만 실 사용하지만 프리미티브는 범용 (v8 재정의)
- 권한: "누가 누구에게 메시지를 보낼 수 있나"
- 생명주기: 대상 에이전트 삭제 / 재시작 / 실패 처리

**프리미티브 범용성 (v8 원칙)**: A2A 메시지 자체는 도메인 불특정. `category` 필드로 분류 (todo/question/report/announcement 등). 특정 category 이름을 Op / 테이블 / Event type 에 고정 금지. UserDataStore 의 `category='todo'` 패턴과 동일한 관점.

### 1.2 Phase 1 에 포함하지 않음

- 네트워크 전송 (HTTP, WebSocket)
- 암호화 / 서명 (RSA, JWT)
- Peer registry (원격 에이전트 카드)
- URL 정규화, aud 바인딩
- 크로스 머신 디스커버리

이 항목들은 모두 `a2a-transport.md` 에 설계 보존되어 있음. Phase 1 에서 드러난 실제 요구에 맞춰 Phase 2 에서 다듬는다.

### 1.3 인접 영역과의 경계

- `agent-identity-model.md` — 에이전트 식별 + 생성 governance. Phase 1 은 이 위에 올라탐
- `governance-cedar.md` — 에이전트 *생성* 권한. Phase 1 의 *호출* 권한과 독립
- `a2a-authorization.md` — Cedar 기반 호출 권한. Phase 1 이 실제 소비처

---

## 2. 사용 시나리오 (TODO 중심)

각 시나리오는 **골든 패스 + 실패 모드** 를 함께 명시한다. 구현 플랜은 이 시나리오를 End-to-End 로 돌려 검증한다.

### S1. 동일 유저 내 단방향 TODO

> anthony 의 `planner` 에이전트가 `search` 에이전트에게 "Cedar 최신 버전 조사" TODO 를 넘긴다.

- 골든: planner 가 TODO 전달 → search 가 받아 작업 수행
- 실패:
  - search 에이전트가 존재하지 않음 → planner 에게 명시적 에러
  - search 가 archived (§agent-identity 5.4) → planner 에게 "대상 없음" 에러
  - search 가 처리 중 실패 → planner 가 알 수 있나? (→ 열린 질문 Q4)

### S2. 동일 유저 내 요청/응답

> planner 가 search 에게 조사 TODO 를 보내고, 결과 메시지를 받는다.

- 골든: planner → (TODO) → search, search → (결과) → planner
- 실패:
  - 결과 반환 전 planner 가 삭제됨 → **Q5 결정**: response 는 DB 에 status='orphaned' 로 남고 logger warn. 운영자가 admin 도구로 조회 가능 (향후). 별도 자동 처리 없음
  - 타임아웃 → **Q6 결정**: 기본 5 분. 송신자가 `timeoutMs` 로 override 가능. 시스템 expire 클럭이 `pending`/`processing` 상태 TODO 를 `expired` 로 전환

### S3. 다자 처리는 기존 `Op.Parallel + Op.Delegate` 로 이미 해결 (v5 재정의)

> planner 가 여러 전문 에이전트에게 일을 분배하고 결과를 모은다.

**2026-04-24 재평가 (사용자 지적)**: 이 시나리오는 이미 `Op.Parallel([Delegate(search, ...), Delegate(writer, ...), Delegate(reviewer, ...)])` 로 처리된다. `packages/core/src/interpreter/parallel.js` 가 `Promise.allSettled` 로 병렬 실행 후 결과 배열을 반환. 동기 집계 + 부분 성공 의미론 (`fulfilled`/`rejected` 항목별 상태) 이 모두 구비되어 있다.

따라서 S3 를 "다자 협업 via TODO" 로 재구성하는 것은 **과공학**. Q7 (부분 성공 의미론) 은 Parallel 인터프리터가 이미 결정 (all-settled, 개별 status 보존) 한 것으로 종결. Q8 (재위임 깊이) 은 Q12 (재귀 TODO 불허) 로 자연 해소 — 깊이 상한 1.

**Op.SendA2aMessage 는 다른 용례**: 유저 대화 흐름에 비동기 메시지를 투입하는 경로 (결과는 SYSTEM entry 로 대화창에 도착, 유저/LLM 이 관찰). "병렬 집계" 가 아닌 "비동기 맥락 투입" 의미론. 두 경로가 공존하되 목적이 다름.

**S3 의 실질 범위**: `list_agents` tool 추가 — planner/유저가 어떤 agent 가 등록되어 있는지 알고 Delegate / SendTodo target 을 선택하는 편의.

### S4. 동일 서버 크로스 유저 TODO — **Phase 1 에서 지원 안 함** (Q1 확정)

> anthony 의 planner 가 bob 의 `calendar` 에이전트에게 TODO 를 넘길 수 있는가?

**결정**: Phase 1 은 **같은 유저 내부만**. 유저 데이터 격리 원칙 (`~/.presence/users/{username}/`) 유지. admin agent 특권도 Phase 1 에 없음 (Q2 자연 해소 — 크로스 유저 경로가 없으므로).

크로스 유저 통신이 필요한 경우 Phase 2 (원격 경유) 로만 가능. 같은 서버라도 Phase 2 에서 처리.

### S5. 대상 에이전트 archive 중 TODO

> planner 가 search 에게 TODO 를 보낸 직후 admin 이 search 를 archive 함.

**Q9 결정** (agent-identity §5.4 연장):
- archive **이후** `pending` (큐 대기) 상태 TODO → 즉시 `failed` 로 전환 + response (`status='failed'`, `error='target-agent-archived'`)
- archive **이후** `processing` (수신 agent 가 picking) 상태 TODO → 끝까지 진행 (기존 session 보존 원칙과 일치)
- archive **이후** 새 TODO 접수 시도 → Cedar 정책 (agent-archived 거부) 에서 반려

### S6. 서버 재시작

> planner 가 TODO 를 보냈는데 서버가 재시작됨.

**Q3 결정**: SQLite 영속화. `~/.presence/users/{u}/memory/a2a-queue.db` (JobStore 와 같은 memory 디렉토리 공용). 재시작 후:
- `pending` 은 재처리 (대상 agent 가 여전히 존재하면 수신 재시도)
- `processing` 은 `failed` 로 전환 (처리 중이던 session 이 유실되었으므로)
- `completed`/`failed`/`expired` 는 이력으로 보관 (cleanup 정책 후속 결정)

### S7. TODO 큐 과부하

> planner 가 search 에게 TODO 수천 개를 폭발적으로 보냄.

**Q10 결정**: agent 당 `pending` 상한 기본 100. 초과 시 즉시 `failed` 로 송신자에게 반환 (`error='queue-full'`). back-pressure 없음 — 송신 agent 가 자체 페이싱 결정. 상한은 `policies.js` 상수로 중앙화.

---

## 3. 디스커버리

### 3.1 무엇을 디스커버리하나

- 같은 유저의 다른 에이전트 목록 (항상 허용)
- 다른 유저의 에이전트 목록: **Phase 1 제외** (Q1 확정)
- 에이전트의 메타데이터: agent ID, persona 요약, capabilities (선언)

### 3.2 어디서 가져오나

- user config (`~/.presence/users/{username}/config.json`) 의 `agents[]` 가 권위
- `archived: true` 는 디스커버리에서 제외
- Admin agent (`admin/manager`) 는 항상 존재

### 3.3 API 형태 (임시)

`Op.DiscoverAgents(scope)` 같은 Op ADT 확장 + 소비는 planner persona 프롬프트 안. 구체 형태는 구현 플랜에서 확정.

---

## 4. 통신 프리미티브

### 4.1 메시지 형태 (v8 — 범용화 반영)

```
A2aMessage = {
  id: string,                    // UUID
  fromAgentId: AgentId,          // 송신자 agent ID (qualified {username}/{agentName})
  toAgentId: AgentId,            // 수신자 agent ID (같은 username 내부만)
  kind: 'request' | 'response',
  category: string,              // 'todo' | 'question' | 'report' | ... (기본 'todo')
  correlationId?: string,        // response 일 때 원 request id
  payload: string,               // 자연어 본문 (request 의 내용 또는 response 의 결과)
  status?: 'completed' | 'failed' | 'expired' | 'orphaned',  // response 전용
  error?: string,                // response.status !== 'completed' 일 때 사유
  createdAt: ISO8601,
  timeoutMs?: number,            // request 전용 (기본 300000 = 5 분)
  processedAt?: number,          // markProcessing 이 기록
}
```

**프리미티브 범용성 (v8 원칙)**:
- A2a 는 agent 간 일반 메시지 프로토콜. `category` 로 분류 (현재 `'todo'` 만 실 사용, 향후 `'question'`/`'report'`/`'announcement'` 등 확장 가능).
- **금지**: 특정 category 이름을 Op / Interpreter / 테이블명 / EVENT_TYPE 에 고정하는 것 (예: `Op.SendTodo`, `todo_messages` 테이블 재도입 금지). 새 category 추가는 schema 변경 없이 payload/`category` 필드로만 진행.

필드 설명:
- `kind: request` = 송신자가 보내는 요청, `kind: response` = 수신자가 돌려주는 응답
- `correlationId` 로 요청-응답 매칭
- `status` + `error` 로 송신자가 실패 사유 확인 가능 (Q4 결정)
- `timeoutMs` 없으면 정책 기본값 (5 분) 적용

### 4.2 수신 session 라우팅 규칙 (v4)

agentId → session 매핑 (M1 단계):

**Request 수신 (S1)** — `findAgentSession(to)`:
- `type === SESSION_TYPE.AGENT` + `session.agentId === to` 인 entry 만 선택.
- **USER/AGENT dual-homed**: 같은 agentId (`{u}/default`) 가 USER session (대화) + AGENT session (delegate 대상) 양쪽에 존재할 수 있다 (`user-migration.js` 가 config.agents 에 default 를 seed → `registerAgentSessions` 가 AGENT session 도 생성).
- AGENT 만 선택 → SendTodo 는 delegate target 경로로만 라우팅. USER session (대화 흐름) 은 교란하지 않음.
- 0 session: `target-not-registered`. N session: `session-routing-ambiguous`.

**Response 송신 (S2)** — `findSenderSession(fromAgentId)` (신규 API):
- `findAgentSession` 과 달리 **USER + AGENT 양쪽** 검색. 우선순위: AGENT 선호 → 없으면 USER fallback.
- 이유: SendTodo 는 UserSession 의 turn 에서도 호출 가능 (유저가 "worker 에게 조사 시켜" 지시). response 가 UserSession 에 돌아가야 유저가 대화창에서 확인 가능.
- 0 session: `orphaned` (sender 부재). N session: `orphaned` (방어적 ambiguous).
- M3 에서 agent 당 복수 AGENT session 이 허용되면 이 규칙 재정의 필요.

### 4.3 전달 방식

- Phase 1 은 **in-process 함수 호출** (네트워크 없음)
- 동기 vs 비동기: A2A 메시지는 본질적으로 비동기. 송신자는 `Op.SendA2aMessage` 호출 직후 결과 객체만 받고, 응답은 별도 이벤트 (S2 `a2a_response`) 로 agent 에게 도달
- Phase 2 에서 원격이 추가되면 in-process 호출이 HTTP/WS 로 바뀌지만 메시지 스키마 + 생명주기 동일 유지

### 4.4 Free Monad 통합 — **새 Op 추가** (Q11 결정) + 반환 계약 (v3)

- 현행 `Op.Delegate(target, payload)` 는 **동기 결과 대기** 의미론 (서브에이전트 실행 후 즉시 결과 반환)
- Phase 1 TODO 는 **비동기 요청/응답** — 의미론 다름
- **결정**: 새 Op 추가.

```
Op.SendA2aMessage(to, payload, { timeoutMs?, category? })
  → { requestId: UUID | null, accepted: boolean, error?: string }
```

`category` 는 도메인 분류 (기본 `'todo'`). 향후 `'question'`/`'report'` 등 확장은 schema 변경 없이 이 필드만 사용.

**requestId 와 accepted 관계** (v3):
- `requestId` = queue 에 row 가 생성되었는지 여부 — 감사 추적 ID. accepted 와 **독립**.
- `accepted=true + requestId≠null` — row 생성 + 수신 enqueue 성공 (정상)
- `accepted=false + requestId=null` — row 생성 전 거부 (validateTarget 실패)
- `accepted=false + requestId≠null` — row 생성 후 failed (archived / enqueue 실패) — 감사용 fail row

**error enum** (관측 계약, 8 종):
- validateTarget 단계 (row 생성 전): `invalid-agent-id`, `ownership-denied`, `target-not-registered`, `session-routing-ambiguous`, `registry-missing`
- row 생성 후 단계: `target-archived`, `target-session-not-found`, `queue-enqueue-failed`
- 신규 error 문자열 추가 시 이 enum 을 먼저 확장 (관측 계약 명시성)

송신 agent 는 requestId 를 받고 턴을 마칠 수 있음. response 는 event queue 를 통해 비동기 수신.
Delegate 와 병행 존재 — 의미론 분리가 장기 유지보수에 유리.

### 4.5 `a2a_response` event 처리 (v8 — S2 rename 반영)

송신 agent 의 EventActor drain 이 `a2a_response` type 을 만나면:
- **turnActor.run 호출하지 않음** (Q15 — 자동 turn 미발행)
- `turnLifecycle.appendSystemEntrySync(state, { content: formatResponseMessage(event), tag: 'a2a-response' })` 로 conversationHistory 에 SYSTEM entry 추가
- `#skipTodoReview` 와 동일 패턴으로 queue 정상 배수 + 다음 drain 재귀

`formatResponseMessage(event)` 형식 (v8):
- `status='completed'`: `"[A2A 응답 from ${fromAgentId}] ${payload}"`
- `status='failed'`: `"[A2A 응답 실패 from ${fromAgentId}] ${error}"`
- `status='expired'`: `"[A2A 응답 타임아웃 from ${fromAgentId}]"`
- `orphaned` 는 sender 에게 event 전달 안 됨 → 이 경로 도달 없음

turnLifecycle 은 EventActor env 에 필수 (SessionActors 가 주입). 미주입 + `a2a_response` = 프로덕션 불변식 위반 → warn 로그 + skip (실제 발생 없음).

**event type 범용성 불변식 (v8)**: `a2a_request` / `a2a_response` 가 프리미티브. 특정 category (todo, question 등) 를 event type 에 반영하지 않음. category 는 메시지 필드로만.

---

## 5. 권한 모델 (v2 확정)

### 5.1 규칙

- 같은 유저 내 agent 간 TODO 허용 (ownership 매치)
- archived agent 수신 TODO 는 거부 (agent-identity §5.4)
- 크로스 유저 메시지는 **Phase 1 에서 Cedar 평가 전에 `Op.SendA2aMessage` 인터프리터가 즉시 차단** (Q1)
- admin agent 특권 없음 (Phase 1 은 같은 유저 경로뿐)

### 5.2 Cedar 연결 — **S5 단계** 에서 연결

- `a2a-delegate` 액션이 Cedar catalog 에 이미 설계됨 (`a2a-authorization.md`)
- **Phase 1 S1~S4 는 Cedar 미연결** — 인터프리터 내부에서 ownership/archived 하드코딩 체크. S5 단계에서 Cedar 로 이관.
- S5 에서 기존 Cedar 인프라 (`a2a-authorization.md` 설계) 의 실 소비처로 등판.

### 5.3 기본 정책 (S5 적용 대상 초안)

```cedar
// 같은 유저 내 에이전트 간 TODO 허용
permit (
  principal is LocalAgent,
  action == Action::"a2a-delegate",
  resource is LocalAgent
) when {
  principal.owner == resource.owner &&
  !resource.archived
};

// 크로스 유저는 기본 거부 (Q1 — Phase 1 불허)
// Phase 2 에서 원격 agent 경로 추가 시 PeerAgent entity 와 별도 정책 검토.
```

---

## 6. 생명주기

### 6.1 TODO 상태 머신

```
pending ──(대상 agent picking)──→ processing ──(success)──→ completed
   │                                   │
   │                                   ├─(agent error)───→ failed
   │                                   │
   │                                   └─(timeout)───────→ expired
   │
   ├─(archive / queue-full / timeout)─→ failed | expired
   └─(송신자 취소)────────────────────→ cancelled
```

- `pending` — 큐 입력 후 수신 agent picking 대기
- `processing` — 수신 agent session 이 TODO 처리 중 (세션의 event queue 에 들어감)
- `completed` — 정상 완료 + response 전송 (`status='success'`)
- `failed` — 처리 실패 — agent 에러 / archive / queue-full / 스키마 위반 등 (response `status='failed'` + `error`)
- `expired` — 타임아웃 (response `status='expired'`)
- `cancelled` — 송신자 또는 admin 이 취소 (response 없음)
- `orphaned` — 송신자 agent 가 사라진 후 완료된 response 가 갈 곳 없음 (Q5)

**멱등성 (v3)**: `markProcessing(id)` 이 false 를 반환하는 경우 (이미 processing/completed/failed/expired 이거나 row 없음) 는 모두 "이미 처리된 상태 또는 처리 대상 아님" 으로 같은 의미. EventActor 의 drain 이 `#skipDuplicateTodoRequest` 패턴으로 안전하게 skip. 중복 event 재진입 (재시작 복구 등) 에서 turn 이 중복 실행되지 않음.

### 6.2 대상 agent archive 시 (Q9)

- archive **이전** `pending` TODO → **즉시 `failed` 로 전환** + response (`error='target-agent-archived'`)
- archive **이전** `processing` TODO → 끝까지 진행 (agent-identity §5.4 기존 session 보존 원칙)
- archive **이후** 새 TODO → Cedar `a2a-delegate` 평가 단계에서 반려

### 6.3 송신자 agent archive 시 (Q5) — v4 확정

- 진행 중 request 는 대상 agent 에서 계속 처리
- receiver 완료 시 `dispatchResponse` 가 `sessionManager.findSenderSession(fromAgentId)` 조회 → `not-registered`/`ambiguous` 면 response row `status='orphaned'` + logger warn (event 미발행)
- agent 가 다시 등록되어도 자동 복구 안 됨 (S4 recovery 에서 scan + resend 고려)
- `listByRecipient(senderAgentId, {status:'orphaned'})` 로 관측 가능

### 6.4 서버 재시작 (Q3)

- SQLite 영속화 — `~/.presence/users/{u}/memory/a2a-queue.db`
- 재시작 후:
  - `pending` — 재처리 (수신 agent 확인 후 event queue 재주입)
  - `processing` — `failed` 전환 + response (`error='server-restart'`) — 처리 중이던 session 이 유실되었으므로 멱등성 가정 불가
  - `completed` / `failed` / `expired` / `cancelled` / `orphaned` — 이력으로 보관 (cleanup 정책: 후속 결정, 잠정 14 일)

### 6.5 큐 상한 (Q10)

- agent 당 `pending` 상한 100 (`A2A.QUEUE_MAX_PER_AGENT` — `policies.js`)
- 초과 시 즉시 `failed` + response (`error='queue-full'`). back-pressure 없음.

### 6.6 타임아웃 (Q6) — v4 확정

- 기본 5 분 (`A2A.DEFAULT_TIMEOUT_MS = 300000` — `policies.js`)
- 송신자가 `timeoutMs` override 가능
- **Expire 클럭 주체 = UserContext** (Q14 확정): `UserContext.start()` 시 `setInterval(tick, 30_000)` + `.unref()`. shutdown 에서 clearInterval + `await inFlight` 로 진행 중 tick 완료 후 a2aQueueStore.close
- 각 tick 에서 `a2aQueueStore.listExpired(now)` → pending/processing 이고 `created_at + (timeoutMs ?? A2A.DEFAULT_TIMEOUT_MS) < now` 인 request 조회
- 각 row 에 대해 `markExpired(id)` 시도 (false 면 이미 전이됨 → skip) → `dispatchResponse(status='expired')`
- **Receiver 완료 vs Expire race**: `markCompleted`/`markExpired` 중 **먼저 전이 성공한 쪽** 만 dispatchResponse 호출 (boolean 반환값 확인). 중복 response 방지.

### 6.1b 상태 머신 — response row 확장 (v4)

response row (`kind='response'`) 는 생성 시점에 최종 status 로 기록:
- `completed` = receiver turn 성공
- `failed` = receiver turn 실패 (agent error / pre-check 실패)
- `expired` = expire clock timeout 전이
- `orphaned` = sender session 부재로 event enqueue 불가

response 는 `pending` 단계가 없음 (requst 와 달리 즉시 final status).

---

## 7. 결정 사항 (v2 — 2026-04-24 확정)

| ID | 질문 | 결정 | 반영 위치 |
|---|---|---|---|
| Q1 | 크로스 유저 TODO 허용? | **불허** (Phase 1 은 같은 유저 내부만) | §1.1, §2 S4 |
| Q2 | Admin agent 특권? | **불필요** (크로스 유저 없어 자연 해소) | §2 S4 |
| Q3 | TODO 영속화? | **SQLite** (`~/.presence/users/{u}/memory/a2a-queue.db`) | §6.4 |
| Q4 | 실패 에러 정보 반환? | **response 에 `status` + `error` 필드** | §4.1 |
| Q5 | 송신자 archive 후 response? | **`orphaned` 상태로 DB 보관 + warn log**, 자동 복구 없음 | §6.3 |
| Q6 | 타임아웃? | **기본 5 분**, `timeoutMs` override 가능 | §6.6, §4.1 |
| Q7 | 다자 부분 성공? | **종결** — 다자 처리는 `Op.Parallel + Op.Delegate` 가 이미 해결 (`Promise.allSettled`, 항목별 fulfilled/rejected). SendTodo 는 병렬 집계가 아닌 비동기 맥락 투입 경로 | §2 S3 |
| Q8 | 재위임 깊이? | **깊이 1 고정** (Q12 불허로 자연 해소) | §2 S3 |
| Q9 | archive 시 큐 TODO? | `pending` → `failed`, `processing` → 끝까지 진행 | §6.2 |
| Q10 | 큐 상한? | **agent 당 `pending` 100**, 초과 즉시 fail | §6.5 |
| Q11 | Op ADT 접근? | **새 Op 추가** (`Op.SendTodo`) | §4.4 |
| Q12 | 재귀 TODO? | **불허** (response 에서 새 TODO 발행 금지) | §2 S3, §6.1 |

---

## 8. 구현 단계 (v2 확정)

각 단계는 별도 플랜 + 리뷰. 스켈레톤이 먼저 돌아야 이후 단계의 실 요구가 드러남.

| 단계 | 시나리오 | 범위 | Q |
|---|---|---|---|
| **S1** ✅ 완료 (2026-04-24) | 동일 유저 단방향 TODO | `Op.SendTodo` + SQLite `a2a-queue` + `pending→processing→completed` 머신 + 수신 agent event queue 주입 + 권한 check (같은 유저 agent 만) | Q1/Q3/Q11 반영 |
| **S2** ✅ 완료 (2026-04-24) | 요청/응답 상관 | response 스키마 (`status`+`error`) + `correlationId` + 타임아웃 expire 클럭 + orphan 처리 | Q4/Q5/Q6/Q13/Q14/Q15 |
| **S3** ✅ 완료 (2026-04-24) | agent discovery | `list_agents` tool — 같은 유저 agent 목록 + description + capabilities 반환 (archived 제외). Delegate / SendA2aMessage target 선택 편의. 다자 처리 자체는 Parallel+Delegate 로 이미 해결 (Q7 종결) | Q7 재평가 |
| **S4** | 큐 상한 + 회복력 | agent 당 `pending` 100 상한 + 서버 재시작 복구 경로 (`processing → failed`) | Q10 |
| **S5** | Cedar 권한 연결 | `a2a-delegate` Cedar action 소비처로 등판. 송신 agent ↔ 수신 agent ownership + archived 체크 | `a2a-authorization.md` |

S3 에서 Q7 (부분 성공 의미론) 확정 후 진행. S4 는 S1 완료 직후 삽입 가능 (큐 상한은 최소 방어).

**범위 밖 (Phase 1 모두 포함 안 함)**: 네트워크 전송 / 암호화 / peer registry / 크로스 유저. Phase 2 (`a2a-transport.md`) 에서 처리.

### S1 구현 경로 (2026-04-24 완료)

| 역할 | 파일 |
|---|---|
| A2A TODO 큐 저장소 (SQLite) | `packages/infra/src/infra/a2a/a2a-queue-store.js` |
| SendA2aMessage 인터프리터 | `packages/infra/src/interpreter/send-a2a-message.js` (v8 — 이전 `send-todo.js`) |
| 수신 session 라우팅 (findAgentSession) | `packages/infra/src/infra/sessions/session-manager.js` |
| Op.SendA2aMessage 정의 | `packages/core/src/core/op.js` (v8 — 이전 `Op.SendTodo`) |
| EVENT_TYPE / A2A 정책 상수 | `packages/core/src/core/policies.js` |
| 수신 측 상태 전이 (A2A_REQUEST 분기) | `packages/infra/src/infra/sessions/internal/session-actors.js` |
| EventActor markProcessing + skipDuplicate | `packages/infra/src/infra/actors/event-actor.js` |
| Interpreter env 확장 (currentAgentId/a2aQueueStore/sessionManager) | `packages/infra/src/interpreter/prod.js`, `packages/infra/src/infra/sessions/internal/session-interpreter.js`, `packages/infra/src/infra/sessions/internal/ephemeral-inits.js` |
| UserContext 주입 | `packages/infra/src/infra/user-context.js` |

테스트: `a2a-queue-store.test.js` (AQ1~7), `a2a-send-todo.test.js` (ST1~10 + STx), `a2a-integration.test.js` (AI1~3), `session-manager-routing.test.js` (SM1~4). 전체 npm test 3634 통과.

### S2 구현 경로 (2026-04-24 완료)

| 역할 | 파일 |
|---|---|
| response row 생성 + sender eventActor enqueue | `packages/infra/src/infra/a2a/a2a-response-dispatcher.js` |
| sender session 조회 (USER+AGENT, AGENT 우선) | `packages/infra/src/infra/sessions/session-manager.js` `findSenderSession` |
| a2a_response drain + SYSTEM entry 추가 | `packages/infra/src/infra/actors/event-actor.js` `#handleA2aResponse` (v8) |
| formatResponseMessage (completed/failed/expired 포맷) | `packages/infra/src/infra/events.js` |
| expire 클럭 (setInterval + unref + shutdown await) | `packages/infra/src/infra/user-context.js` `startA2aExpireTick` |
| A2A_REQUEST / A2A_RESPONSE event type / EXPIRE_TICK_MS 상수 | `packages/core/src/core/policies.js` (v8 rename) |
| markCompleted/markExpired race 방어 + markOrphaned | `packages/infra/src/infra/a2a/a2a-queue-store.js` |
| SessionActors handleEventDone A2A_REQUEST 분기 (dispatchResponse 호출 + race 방어) | `packages/infra/src/infra/sessions/internal/session-actors.js` |

테스트: `a2a-queue-store.test.js` (AQ8~12 추가), `a2a-response-dispatcher.test.js` (RD1~5 + 실패 경로), `a2a-integration.test.js` (AI4~6 + EA1~3 + RC1~2), `session-manager-routing.test.js` (SM5~7 `findSenderSession`). 전체 npm test 3702 통과.

### S3 구현 경로 (2026-04-24 완료)

| 역할 | 파일 |
|---|---|
| `list_agents` tool 팩토리 | `packages/infra/src/infra/agents/agent-tools.js` `createListAgentsTool` |
| UserContext 에서 toolRegistry 등록 | `packages/infra/src/infra/user-context.js` (registerSummarizer 직후) |

**활용**: planner agent persona 프롬프트에서 `list_agents` 를 호출 → 반환 목록으로 `Op.Delegate` target 또는 `Op.SendA2aMessage` target 선택. 다자 처리는 `Op.Parallel([Delegate(a), Delegate(b), ...])` 로 한 번에 병렬 + 결과 집계.

테스트: `agent-tools.test.js` (LA1~6 — 빈 registry / 포맷 / archived 제외 / 최신 반영 / 설명 폴백 / schema). 전체 npm test 3722 통과.

---

## 9. 검증 기준

- 각 시나리오 (S1~S7) 가 실제 동작 테스트 존재
- Cedar 권한 거부 시 명시적 에러 경로 관찰 가능
- `a2a-transport.md` 의 Phase 2 설계가 Phase 1 의 인터페이스 위에 **추가 레이어로** 얹힐 수 있음 (Phase 1 을 재설계할 필요 없음)

---

## 10. Phase 2 (원격) 와의 관계

Phase 1 이 Phase 2 로 확장될 때 바뀌는 점 (예상):

- `AgentId` 는 이미 `{username}/{agentName}` 이므로 scope 식별 자체는 그대로
- 전달 방식만 in-process 함수 호출 → HTTP/WebSocket
- 인증 추가: JWT + peer registry (from `a2a-transport.md`)
- 권한 정책은 유지 (Cedar 평가는 로컬)

즉 **통신 프리미티브 + 권한 + 생명주기는 Phase 1 에서 고정되고, Phase 2 는 전송과 신뢰만 추가** 하는 구조. 이 분할이 올바르게 유지되면 Phase 2 는 재설계 없이 확장만으로 완성됨.

---

## Changelog

- **v8 (2026-04-24)**: **A2A 네이밍 범용화** (사용자 지적). "TODO" 가 agent 작업의 한 종류 (category) 일 뿐이라는 원칙 반영. 프리미티브 재명명: `Op.SendTodo` → `Op.SendA2aMessage`, `todo_messages` 테이블 → `a2a_messages`, `TODO_REQUEST`/`TODO_RESPONSE` → `A2A_REQUEST`/`A2A_RESPONSE`, `SEND_TODO_ERROR` → `SEND_A2A_ERROR`, `TodoMessage` → `A2aMessage`. 스키마에 `category` 컬럼 추가 (기본 `'todo'`, 향후 `'question'`/`'report'` 확장 가능). SCHEMA_VERSION v1 → v2 migration (`ALTER TABLE RENAME` + `ADD COLUMN`). 스펙 불변식으로 "특정 category 이름을 프리미티브에 고정 금지" 승격 (`data-persistence.md` I13, `session.md` I16). UserDataStore 의 category 패턴과 정합.
- **v6 (2026-04-24)**: S3 재정의. "다자 협업 via TODO" 는 `Op.Parallel + Op.Delegate` 로 이미 해결됨 (Promise.allSettled 집계, 개별 fulfilled/rejected 보존) — 과공학 회피. SendTodo 는 비동기 맥락 투입 용도로 구분. S3 의 실질 범위 = `list_agents` tool 추가 (agent discovery). Q7 종결.
- **v5 (2026-04-24)**: S2 구현 완료. a2a-response-dispatcher.js 신규, events.formatResponseMessage, EventActor #handleTodoResponse, SessionActors handleEventDone TODO_REQUEST 분기 확장 (markCompleted/markFailed boolean + dispatchResponse), UserContext startA2aExpireTick (setInterval + unref + shutdown await), A2aQueueStore S2 4 메서드 (enqueueResponse/listExpired/markExpired/markOrphaned). 신규 Q13/Q14/Q15 확정 반영.
- **v4 (2026-04-24)**: S2 설계 확정. Q13 (response 전달 = event queue), Q14 (expire 클럭 = UserContext tick), Q15 (SYSTEM entry 만) 확정. §4.2 `findSenderSession` API 신설 (USER+AGENT 라우팅, AGENT 우선). §4.5 `todo_response` drain 처리 신규 (turnLifecycle.appendSystemEntrySync + skipTodoReview 패턴). §6.3 orphan 정책 구체화. §6.6 expire 주체 UserContext + race 방어 (markCompleted/markExpired boolean return). §6.1b response row 상태 머신 확장.
- **v3 (2026-04-24)**: S1 구현 플랜 리뷰 1-6차 반영. §4.2 신규 — 수신 session 라우팅 규칙 (USER/AGENT dual-homed, `type===AGENT` 만 선택). §4.4 확정 — 반환 계약 `{requestId, accepted, error?}` 의 세 관계 + 8 종 error enum (validateTarget 5 + row-생성-후 3). §6.1 `markProcessing=false` 멱등 명문화. SessionManager.findAgentSession API 신설 전제.
- **v2 (2026-04-24)**: 열린 질문 12개 전부 확정. 스켈레톤 구현 플랜 (S1) 착수 가능 상태. 메시지 스키마 v2 (status/error/timeoutMs 필드 추가), 생명주기 상태 머신 구체화 (orphaned 추가), SQLite 영속화 결정, 큐 상한 100 + 타임아웃 5 분 기본값, 새 Op `Op.SendTodo` 결정, 크로스 유저 Phase 1 에서 제외. 구현 단계 5 개 (S1~S5) 로 재정리.
- **v1 (2026-04-23)**: 초안. 사용자의 원래 의도 (TODO 중심 에이전트 협업) 를 축으로 Phase 1 (내부) + Phase 2 (원격) 분할 설계. 시나리오 7개 + 열린 질문 12개 명시. 구현 플랜 착수 전 열린 질문 확정 필요.
