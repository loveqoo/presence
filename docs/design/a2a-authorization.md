# A2A Authorization — Cedar 기반 정책 평가

**Status**: 2026-04-21 v5. [`agent-identity-model.md`](agent-identity-model.md) v5 를 선결 토대로 재작성. 이전 v1~v4 의 광범위한 scope 는 identity 모델이 대부분 흡수. 이 문서는 **Cedar 정책 평가가 실제로 필요한 좁은 영역** 만 다룬다.
**Owner**: Presence core.
**관련 문서**: [`agent-identity-model.md`](agent-identity-model.md) (선결), [`platform.md`](platform.md) (북극성), [`../completed.md`](../completed.md).

---

## 0. 이 문서의 scope

### 0.1 Identity model 이 이미 해결한 것

| 문제 | Identity model 의 해법 |
|---|---|
| agentId canonical form | `{username}/{agentName}` + validator (§3.2) |
| Session → agent 연결 | `Session.agentId` 필수 (§5) |
| 기본 접근 제어 | `canAccessAgent({ jwtSub, agentId, intent })` — 5 진입점 (§9.4) |
| Archived agent 처리 | `isExistingSession` 판정 + intent 별 분기 (§5.4) |
| Admin vs user 경계 | agentId prefix (`admin/`) + JWT sub (§9.4) |
| Agent 생성 승인 (quota) | Admin agent + `agent-policies.json` + idempotent replay (§8) |

### 0.2 이 문서 (Cedar) 가 다루는 것

**Cedar 는 복합 정책 평가가 필요한 2 지점만**:

1. **`Action::"create_agent"`** — admin agent 의 quota + 추가 조건 (시간 / 역할 / 사용자 속성) 기반 승인
2. **`Action::"a2a-delegate"`** — 외부 peer 가 로컬 agent 에 delegate 요청 시 trust 평가

### 0.3 이 문서가 **다루지 않는** 것

- 내부 `Op.Delegate` (같은 유저의 agent 간) — `canAccessAgent` 로 충분 (username prefix 일치)
- Archived agent 판정 — identity model
- Agent 식별 / AgentId 파싱 — identity model
- Admin 접근 제한 — identity model
- 에이전트 내부 Op 실행 권한 — 각 agent 의 persona.tools + `allowedDirs` + `approve` 메커니즘

즉 **Cedar 는 "복합 조건 기반 의사결정" 이 필요한 지점** 에만. 단순 ownership 은 `canAccessAgent` 가 담당.

---

## 1. 핵심 결정

| 결정 | 내용 |
|---|---|
| 프로토콜 | Google A2A 표준 (AgentCard / securitySchemes) |
| 인증 (외부) | JWT Bearer + Caller Agent Card `x-presence.publicKey` 로 서명 검증 |
| 인가 | Cedar (`@cedar-policy/cedar-wasm`). `packages/infra/src/authz/` 만 |
| 평가 지점 | **2 곳만** — `create_agent` (admin 경로) + `a2a-delegate` (외부 HTTP 수신) |
| 정책 저장소 | 글로벌 + 유저 2-layer (identity model §11 과 동일 lifecycle) |
| 실패 모드 | Fail-closed |

---

## 2. 전체 흐름

### 2.1 외부 A2A 수신 (`a2a-delegate`)

```
외부 peer 가 POST /a2a/{username}/{agentName}
  ↓
A2A JWT 검증 (iss/aud/exp + Agent Card publicKey)
  ↓
CallerIdentity.fromJwt → caller = PeerAgent::"bob-home/assistant"
  ↓
canAccessAgent 는 cross-user 이므로 기본 거부
  ↓ 대신 Cedar 평가
Cedar: (principal=caller, action=a2a-delegate, resource=target agent)
  ↓
allow → target agent session 생성 및 task 실행
deny  → 403
  ↓
Audit 기록
```

### 2.2 Agent 생성 승인 (`create_agent`)

