# A2A Transport — Per-agent JWT + Peer Registry + `/a2a/*` 라우터

**Status**: 2026-04-23 v1 초안. [`a2a-authorization.md`](a2a-authorization.md) v6 에서 Phase 분리 결정으로 신설. v1 (authz 기반 + governance) 이 선행 완료된 후 별도 플랜으로 구현.

**Owner**: Presence core.

**관련 문서**:
- [`a2a-authorization.md`](a2a-authorization.md) v6 §10 — 전체 Phase 표에서 v1 / v2 분리
- [`agent-identity-model.md`](agent-identity-model.md) — 선결
- [`platform.md`](platform.md) — 북극성

---

## 0. 이 문서의 범위

[`a2a-authorization.md`](a2a-authorization.md) 에서 v1 구현에 포함하지 않은 **A2A 통신층 전체** 를 다룬다. v1 은 Cedar 평가 엔진과 `create_agent` governance 만 완성. 이 문서는 v2 로 미뤘던 다음 항목의 설계를 보존한다.

- Per-agent RSA keypair 발급 / 저장
- Peer registry (target-user scoped, filesystem-only lookup)
- Peer CLI (`peer add / refresh / remove`)
- A2A JWT (RS256) 발급 / 검증
- `aud` route binding + URL canonicalization
- Self Agent Card 의 `x-presence.publicKey` 노출
- `/a2a/*` 라우터 wire-up (stub 제거, Cedar `a2a-delegate` 평가)
- Two-server live probe

---

## 1. 핵심 결정

| 결정 | 내용 |
|---|---|
| 키 단위 | per-agent RSA 2048. `~/.presence/users/{user}/agents/{name}/keys/{private,public}.pem`, private `chmod 0600` |
| JWT 알고리즘 | RS256. 수명 5분. refresh 없음 (매번 재서명) |
| peer registry 저장 | target-user 스코프. `~/.presence/users/{user}/peers/{slug}.json` |
| peer registry 조회 | filesystem-only (`loadPeerCard(targetUser, callerAgentId)`). UserContext 부팅 독립 |
| `aud` binding | 수신자 publicUrl 전체 URL (`{config.a2a.publicUrl}/a2a/{targetUser}/{targetAgent}`) |
| URL canonicalization | WHATWG URL parser + 6 규칙 (아래 §5) |
| `/a2a/*` same-user fast-path | **PeerAgent 는 제외** — 항상 Cedar `a2a-delegate` 평가 |
| JWT replay | `jti` in-memory LRU (1000 entries). 서버 재시작 시 초기화. 단일 인스턴스 전용 |
| 운영 제약 | v1 single-instance 전용. multi-instance 배포 금지 (jti LRU 공유 없음) |

---

## 2. Per-agent RSA keypair

### 2.1 생성 시점 / 경로

- **admin/manager**: `admin-bootstrap` State 확장 — `a2a.enabled=true` 일 때만 생성
- **일반 user agent**: `npm run user -- agent approve` 경로 (governance 승인 성공 시)
- **부팅 backfill**: `UserContextManager.boot()` 에서 `a2a.enabled=true` 일 때 각 user 의 existing agent 순회 → 키 없음이면 생성. admin-bootstrap 은 admin 전용이므로 user 쪽 backfill 은 별도 유틸 (`agent-keys-migration.js`)

### 2.2 경로 / 권한

```
~/.presence/users/{username}/agents/{agentName}/keys/
├── private.pem   (0600)
└── public.pem    (0644)
```

- `node:crypto generateKeyPairSync('rsa', { modulusLength: 2048 })`
- `private.pem` 은 `chmod 0600` 강제 — `agent-keys.test.js` 에서 `fs.stat.mode` assertion
- agent 디렉토리는 agent-id validator (kebab-case) 가 보호하므로 디렉토리 traversal 안전

### 2.3 Boot backfill 실패 모드

- `UserContextManager.boot()` 에서 backfill 은 **best-effort per-agent**
- 개별 agent 키 생성 실패 (디스크 권한, 디스크 full 등) → 로그 warn + 해당 agent 는 A2A 비활성 (Self Card 미발급, 라우트 접근 시 404). 서버 부팅은 **계속**
- 디렉토리 생성 자체가 실패 → 해당 user 전체 A2A 비활성 + 에러 로그
- 다음 부팅에서 자동 재시도 (idempotent)

---

## 3. Peer registry

### 3.1 스코프 — target-user scoped

- **권위 범위**: 수신 서버의 `target` 유저 peer registry (URL `/a2a/:userId/...` 에서 추출)
- 저장: `~/.presence/users/{targetUserId}/peers/{slug}.json`
- `slug` = callerAgentId 의 `/` → `__` 치환. AgentId validator 가 kebab-case 강제이므로 충돌 없음

