# A2A Phase 1 — 내부 에이전트 통신 설계

**Status**: 2026-04-24 v2. 열린 질문 12개 확정 완료. S1 스켈레톤 구현 플랜 착수 가능.

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
- 메시지 전달: TODO (요청) + 응답
- 권한: "누가 누구에게 TODO 를 보낼 수 있나"
- 생명주기: 대상 에이전트 삭제 / 재시작 / 실패 처리

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

### S3. 동일 유저 내 다자 협업 — Phase 1 S3 단계에서 설계 확정

> planner 가 TODO 를 여러 전문 에이전트에게 분배하고 결과를 모은다.

**S1/S2 스켈레톤 범위 밖**. S3 플랜 작성 시점에 Q7 (부분 성공 의미론) 확정 필요. Q8 (재위임 깊이) 는 Q12 (재귀 불허) 로 자연 해소 — 응답이 새 TODO 를 유발할 수 없으므로 깊이 상한 1 고정 (planner→worker 한 홉). 재귀 허용이 필요해지면 그때 깊이 제한 재설계.

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

### 4.1 메시지 형태 (v2 — Q4 반영)

```
TodoMessage = {
  id: string,                    // UUID
  from: AgentId,                 // 송신자 agent ID (qualified {username}/{agentName})
  to: AgentId,                   // 수신자 agent ID (같은 username 내부만)
  kind: 'request' | 'response',
  correlationId?: string,        // response 일 때 원 request id
  payload: string,               // 자연어 TODO 내용 (request) 또는 결과 (response)
  status?: 'success' | 'failed' | 'expired',  // response 전용
  error?: string,                // response.status !== 'success' 일 때 사유
  createdAt: ISO8601,
  timeoutMs?: number,            // request 전용 (기본 300000 = 5 분)
}
```

- `kind: request` 가 TODO, `kind: response` 가 답
- `correlationId` 로 요청-응답 매칭
- `status` + `error` 로 송신자가 실패 사유 확인 가능 (Q4 결정)
- `timeoutMs` 없으면 정책 기본값 (5 분) 적용

### 4.2 전달 방식

- Phase 1 은 **in-process 함수 호출** (네트워크 없음)
- 동기 vs 비동기: TODO 는 본질적으로 비동기. 송신자는 `SendTodo` 호출 직후 "접수 완료" (request.id) 만 받고, 응답은 별도 이벤트 (예: `todo_response` event) 로 agent 에게 도달
- Phase 2 에서 원격이 추가되면 in-process 호출이 HTTP/WS 로 바뀌지만 메시지 스키마 + 생명주기 동일 유지

### 4.3 Free Monad 통합 — **새 Op 추가** (Q11 결정)

- 현행 `Op.Delegate(target, payload)` 는 **동기 결과 대기** 의미론 (서브에이전트 실행 후 즉시 결과 반환)
- Phase 1 TODO 는 **비동기 요청/응답** — 의미론 다름
- **결정**: 새 Op 추가. 예시 형태 (구현 플랜에서 확정):
  ```
  Op.SendTodo(targetAgentId, payload, { timeoutMs? }) → returns requestId
  ```
- 송신 agent 는 requestId 를 받고 턴을 마칠 수 있음. response 는 event queue 를 통해 비동기 수신.
- Delegate 와 병행 존재 — 의미론 분리가 장기 유지보수에 유리. 사용처가 자연스럽게 갈라짐.

---

## 5. 권한 모델 (v2 확정)

### 5.1 규칙

- 같은 유저 내 agent 간 TODO 허용 (ownership 매치)
- archived agent 수신 TODO 는 거부 (agent-identity §5.4)
- 크로스 유저 TODO 는 **Phase 1 에서 Cedar 평가 전에 SendTodo 인터프리터가 즉시 차단** (Q1)
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

### 6.2 대상 agent archive 시 (Q9)

- archive **이전** `pending` TODO → **즉시 `failed` 로 전환** + response (`error='target-agent-archived'`)
- archive **이전** `processing` TODO → 끝까지 진행 (agent-identity §5.4 기존 session 보존 원칙)
- archive **이후** 새 TODO → Cedar `a2a-delegate` 평가 단계에서 반려

### 6.3 송신자 agent archive 시 (Q5)

- 진행 중 request 는 대상 agent 에서 계속 처리
- 완료 response 는 DB 에 `status='orphaned'` 로 남고 logger warn
- agent 가 다시 등록되어도 자동 복구 안 됨 (admin 수동 도구 후속)