```
유저가 'npm run user -- agent add'
  ↓
CLI 가 agent-policies.json 읽음 + user config 기반 count
  ↓
Cedar: (principal=User::"anthony", action=create_agent, resource=User::"anthony", context={count, quota, role, time, ...})
  ↓
allow → identity model §8.3.5 idempotent replay 로 append
deny  → pending/{reqId}.json 에 저장 (admin 수동 검토)
  ↓
Audit 기록
```

---

## 3. CallerIdentity

### 3.1 타입

```js
// packages/infra/src/authz/caller.js
type CallerIdentity = {
  principal: {
    type: 'LocalUser' | 'LocalAgent' | 'PeerAgent',
    id: string,              // LocalUser: username / LocalAgent: agentId / PeerAgent: x-presence.agentId
  },
  via: 'http-a2a' | 'cli' | 'internal',
  attrs: object,             // role, roles (identity model §3), JWT custom claims
  jti?: string,              // http-a2a 만
}
```

### 3.2 Factory — module-private brand

```js
const BRAND = Symbol('authz.caller')
const REGISTERED = new WeakSet()

class CallerIdentity {
  constructor(fields, guard) {
    if (guard !== BRAND) throw new Error('private — use factory')
    Object.assign(this, fields); Object.freeze(this); REGISTERED.add(this)
  }
}

export const fromJwt = (jwt, peerCard) => { /* 검증 */ new CallerIdentity({principal: {type:'PeerAgent', ...}, via:'http-a2a', ...}, BRAND) }
export const fromCli = (username) => new CallerIdentity({principal: {type:'LocalUser', id:username}, via:'cli', attrs:{role: loadUserConfig(username).role}}, BRAND)
export const assertValid = (c) => { if (!REGISTERED.has(c)) throw new Error('forged CallerIdentity') }
```

**Note** (관찰): JS 에는 nominal type 이 없어 plain object 위조는 WeakSet 으로만 방어. 진짜 경계는 모듈 export surface — factory 3 개만 공개, BRAND 는 module-private. Branded type alias 는 IDE 힌트 수준.

### 3.3 Internal Op.Delegate 는 CallerIdentity 불필요

Identity model §9.4 의 `canAccessAgent` 가 처리. JWT 없고 cross-user 도 아님. Cedar 평가도 불필요 (단순 ownership 검사).

---

## 4. AgentCard + Peer Discovery

Identity model §11 이 기본 구조 확정. 추가로:

### 4.1 JWT 검증용 Agent Card 필드

```json
{
  "x-presence": {
    "agentId": "bob-home/assistant",
    "publicKey": "-----BEGIN PUBLIC KEY-----..."
  }
}
```

- `agentId` — Cedar principal 식별자
- `publicKey` — JWT 서명 검증 키

### 4.2 Peer registry lookup

```js
// JWT 의 iss 로 peer card 조회
const peerCard = peerRegistry.getByAgentId(jwt.iss)
if (!peerCard) throw new AuthzError('unknown peer')
verifyJwtSignature(jwt, peerCard.x-presence.publicKey)
```

---

## 5. JWT 보강 (외부 A2A 만)

| claim | 용법 |
|---|---|
| `iss` | caller agent ID (`bob-home/assistant`) |
| `aud` | target agent ID (`anthony/daily-report`) |
| `sub` | caller agent ID (동일) |
| `exp` / `iat` / `jti` | 표준 + replay 방어 |
| `x-presence:attrs` | Cedar context 주입 |

**Access token 수명**: 5 분 (짧게). Refresh 는 presence 내부 auth 만 (user JWT). A2A access token 은 매번 caller 가 재서명.

**Key rotation**: v2 미결 (`kid` + 키 목록).

---

## 6. Cedar — Decision Contract

### 6.1 경계 타입 (core 는 Cedar 미노출)

```js
// core 공개
type AuthzDecision = {
  allow: boolean,
  reason: string,               // 자연어만. policy id / 파일명 금지
  deniedBy?: 'forbid' | 'no_permit' | 'unknown_action' | 'engine_error',
}

// infra 내부 — core 에 전달 안 함
type AuditRecord = {
  decision: AuthzDecision,
  cedarPolicyIds: string[],     // infra 내부 trace 용
  matchedPolicies: object[],
  evaluationNs: number,
}

// 공개 API
export const evaluate = (input) => ({ decision, audit })
```