### 3.2 Filesystem-only lookup

**중요** — peer lookup 은 filesystem 직접 read 로 처리 (`loadPeerCard(targetUserId, callerAgentId)` 순수 함수). **UserContext 부팅 독립**. 이유:

- `userContextManager.getOrCreate(targetUserId)` 는 LLM/Memory/Session/Actor 등 전체 부팅 trigger
- unauthenticated 요청이 임의 `targetUserId` 로 UserContext 부팅을 유발하지 않도록 **unauthenticated boot 차단**
- peer card 는 JSON 파일 read only — UserContext 수명주기와 독립

A2A 라우터 인증 단계에서 먼저 `userStore.findUser(targetUser)` 존재 검증 → `loadPeerCard` → JWT 검증. UserContext 부팅은 인증/권한 통과 후 JSON-RPC dispatch 단계에서만. 인증된 이후라도 target user 별 파일 read/parse 비용은 유발됨 — 실질 DoS 방어는 별도 rate limit 에 의존 (v2).

### 3.3 Peer CLI

- `npm run user -- peer add --target <user> --card <file>` — peer card 파일 파싱 + 검증 (`x-presence.agentId`, `x-presence.publicKey` 필수) → 저장
- `npm run user -- peer refresh --target <user> --agentId <peer_agentId> --card <new_file>` — peer publicKey 손상/교체 시 수동 회전 (v1 의 유일한 rotation 경로)
- `npm run user -- peer remove --target <user> --agentId <peer_agentId>` — burst 공격 / 신뢰 철회 시 즉시 무효화

**운영 한계**: peer 가 여러 target-user 에 등록되어 있으면 철회도 user 별 반복 필요. 역추적 경로 없음 — 운영 절차로 흡수.

---

## 4. A2A JWT (RS256)

### 4.1 Claims

- `iss`: caller agentId (`bob-home/assistant`)
- `aud`: target agent URL (전체). `{config.a2a.publicUrl}/a2a/{targetUser}/{targetAgent}`
- `sub`: caller agentId (iss 동일)
- `exp`, `iat`, `jti`
- `x-presence:attrs`: Cedar context 로 주입될 custom claims

### 4.2 수명 + replay

- 5분 (`exp`), refresh 없음. 매번 재서명
- `jti` in-memory LRU (size 1000, TTL = exp). 서버 재시작 시 초기화 (v1 허용)
- 멀티 인스턴스 간 공유 없음 — v2 에서 redis/shared-store 이관
- Burst spray 대응: 1000 LRU + 5분 exp 조합상 고빈도 burst 는 LRU 밀림 발생 가능. v1 은 peer 신뢰 전제이므로 burst 공격 탐지 시 `peer remove` CLI 로 신뢰 철회 우선

### 4.3 검증 순서 (실행 가능한 7-step)

peer card 로딩이 서명 검증의 선행조건이므로:

1. URL `/a2a/:userId/:agentName` 에서 `targetUser`, `targetAgent` 추출
2. `userStore.findUser(targetUser)` 존재 확인 (없으면 401, UserContext boot 방지)
3. JWT **header.alg** + **unsigned payload** 파싱 → `iss` 추출
4. `loadPeerCard(targetUser, iss)` — 해당 user 의 peers/ 에서 iss 매칭 card. 없으면 401 (unknown issuer)
5. peer card 의 `x-presence.publicKey` 로 **서명 검증** (RS256)
6. payload claim 검증:
   - `iss === sub` (self-issued)
   - `aud === canonicalize({자기 publicUrl}/a2a/{targetUser}/{targetAgent})` (완전 일치)
   - `exp > now >= iat`
   - `jti` LRU 미등록 → 등록
7. 모두 통과 → `fromJwt(jwt, peerCard)` → `res.locals.caller = CallerIdentity(PeerAgent)`

---

## 5. URL canonicalization

`publicUrl` 과 `aud` 양쪽을 WHATWG URL parser 로 canonicalize 후 **문자열 완전 일치** 비교.