### 6.4 서버 재시작 (Q3)

- SQLite 영속화 — `~/.presence/users/{u}/memory/a2a-queue.db`
- 재시작 후:
  - `pending` — 재처리 (수신 agent 확인 후 event queue 재주입)
  - `processing` — `failed` 전환 + response (`error='server-restart'`) — 처리 중이던 session 이 유실되었으므로 멱등성 가정 불가
  - `completed` / `failed` / `expired` / `cancelled` / `orphaned` — 이력으로 보관 (cleanup 정책: 후속 결정, 잠정 14 일)

### 6.5 큐 상한 (Q10)

- agent 당 `pending` 상한 100 (`A2A.QUEUE_MAX_PER_AGENT` — `policies.js`)
- 초과 시 즉시 `failed` + response (`error='queue-full'`). back-pressure 없음.

### 6.6 타임아웃 (Q6)

- 기본 5 분 (`A2A.DEFAULT_TIMEOUT_MS = 300000` — `policies.js`)
- 송신자가 `timeoutMs` override 가능
- 시스템 expire 클럭 (예: SchedulerActor 와 같은 tick 경로) 이 주기적으로 초과 TODO 를 `expired` 전환

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
| Q7 | 다자 부분 성공? | **S3 단계 플랜에서 확정** (S1/S2 범위 밖) | §2 S3 |
| Q8 | 재위임 깊이? | **깊이 1 고정** (Q12 불허로 자연 해소) | §2 S3 |
| Q9 | archive 시 큐 TODO? | `pending` → `failed`, `processing` → 끝까지 진행 | §6.2 |
| Q10 | 큐 상한? | **agent 당 `pending` 100**, 초과 즉시 fail | §6.5 |
| Q11 | Op ADT 접근? | **새 Op 추가** (`Op.SendTodo`) | §4.3 |
| Q12 | 재귀 TODO? | **불허** (response 에서 새 TODO 발행 금지) | §2 S3, §6.1 |

---

## 8. 구현 단계 (v2 확정)

각 단계는 별도 플랜 + 리뷰. 스켈레톤이 먼저 돌아야 이후 단계의 실 요구가 드러남.

| 단계 | 시나리오 | 범위 | Q |
|---|---|---|---|
| **S1** | 동일 유저 단방향 TODO | `Op.SendTodo` + SQLite `a2a-queue` + `pending→processing→completed` 머신 + 수신 agent event queue 주입 + 권한 check (같은 유저 agent 만) | Q1/Q3/Q11 반영 |
| **S2** | 요청/응답 상관 | response 스키마 (`status`+`error`) + `correlationId` + 타임아웃 expire 클럭 + orphan 처리 | Q4/Q5/Q6 |
| **S3** | 다자 협업 | planner 가 여러 agent 에게 동시 TODO + response aggregate. 부분 성공 의미론 확정 | Q7 |
| **S4** | 큐 상한 + 회복력 | agent 당 `pending` 100 상한 + 서버 재시작 복구 경로 (`processing → failed`) | Q10 |
| **S5** | Cedar 권한 연결 | `a2a-delegate` Cedar action 소비처로 등판. 송신 agent ↔ 수신 agent ownership + archived 체크 | `a2a-authorization.md` |

S3 에서 Q7 (부분 성공 의미론) 확정 후 진행. S4 는 S1 완료 직후 삽입 가능 (큐 상한은 최소 방어).

**범위 밖 (Phase 1 모두 포함 안 함)**: 네트워크 전송 / 암호화 / peer registry / 크로스 유저. Phase 2 (`a2a-transport.md`) 에서 처리.

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

- **v2 (2026-04-24)**: 열린 질문 12개 전부 확정. 스켈레톤 구현 플랜 (S1) 착수 가능 상태. 메시지 스키마 v2 (status/error/timeoutMs 필드 추가), 생명주기 상태 머신 구체화 (orphaned 추가), SQLite 영속화 결정, 큐 상한 100 + 타임아웃 5 분 기본값, 새 Op `Op.SendTodo` 결정, 크로스 유저 Phase 1 에서 제외. 구현 단계 5 개 (S1~S5) 로 재정리.
- **v1 (2026-04-23)**: 초안. 사용자의 원래 의도 (TODO 중심 에이전트 협업) 를 축으로 Phase 1 (내부) + Phase 2 (원격) 분할 설계. 시나리오 7개 + 열린 질문 12개 명시. 구현 플랜 착수 전 열린 질문 확정 필요.