- `reason` 은 evaluator 가 자연어로 변환 (Cedar 원시 결과 → "same user ownership", "quota exceeded" 등)
- 테스트: `reason` 에 파일명/라인번호 포함 여부 unit test 로 검증 (문자열 패턴 체크)

### 6.2 RBAC + ABAC 예시

```cedar
// create_agent — quota + admin 면제
forbid (principal, action == Action::"create_agent", resource)
when { principal.role != "admin" && context.currentCount >= context.maxAgentsPerUser };

// a2a-delegate — 같은 유저 소유 peer 는 허용
permit (principal, action == Action::"a2a-delegate", resource)
when { principal.userId == resource.userId };

// 50-custom.cedar (개인) — 특정 외부 peer 허용
permit (
  principal == PeerAgent::"friend-home/assistant",
  action == Action::"a2a-delegate",
  resource == Agent::"anthony/daily-report"
);
```

### 6.3 평가 순서

Cedar 엔진 내장 — `forbid` 매칭 → deny / `permit` 최소 1 매칭 → allow / 그 외 deny (fail-closed).

---

## 7. Action 카탈로그 v1

v1 은 2 종류:

```json
// ~/.presence/actions/catalog.v1.json
{
  "version": 1,
  "actions": [
    {
      "id": "create_agent",
      "resource": "User",
      "resourceKind": "parent",
      "contextFields": ["currentCount", "maxAgentsPerUser", "role"]
    },
    {
      "id": "a2a-delegate",
      "resource": "Agent",
      "resourceKind": "entity",
      "contextFields": ["time", "viaAttrs"]
    }
  ]
}
```

### 7.1 Resource resolution

| Action | Resource 추출 |
|---|---|
| `create_agent` | `User::"{principal.userId}"` (parent — 유저가 자기 agents 컨테이너에 append) |
| `a2a-delegate` | `Agent::"{targetAgentId}"` (URL path `/a2a/:user/:agent` 에서 추출) |

### 7.2 향후 확장

Cedar 가 필요해지는 새 지점이 생기면 (`read-memory` 나 `tool-call-on-behalf` 등 — identity §9.4 intent 세분화) catalog 에 action 추가. 개인 정책은 catalog 의 action 만 참조 가능. 미등록 action 참조 시 policy 로드 에러.

---

## 8. 정책 저장소 + Migration

### 8.1 디렉토리

Identity model §11 과 동일한 lifecycle:

```
~/.presence/
├── policies/                   ← 글로벌 (admin 관리)
│   ├── 00-base.cedar           (auto-seed)
│   └── 10-operations.cedar
└── data/{user}/
    ├── config.json
    └── policies/               ← 유저 개인 — user lifecycle
        └── 50-custom.cedar
```

**합성 규칙**:
- 글로벌 `forbid` 는 개인 `permit` 을 압도
- 글로벌 + 개인 `permit` 의 union
- Catalog 에 없는 action 참조 → 로드 에러

### 8.2 `00-base.cedar` auto-seed

서버 부팅 시:
1. 파일 없으면 `packages/infra/src/authz/defaults/00-base.cedar` 복사
2. Seed 시점 `~/.presence/policies/.seed-mtime` 기록
3. **편집 판별 = mtime 비교** (marker 라인 실수 삭제로 덮어쓰기 방지)
4. 파일 존재 + 컴파일 실패 → 서버 부팅 실패
5. 명시적 재시딩: 사용자가 파일 삭제 → 재생성

```cedar
// 00-base.cedar (default)
// Auto-seeded. Delete this file (not this line) to re-seed with defaults.

// 같은 유저 소유 agent 끼리의 a2a-delegate 허용
permit (principal, action == Action::"a2a-delegate", resource)
when { principal.userId == resource.userId };

// create_agent quota 초과 시 거부 (admin 은 면제 — identity model §9.3)
forbid (principal, action == Action::"create_agent", resource)
when { principal.role != "admin" && context.currentCount >= context.maxAgentsPerUser };
```