```js
// packages/infra/src/authz/canonicalize-url.js
const canonicalizeUrl = (raw) => {
  const url = new URL(raw)  // 실패 시 throw. scheme/host 소문자, default port strip, IPv6 bracket 표기 등 자동 canonical
  if (url.search) throw new Error('aud must not include query')
  if (url.hash) throw new Error('aud must not include fragment')
  const path = url.pathname.replace(/\/$/, '')  // trailing slash strip
  return `${url.protocol}//${url.host}${path}`
}
```

**percent-decoding 제거**: 양쪽 입력을 encoded 형태 그대로 비교. WHATWG URL 이 같은 input 을 항상 같은 output 으로 정규화하므로 예측 가능. 다른 인코딩으로 들어온 동일 경로는 mismatch 로 처리됨.

**프록시 / canary 대응**:
- 프록시 뒤에 있으면 `publicUrl` 은 프록시 외부 URL 로 명시 설정 필수 (a2a-authorization §11.1)
- canary 배포 시 canary URL 이 다르면 별도 publicUrl 설정. 같은 host 에서 canary/prod 동시 운영은 운영상 피함 (v1 스코프 밖)
- aud mismatch → 401. kill switch (`a2a.enabled=false`) 로 A2A 전체 비활성 가능

---

## 6. Self Agent Card publicKey

### 6.1 순수 유지

`self-card.js` 는 순수 조립 유지 — 파일 I/O 추가 안 함:

```js
// 현재: buildSelfCard({ agentId, publicUrl, description, capabilities })
// 변경: buildSelfCard({ agentId, publicUrl, publicKey, description, capabilities })
```

publicKey 로드 책임은 **호출부** (agent-registry discovery loader 또는 a2a-router discovery handler):

```js
// buildSelfCardsFromRegistry 가 loader 주입 받기
buildSelfCardsFromRegistry(registry, publicUrl, { publicKeyLoader })
```

Default loader = 파일 읽기. 테스트는 mock loader 주입.

---

## 7. `/a2a/*` 라우터 wire-up

### 7.1 미들웨어

```js
// packages/server/src/server/a2a-auth-middleware.js
// Bearer token → CallerIdentity(PeerAgent) → res.locals.caller
```

- 7-step 검증 순서 (§4.3) 구현
- 실패 시 401 + audit 기록

### 7.2 라우터 수정

- stub `parseCaller` 제거
- 미들웨어 mount 후:
  - **canAccessAgent 호출 없음** — PeerAgent 는 same-user fast-path 에서 제외 (D3 규칙)
  - **항상 Cedar `a2a-delegate` 평가**
  - audit 기록
  - Self Card discovery handler 에서 publicKey 로드 주입

### 7.3 Cedar 평가 시 entity bag

v2 entity-bag 이 PeerAgent 지원 추가:

```js
// packages/infra/src/authz/entity-bag.js 확장
const buildEntityBag = ({ caller, target, targetUser }) => {
  const entities = []
  if (caller.principal.type === 'PeerAgent') {
    entities.push({
      uid: { type: 'PeerAgent', id: caller.principal.id },
      attrs: {
        agentId: caller.principal.id,
        userId: extractUsername(caller.principal.id),
        origin: caller.attrs.origin,  // peer card publicUrl
      },
      parents: [],
    })
  }
  // ... (기존 LocalUser/User 분기 유지)
  if (target) {
    entities.push({
      uid: { type: 'Agent', id: target.agentId },
      attrs: { agentId: target.agentId, userId: extractUsername(target.agentId) },
      parents: [],
    })
  }
  return entities
}
```

### 7.4 Seed 정책 업데이트 (`00-base.cedar`)

```cedar
// LocalAgent 끼리 a2a-delegate 허용 (이미 v1 에 있음)
permit (
  principal is LocalAgent,
  action == Action::"a2a-delegate",
  resource is Agent
) when {
  principal.userId == resource.userId
};

// PeerAgent 는 기본 미허용 — user 의 50-custom.cedar 에서 명시 permit 필요
// (00-base 에는 PeerAgent 허용 정책 없음 = fail-closed)
```

**PeerAgent 허용 예시** (개인 `50-custom.cedar` 에서만):

```cedar
permit (
  principal == PeerAgent::"friend-home/assistant",
  action == Action::"a2a-delegate",
  resource == Agent::"anthony/daily-report"
);
```

---

## 8. 변경 파일 (v2 구현 시)

### 신규

| 파일 | 내용 |
|---|---|
| `packages/infra/src/authz/a2a-jwt.js` | RS256 sign/verify + jti LRU |
| `packages/infra/src/authz/agent-keys.js` | RSA keypair generate/load (0600 enforced) |
| `packages/infra/src/authz/agent-keys-migration.js` | 부팅 backfill (user agent) |
| `packages/infra/src/authz/canonicalize-url.js` | URL 정규화 |
| `packages/infra/src/infra/agents/peer-registry.js` | filesystem-only loadPeerCard/savePeerCard |
| `packages/infra/src/infra/agents/peer-cli.js` | CLI subcommand |
| `packages/server/src/server/a2a-auth-middleware.js` | JWT Bearer → CallerIdentity |
| `packages/infra/test/authz/a2a-jwt.test.js` | verify/sign/만료/replay |
| `packages/infra/test/authz/agent-keys.test.js` | keypair + 권한 + backfill |
| `packages/infra/test/authz/canonicalize-url.test.js` | 규칙 케이스 |
| `packages/infra/test/peer-registry.test.js` | register/lookup unit |
| `packages/infra/test/peer-cli.test.js` | CLI black-box |
| `packages/server/test/a2a-authz.test.js` | single-server E2E cross-user |
| `test/e2e/a2a-live-probe.test.js` | two-server live probe |

### 수정

| 파일 | 변경 |
|---|---|
| `packages/infra/src/authz/caller.js` | `fromJwt(jwt, peerCard)` 추가 |
| `packages/infra/src/authz/entity-bag.js` | PeerAgent/Agent 엔티티 추가 |
| `packages/infra/src/authz/defaults/00-base.cedar` | PeerAgent 정책 (기본 미허용) 추가 |
| `packages/infra/src/infra/admin-bootstrap.js` | admin/manager 키쌍 생성 (`a2a.enabled=true` 조건부) |
| `packages/infra/src/infra/user-context.js` | peer-registry 로더 연결, backfill 호출 |
| `packages/infra/src/infra/agents/self-card.js` | `publicKey` shape 확장 (순수 유지) |
| `packages/infra/src/infra/auth/cli.js` | `peer` 서브커맨드 연결 |
| `packages/server/src/server/a2a-router.js` | stub 제거, 미들웨어 mount, Cedar 평가 연계 |

---

## 9. 의도된 제약 (v1 범위로 수용, v2 에서 개선)

| 제약 | 결정 | v2 개선 경로 |
|---|---|---|
| v1 single-instance 전용 | jti LRU 프로세스 로컬. multi-instance 배포 시 replay window 열림. v1 은 단일 인스턴스 전제 | Redis-backed jti store + per-peer rate limit |
| JWT 키 회전 미지원 | peer publicKey 손상/교체 시 `peer refresh` CLI 로 수동. 자동 rotation 없음 | `kid` claim + 키 목록 + 점진 rollover |
| Peer compromise 추적 경로 없음 | target-user 분산 저장이라 peer 가 어느 user 들에 등록됐는지 역추적 없음. 운영 절차로 흡수 | inverse index or peer-global registry (admin 관리) |
| Burst spray 공격 대응 | peer 신뢰 전제 + `peer remove` CLI 로 철회 우선 | per-peer rate limit + automatic quarantine |
| Entity-bag 은 flat-only | parent/group 엔티티 미지원. relation 정책은 deny (policy-loader 가 컴파일 시 warn) | parent/group entity 지원 + schema migration |

---

## 10. 운영 가드레일

- v1 환경에서는 **단일 서버 인스턴스만 배포**. horizontal scale 시도 시 JWT replay 방어 깨짐
- `config.a2a.enabled=false` (기본) → `/a2a/*` 라우트 미등록 + publicKey 노출 안 됨 + 키 생성 경로 비활성. Cedar 엔진과 `create_agent` governance 는 v1 에서 이미 활성
- 운영 중 Cedar a2a-delegate 문제 발생 시 `a2a.enabled=false` 로 A2A 만 끄는 것이 최빠른 kill switch

---

## 11. 구현 순서 (v2 플랜 착수 시점 가이드)

1. **P23-4a**: agent-keys + agent-keys-migration + admin-bootstrap 확장 + self-card shape
2. **P23-4b**: peer-registry (stateless) + peer-cli
3. **P23-5**: a2a-jwt.js + canonicalize-url.js + caller.fromJwt
4. **P23-6**: a2a-auth-middleware + a2a-router wire-up + entity-bag 확장 + 00-base.cedar 갱신
5. **P23-8**: live probe (two-server)

각 단계마다 단위 테스트 → Cedar 평가 경로 검증 → E2E → live probe 순.

---

## 12. 북극성 확인

1. ✓ A2A universal protocol — 설계 문서 §11 자기 카드 + JWT 확정 후 외부 peer 수신 가능
2. ✓ 2-layer extension — a2a-authorization §8 정책 저장소와 동일 lifecycle
3. ✓ Capability-based — Cedar 가 유일 결정 엔진. JWT 는 신원 확인만
4. ✓ Op ADT 경계 — core 는 AuthzDecision plain shape 만 노출
5. ✓ Finite 선택 공간 — action 카탈로그 (v1 의 `a2a-delegate` 정의) 가 허용 상한

---

## Changelog

- **v1 (2026-04-23)**: 초기 작성. [`a2a-authorization.md`](a2a-authorization.md) v6 에서 Phase 분리 결정에 따라 신설. Per-agent RSA keypair, target-user scoped peer registry (filesystem-only), A2A JWT (RS256 + aud binding + URL canonicalization), `/a2a/*` 라우터 wire-up, self card publicKey, live probe 의 세부 설계를 보존.
