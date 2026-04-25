# Cedar 인프라 — 도입의 최소 표면 결정

**Status**: 2026-04-25 v1 초안. Y' (최소) 메타 결정 확정. governance-cedar.md v2.1 의 §6 선결조건 충족 목적. 별도 코덱스 single-round 리뷰 후 인프라 플랜 작성.

**Owner**: Presence core.

**관련 문서**:
- [`governance-cedar.md`](governance-cedar.md) v2.1 — 이 인프라가 박힐 첫 사용처 (`submitUserAgent` RBAC 게이트)
- [`a2a-authorization.md`](a2a-authorization.md) — Cedar 가 두 번째로 박힐 곳 (KG-17 A2A JWT)
- [`agent-identity-model.md`](agent-identity-model.md) §3 — entity 모델 (LocalUser/User) 의 토대
- [`platform.md`](platform.md) §4-3 — 장기 capability 모델 (Cedar 위에 얹힘)

---

## 0. 이 문서의 이유

Cedar 도입은 결정해야 할 항목이 10 개 이상이다 (런타임, 디렉토리, schema, entity, evaluator API, audit, boot, 정책 우선순위, default deny, 평가 실패). 이 결정들이 동시 토론되면 v1 governance-cedar 가 겪었던 무한 리뷰 패턴이 재발한다.

이 문서는 **메타 결정 (Cedar 도입의 야심 수준)** 을 §1.0 에 박고, 나머지 sub-결정을 메타 결정으로부터 자동 도출한다. governance-cedar v2.1 의 패턴 그대로.

---

## 1. 결정해야 할 의미론 (순서대로)

### 1.0 Cedar 도입의 야심 수준 (메타 결정)

§1.1~1.9 sub-결정은 모두 단일 원칙 — **"Cedar 인프라를 얼마나 풍부하게 박을 것인가"** — 의 적용. 메타 결정이 implicit 인 채 sub-결정 토론하면 매 라운드 다른 sub-결정의 단점이 메타 결정의 우려로 표면화 → 무한 리뷰.

**옵션 X' — 집중**: 풍부한 인프라 (hot reload + custom DSL 확장 + observability dashboard + DB audit + 다중 schema)
- 장점: 운영 가시성, 빠른 정책 변경, 풍부한 audit
- 단점: 1~2 주 작업, 도입 비용이 첫 사용 가치 (RBAC 게이트만) 대비 불균형. 빌드/배포 복잡도 증가