### 8.3 Config `a2a.enabled` 연계

Identity model §11.1 에서 결정. `enabled=false` 면:
- Cedar `a2a-delegate` 정책은 로드되지만 **실제 호출 경로 없음** (HTTP 라우트 미등록)
- `create_agent` 는 항상 동작 (A2A 와 무관)

즉 Cedar 엔진은 항상 활성, 진입점만 flag 로 조절.

---

## 9. Fail-closed + Audit

### 9.1 기본값

- 정책 매칭 없음 → deny
- Cedar 엔진 장애 → deny-all
- 파일 컴파일 에러 → 해당 파일만 무효화 + 감사 로그 경고. 기존 컴파일 set 유지

### 9.2 Audit 로그

```json
{
  "ts": "2026-04-21T12:34:56Z",
  "request_id": "req-abc",
  "caller": { "type": "PeerAgent", "id": "bob-home/assistant", "via": "http-a2a" },
  "action": "a2a-delegate",
  "resource": "Agent::\"anthony/daily-report\"",
  "decision": "allow",
  "reason": "same user ownership — not applicable (cross-user). personal policy match.",
  "cedarPolicyIds": ["50-custom.cedar#1"],
  "latency_ms": 4
}
```

- 저장: winston transport → 서버 로그 (v1)
- 보존 / SIEM: v2 미결

---

## 10. 구현 Phase

| 단계 | 내용 | 의존 |
|---|---|---|
| **P23-0** | Action catalog + CallerIdentity + AuthzDecision 타입 (순수) | identity v5 |
| **P23-1** | Cedar wrapper (`infra/authz/`) + `evaluate` + `assertValid` | P23-0 |
| **P23-2** | Policy loader (2-layer) + `00-base.cedar` auto-seed + mtime 판별 | P23-1 |
| **P23-3** | Audit 포맷 + winston transport | P23-1 |
| **P23-4** | AgentCard `x-presence.publicKey` + peer registry + CLI (`peer add`) | identity §11 |
| **P23-5** | JWT `iss`/`aud`/publicKey 검증 + `fromJwt` | P23-4 |
| **P23-6** | HTTP `/a2a/:username/:agentName` 수신 handler — canAccessAgent 먼저 + Cedar 평가 | P23-2, P23-3, P23-5 |
| **P23-7** | `create_agent` action 연계 — admin CLI approve 경로에 Cedar 평가 삽입 | P23-2, identity §8 |
| **P23-8** | Live probe — 외부 peer 가 로컬 agent 에 delegate 하는 시나리오 | P23-6 |

---

## 11. 미결 / 후속

- Key rotation (`kid` + 키 목록) — v2
- Peer discovery 자동화 (DNS-SD / 레지스트리) — v2
- Action catalog 확장 (identity §9.4 intent 세분화에 연동) — 필요 시
- Policy reload (watcher) — v2
- Audit 로그 보존 / 외부 SIEM — v2
- Cedar 평가 overhead + 캐싱 — 측정 후 필요 시

---

## 12. 북극성 확인

1. ✓ A2A universal protocol — 외부 수신 Cedar + 내부는 canAccessAgent 일관
2. ✓ 2-layer extension — 글로벌 + 유저 정책 (identity 와 동일 lifecycle)
3. ✓ Capability-based — Cedar 는 단일 결정 엔진 (복합 정책만)
4. ✓ Op ADT 경계 — core 는 `AuthzDecision` plain shape 만
5. ✓ Finite 선택 공간 — action 카탈로그가 허용 상한

---

## Changelog

- v1~v4: 광범위 scope 시도. 반복 no-ship → identity 모델 분리 결정
- **v5**: [`agent-identity-model.md`](agent-identity-model.md) v5 토대 위에 재작성. Cedar 의 scope 를 복합 정책 2 지점 (`create_agent`, `a2a-delegate`) 으로 극축소. 내부 `Op.Delegate` 는 `canAccessAgent` 로 충분 (Cedar 미사용). 문서 크기 ~200 줄로 축소. Phase 재정의 (P23-0 ~ P23-8).