**옵션 Y' — 최소**: 정적 정책 파일 + 기본 evaluator wrapper + 단순 audit log (파일 기반, JSONL)
- 장점: 1~2 일 작업, 도입 비용 낮음. 사용 사례가 쌓인 후 점진 확장 (X' 로의 마이그레이션 표면이 작음)
- 단점: 운영 중 정책 변경 시 서버 재시작 필요, audit 분석 도구 자체 구축 (jq 등으로)

**옵션 Z' — 하이브리드**: 일부 풍부 (예: hot reload 만) + 나머지 minimal
- 장점: 유연
- 단점: "왜 이건 풍부하고 저건 최소인가" 매 라운드 토론 위험 — 무한 리뷰 재발

**확정**: **옵션 Y'** (2026-04-25). 이유:
- governance-cedar v2.1 의 옵션 Y 와 정합 (의미론도 인프라도 모두 minimal 부터)
- 첫 사용처 (governance RBAC 게이트) 의 가치 대비 비례
- 마이그레이션 비용이 사용처 1 곳일 때 가장 작음
- 사용자 의도 (경계 먼저, 고도화 나중)

### 1.1 Cedar 런타임 (Y' 자동 도출 → wasm)

**확정**: Cedar 의 공식 Rust 구현을 wasm 으로 빌드한 npm 패키지 (`@cedar-policy/cedar-wasm` 또는 동등한 maintained fork). Node.js 환경에서 외부 binary 의존 없이 실행. JS port 는 표준 정책 호환성 위험으로 배제.

### 1.2 정책 디렉토리 (Y' 자동 도출 → in-source)

**확정**: `packages/infra/src/infra/authz/cedar/policies/` 에 정적 배포. 빌드 시 패키지에 포함. `~/.presence/cedar/` 같은 사용자 경로는 X' 에서. minimal 에선 정책 변경 = 코드 PR.

### 1.3 Schema 위치 + 형식 (Y' 자동 도출 → 정책과 같은 디렉토리)

**확정**: `packages/infra/src/infra/authz/cedar/schema.cedarschema`. Cedar 표준 schema 형식. minimal entity (LocalUser, User, Agent) + 첫 action (`create_agent`).

### 1.4 Entity 모델 (Y' 자동 도출 → minimal — agent-identity-model §3 의 부분집합)

**확정**:
- `LocalUser` (principal): `id: String`, `role: String` ("admin" | "user")
- `User` (resource): `id: String` (username)
- `Agent` (resource, 향후 A2A 에서): `id: String` (canonical AgentId)
- `Action`: `create_agent` (governance 첫 사용), 향후 `a2a-delegate`, `read-memory` 등 추가

향후 a2a-authorization 에서 entity 확장 시 schema 만 갱신.

### 1.5 Evaluator API (Y' 자동 도출 → 직접 호출, Op ADT wrapping 없음)

**확정**: Cedar evaluator 는 일반 동기 함수로 노출 (`evaluate({ principal, action, resource, context }) → { decision, matchedPolicies, errors }`). `agent-governance.js` 등 호출처에서 직접 import + 호출. Free Op (`Op.CheckPermission` 등) 으로 wrapping 하는 것은 X' 또는 별도 phase 에서 검토.

이유: Y' 의 핵심은 **최소 추상화**. Op ADT wrapping 은 finite 선택 공간 강제 가치는 있지만 인프라 phase 에서 도입하면 인프라 + Op 두 결정이 묶임 → 무한 분기 위험.

### 1.6 Audit 로그 (Y' 자동 도출 → 파일 JSONL)

**확정**: `~/.presence/logs/authz-audit.log` JSONL 추가. 각 evaluate 호출당 한 줄:

```json
{"ts":"...","caller":"...","action":"create_agent","resource":"...","decision":"allow","matchedPolicies":["00-base"],"errors":[]}
```

분석은 `jq` 등 외부 도구. DB audit + 인덱싱 + 대시보드는 X'.

### 1.7 Boot 흐름 (Y' 자동 도출 → 부팅 시 한번 로딩, hot reload 없음)

**확정**: 서버 부팅 시 `cedar/policies/*.cedar` + `schema.cedarschema` 로딩 → evaluator 인스턴스 생성 → UserContext 에 주입. 정책 변경은 서버 재시작 필요. hot reload 는 X'.

### 1.8 정책 우선순위 (Y' 자동 도출 → 사전순 통합 평가)

**확정**: 디렉토리 안의 `*.cedar` 를 사전순 (`00-base.cedar`, `50-custom.cedar`) 으로 모두 로딩 → Cedar 의 표준 evaluation 사용 (모든 정책이 동시 평가, `forbid` 가 `permit` 을 우선). 명시적 priority/override 메커니즘 없음.

명명 컨벤션:
- `00-base.cedar` — seed (Y' 에선 minimal RBAC, 모두 allow)
- `50-custom.cedar` — 사용자/배포 환경별 커스텀 (생성 안 함, 추후 운영 단계)

### 1.9 Default + 평가 실패 처리 (Y' 자동 도출 → default deny + fail-closed)

**확정**:
- **Default deny**: Cedar 표준. 정책에 명시된 permit 만 허용
- **Fail-closed**: 정책 파싱/로딩 에러 = **서버 부팅 실패**. evaluator 부재 상태로 서버 시작 금지. uncaught error 로 process 종료
- **Evaluate 실패** (런타임): evaluator 가 throw 하면 호출처에서 deny 로 fallback (감사 로그에 `errors: [...]` 기록 + decision 은 deny)

minimal seed (모두 allow) 단계에선 fail-closed 가 trivial 하지만, 첫 deny 정책 추가 시점부터 의미가 생김.

---

## 2. 인프라 산출물 (옵션 Y')

### 2.1 디렉토리 구조

```
packages/infra/src/infra/authz/
├── agent-access.js      (기존)
├── agent-governance.js  (기존, governance-cedar.md 에서 Cedar 호출 추가 예정)
└── cedar/               (신규)
    ├── evaluator.js     (Cedar wasm wrapper, evaluate({...}) 함수 export)
    ├── boot.js          (정책 + schema 로딩, evaluator 인스턴스 생성)
    ├── audit.js         (JSONL 로깅 helper)
    ├── policies/
    │   └── 00-base.cedar  (minimal RBAC seed)
    └── schema.cedarschema  (entity + action 정의)
```

### 2.2 minimal seed (`00-base.cedar`)

```cedar
// LocalUser 의 create_agent: RBAC 게이트만 (전부 허용).
// 의미론 (quota / autoApprove / hard limit) 은 호출 코드의 분기에서 처리.
// 향후 사용 사례가 쌓이면 의미론을 정책으로 이관 (옵션 X 마이그레이션).
permit (
  principal is LocalUser,
  action == Action::"create_agent",
  resource is User
);
```

### 2.3 schema (`schema.cedarschema`)

```
entity LocalUser {
  id: String,
  role: String,
};

entity User {
  id: String,
};

action create_agent appliesTo {
  principal: [LocalUser],
  resource: [User],
  context: {}
};
```

(Agent entity, a2a-delegate action 등은 후속 phase 에서 추가)

### 2.4 evaluator.js API

```js
// 동기 함수 — Cedar wasm evaluate 직접 호출
export function evaluate({ principal, action, resource, context = {} }) {
  // returns { decision: 'allow' | 'deny', matchedPolicies: [...], errors: [...] }
}

// Boot 시점에 호출되어 audit 핸들 + Cedar 인스턴스를 주입받은 closure 반환
export function createEvaluator({ cedarInstance, auditWriter }) { ... }
```

호출처 (예: agent-governance.js):
```js
import { evaluate } from '../authz/cedar/evaluator.js'
const result = evaluate({
  principal: { type: 'LocalUser', id: callerId, role },
  action: 'create_agent',
  resource: { type: 'User', id: targetUsername },
})
if (result.decision !== 'allow') return Either.Left('cedar-deny')
// 이후 코드 분기에서 quota / autoApprove / hard limit
```

### 2.5 boot.js — 부팅 흐름

```js
// PresenceServer.#boot() 에서 호출
const cedar = await loadCedarRuntime()  // wasm 초기화
const policies = await loadPolicies('packages/infra/src/infra/authz/cedar/policies/')
const schema = await loadSchema('packages/infra/src/infra/authz/cedar/schema.cedarschema')
const cedarInstance = cedar.createInstance({ policies, schema })
// 파싱/로딩 실패 시 throw — 서버 부팅 실패 (fail-closed)
const auditWriter = createAuditWriter('~/.presence/logs/authz-audit.log')
const evaluator = createEvaluator({ cedarInstance, auditWriter })
// UserContext 에 evaluator 주입 → 호출처가 import 또는 ctx 경유
```

---

## 3. 구현 범위 (옵션 Y')

### 3.1 변경 파일 (신규)

- `packages/infra/src/infra/authz/cedar/evaluator.js`
- `packages/infra/src/infra/authz/cedar/boot.js`
- `packages/infra/src/infra/authz/cedar/audit.js`
- `packages/infra/src/infra/authz/cedar/policies/00-base.cedar`
- `packages/infra/src/infra/authz/cedar/schema.cedarschema`
- `packages/infra/test/cedar-evaluator.test.js` (단위)
- `packages/infra/test/cedar-boot.test.js` (인테그레이션)
- `packages/infra/test/cedar-audit.test.js` (단위)

### 3.2 변경 파일 (기존)

- `packages/infra/package.json` — `@cedar-policy/cedar-wasm` (또는 동등) 의존성 추가
- `packages/server/src/server/index.js` — `PresenceServer.#boot()` 에 Cedar boot 통합
- `packages/infra/src/infra/user-context.js` — UserContext 가 evaluator 보유 (또는 별도 singleton)

### 3.3 건드리지 않는 파일

- `agent-governance.js` — 이 phase 에선 미변경. governance-cedar v2.1 의 후속 phase 에서 Cedar 호출 추가
- 5 진입점 — runtime 무변화
- 기존 governance 테스트 (의미론 회귀) — 그대로 통과

### 3.4 Cedar wasm 패키지 선택

**검증 필요**: `@cedar-policy/cedar-wasm` 가 maintained 인지 + Node.js 동기 API 가용한지. 미존재 또는 비활성 시 대안:
- `@cedar-policy/cedar-policy-wasm` (Cedar 공식 wasm 빌드)
- 직접 빌드 (Rust → wasm-pack)

이 검증은 인프라 플랜 첫 단계 (의존성 결정).

---

## 4. 단계별 커밋 (옵션 Y')

1. **Cedar wasm 의존성 + evaluator.js**: 패키지 추가, evaluator wrapper 구현, 단위 테스트 (정책/schema 인라인 string 으로 격리 테스트)
2. **boot.js + 정책 디렉토리 + schema**: 부팅 흐름, 정책 파일 로딩, fail-closed 검증
3. **audit.js + JSONL 통합**: 로그 형식, evaluator 호출 시 자동 기록, 단위 테스트
4. **PresenceServer 통합**: `index.js` 에 boot 통합, UserContext 주입, 인테그레이션 테스트 (서버 부팅 시 evaluator 가용)

합계 약 **1~2 일 (8~12h)**, 4 커밋. 의존성 검증 (3.4) 결과에 따라 ±2h.

---

## 5. 검증 (옵션 Y')

- `npm test` 전체 회귀 (기존 4156 + 신규 단위/통합)
- 수동:
  - 서버 시작 → Cedar boot 로그 확인 (정책 1 개 로딩, schema OK)
  - `evaluate({ LocalUser, create_agent, User })` → allow + audit 한 줄 기록
  - `00-base.cedar` 에 의도적 syntax 에러 → 서버 부팅 실패 (fail-closed)
  - `50-custom.cedar` 에 deny 정책 추가 → 해당 케이스 deny + audit `decision=deny`
  - `~/.presence/logs/authz-audit.log` JSONL 형식 jq 로 파싱 가능

### 5.1 회귀 테스트 항목 (자동화 — Y' 불변식)

- **CI-Y1**: minimal seed 단독에서 `evaluate({ LocalUser/admin, create_agent, User })` allow
- **CI-Y2**: minimal seed 단독에서 `evaluate({ LocalUser/user, create_agent, User })` allow (RBAC 게이트만, role 무관)
- **CI-Y3**: 서버 boot 후 evaluator 가 UserContext 또는 singleton 으로 가용
- **CI-Y4**: audit 호출 후 `~/.presence/logs/authz-audit.log` 에 정확한 JSONL entry 추가
- **CI-Y5**: 정책 파일 syntax 에러 시 boot throw + 서버 시작 금지

이 5 항목이 Y' 의 불변식. X' 마이그레이션 시 CI-Y1/Y2/Y3 는 의미론이 풍부해지면 자연 진화, CI-Y4/Y5 는 그대로 유지.

---

## 6. 선결 조건

- 없음 (이 문서가 Cedar 도입의 첫 단계)
- 단, **Cedar wasm 패키지 가용성 검증** 이 인프라 플랜 첫 단계로 선행되어야 함 (§3.4)

---

## 7. 위험 (옵션 Y')

- **Cedar wasm 패키지 비활성**: `@cedar-policy/cedar-wasm` 가 maintained 가 아니면 직접 빌드 (Rust → wasm-pack) 필요 — 1~2 일 추가. 완화: §3.4 검증을 인프라 플랜 첫 단계에 두고, 비활성이면 옵션 Y' 자체를 재검토 (X' 보다 작은 추가 옵션 Y'' = pure-JS Cedar port 등 검토)
- **Hot reload 부재의 운영 부담**: 정책 변경 = 서버 재시작. minimal 단계에선 정책 변경 자체가 드물지만, governance v2.1 후속에서 정책 추가가 늘면 부담. 완화: 빈도 모니터링 후 X' 마이그레이션 트리거
- **Audit 로그 무한 증가**: JSONL 파일 크기 무제한. 완화: rotation policy 별도 작업 (logrotate 또는 자체 helper) — Y' 범위 밖, KG 등록 후 후속
- **Cedar 평가 latency**: 첫 호출 (wasm 부팅) + 매 evaluate 호출 비용. 완화: 인프라 구현 후 latency 벤치 (목표 < 5ms p99)
- **Op ADT wrapping 부재로 인한 finite 공간 약화**: Cedar evaluate 호출이 Op 으로 표현되지 않으면 LLM 이 자유 텍스트로 우회 가능 — 그러나 이 phase 에선 호출이 인프라 코드 (서비스 레이어) 에서만 발생, LLM 경계 밖. 향후 LLM 이 직접 권한 조회를 트리거하는 시나리오가 생기면 그때 Op 으로 wrapping

---

## Changelog

- **v1 (2026-04-25)**: Cedar 인프라 도입의 결정 항목 식별 + 메타 결정 (§1.0 = 옵션 Y' 최소) 확정 + sub-결정 1.1~1.9 자동 도출 + §2 산출물 + §3 구현 범위 + §4 단계별 커밋 + §5 검증 (CI-Y1~Y5 포함). governance-cedar v2.1 의 §6 선결조건 충족 목적. v1 governance-cedar 의 무한 리뷰 패턴을 메타 결정 명문화로 사전 차단.
