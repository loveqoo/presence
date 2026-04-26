# Cedar 인프라 — 도입의 최소 표면 결정

**Status**: 2026-04-26 v1.2 (Y' 인프라 구현 완료, governance v2.2 의미론 통합과 머지 대기). 이전 v1.1 (2026-04-25): codex single-round 리뷰 결함 7 건 (a) 흡수 + 1 건 (b) KG-23 등록.

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
- 단점:
  - 운영 중 정책 변경 시 서버 재시작 필요
  - audit 분석 도구 자체 구축 (jq 등으로)
  - Cedar evaluate 호출 latency (wasm 부팅 + 매 호출 비용, §7 위험과 정합)
  - Audit JSONL 파일 크기 무제한 (rotation policy 별도 작업, §7 위험과 정합)
  - Cedar evaluate 호출이 Op ADT 로 wrapping 되지 않음 — finite 선택 공간 강제 약화. KG-23 등록, 향후 LLM 이 직접 권한 조회를 트리거하는 시나리오에서 도입 예정

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

### 1.4 Entity 모델 (Y' 자동 도출 → minimal, a2a-authorization.md 의 CallerIdentity 정의 부분집합)

Entity 모델 출처: `docs/design/a2a-authorization.md` line 82, 100~123 의 CallerIdentity (`{ type: 'LocalUser' | 'LocalAgent' | 'PeerAgent', id, attrs }`). agent-identity-model.md 는 AgentId canonical form 만 정의.

**확정 — Y' phase 산출물에 포함**:
- `LocalUser` (principal): `id: String`, `role: String` ("admin" | "user")
- `User` (resource): `id: String` (username)
- `Action`: `create_agent` (governance 첫 사용)

**후속 phase 산출물 (Y' phase 에서 schema 정의 안 함)**:
- `LocalAgent`, `PeerAgent` (resource, A2A authorization phase)
- `a2a-delegate`, `read-memory` 등 추가 action

§2.3 schema 와 일관: 이번 phase 에서는 LocalUser + User + create_agent 만 작성. Agent entity 도입은 a2a-authorization phase 에서 schema 갱신.

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

**범위 정당화**: `server/index.js` + `user-context.js` 변경은 governance-cedar v2.1 §6 선결조건 ("authz/* 모듈 존재") 의 표면 해석상 범위 초과로 보일 수 있으나, Cedar evaluator 가 사용 가능하려면 *부팅 시점에 정확히 한 번 로딩되어야 함* (§1.7 Y' 결정). Cedar 인프라 산출물이 동작하는 상태 = 서버에서 호출 가능한 상태. 따라서 boot 통합은 인프라 phase 의 본질적 산출물이며 이 phase 에 포함되어야 한다. 분리 시 인프라 phase 의 검증 자체가 불가능 (§5 의 "서버 시작 → Cedar boot 로그 확인" 시나리오가 인프라 phase 외부에서 실행되어야 함).

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

합계 약 **1~2 일 (8~12h)**, 4 커밋. **추정 단서**: 이 추정치는 §3.4 wasm 패키지 가용성이 검증된 (`@cedar-policy/cedar-wasm` 또는 동등 maintained 패키지가 Node.js 동기 API 가용) 시나리오 기준. 인프라 플랜 첫 단계에서 가용성 검증 후:
- maintained 패키지 발견 → 8~12h 그대로
- 비활성 패키지만 존재 → +1~2 일 (직접 wasm-pack 빌드 또는 fork maintenance)
- 가용 패키지 0 → Y' 자체 재검토 (옵션 Y'' = pure-JS Cedar port 또는 다른 정책 엔진 검토). 이 경우 plan 수정 후 재 design.

따라서 "8~12h" 는 첫 단계 검증 통과를 전제로 한 lower bound.

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
- **CI-Y5**: 정책 파일 syntax 에러 시 boot throw + 서버 시작 금지 (boot fail-closed)
- **CI-Y6** (신설, deny-path 자동화): `policies/50-custom.cedar` 에 `forbid (principal is LocalUser, action == Action::"create_agent", resource is User) when { principal.id == "blocked-user" };` 정책 일시 추가 → `evaluate({ LocalUser id="blocked-user", create_agent, User })` 가 deny 반환 + audit `decision=deny` + `matchedPolicies=["50-custom"]`. 테스트 종료 후 정책 파일 정리. enforcement point 가 실제 deny 를 반환할 수 있는 능력의 자동 검증. **호출 정합성 미검증** (KG-24): 이 항목은 정책/엔진 측 deny 능력만 검증, 실제 호출처 (`agent-governance.js`) 가 evaluator 를 정확히 호출하는지는 governance-cedar v2.1 phase 의 GV-Y1~Y4 가 담당
- **CI-Y7** (신설, 런타임 fail-closed): evaluator 가 던지는 stub (Cedar 호출 직전 throw 주입) → 호출처에서 deny 로 fallback + audit `errors: [...]` + `decision=deny`. §1.9 의 런타임 fail-closed 정의 검증

이 7 항목이 Y' 의 불변식. X' 마이그레이션 시 CI-Y1/Y2/Y3 는 의미론이 풍부해지면 자연 진화, CI-Y4/Y5/Y6/Y7 는 그대로 유지.

---

## 6. 선결 조건

- 없음 (이 문서가 Cedar 도입의 첫 단계)
- 단, **Cedar wasm 패키지 가용성 검증** 이 인프라 플랜 첫 단계로 선행되어야 함 (§3.4)

---

## 7. 위험 (옵션 Y')

- **Cedar wasm 패키지 비활성**: `@cedar-policy/cedar-wasm` 가 maintained 가 아니면 직접 빌드 (Rust → wasm-pack) 필요 — 1~2 일 추가. 완화: §3.4 검증을 인프라 플랜 첫 단계에 두고, 비활성이면 옵션 Y' 자체를 재검토 (X' 보다 작은 추가 옵션 Y'' = pure-JS Cedar port 등 검토)
- **Hot reload 부재의 운영 부담**: 정책 변경 = 서버 재시작. minimal 단계에선 정책 변경 자체가 드물지만, governance v2.1 후속에서 정책 추가가 늘면 부담. 완화: 빈도 모니터링 후 X' 마이그레이션 트리거
- ~~**Audit 로그 무한 증가** (KG-25)~~: ~~JSONL 파일 크기 무제한. 완화: rotation policy 별도 작업 (logrotate 또는 자체 helper) — Y' 범위 밖, KG-25 로 등록.~~ resolved by feature/cedar-governance-v2 (2026-04-26). `audit.js` 에 size-based rotation 구현. 매 `append` 직전 `statSync` 로 size 체크 → `maxBytes` (기본 10MB) 초과 시 cascade rotation: `.maxBackups.gz` 삭제 → `.N.gz → .(N+1).gz` (역순) → 현재 → `.1.gz` (gzip 압축, 0600). `maxBackups` 기본 5. 단일 프로세스 가정 (멀티 프로세스 동시 append race 는 Y' 범위 밖). CA7~CA11 회귀 검증.
- **Cedar 평가 latency**: 첫 호출 (wasm 부팅) + 매 evaluate 호출 비용. 완화: 인프라 구현 후 latency 벤치 (목표 < 5ms p99)
- **Op ADT wrapping 부재로 인한 finite 공간 약화**: Cedar evaluate 호출이 Op 으로 표현되지 않으면 LLM 이 자유 텍스트로 우회 가능 — 그러나 이 phase 에선 호출이 인프라 코드 (서비스 레이어) 에서만 발생, LLM 경계 밖. 향후 LLM 이 직접 권한 조회를 트리거하는 시나리오가 생기면 그때 Op 으로 wrapping. KG-23 으로 등록
- **Minimal seed 의 "전부 allow" 가 보안상 의도적 감수 위험**: Y' phase 의 `00-base.cedar` 는 `LocalUser create_agent` 를 *role 무관 전부 허용* (§2.2). 이는 governance-cedar v2.1 의 옵션 Y (의미론은 코드 분기에서 quota / autoApprove / hard limit 처리) 와 정합되도록 설계된 의도된 결과지만, **인프라 phase 단독 시점** (governance-cedar 후속 phase 미적용 상태) 에선 의미론 게이트가 부재할 수 있음. 완화: 인프라 phase 의 PR 머지는 governance-cedar v2.1 phase 와 *함께* 진행 (인프라 단독 머지 금지, 또는 머지 직후 즉시 governance phase 진행). 실제 호출처 (`agent-governance.js`) 에 Cedar 호출이 추가되기 전까지는 evaluator 가 가용하지만 어디에서도 호출되지 않는 상태로 유지 — 이 상태는 의미론 우회 위험이 없음 (호출 부재 = enforcement 부재 = 기존 코드 분기 그대로 작동)
- **Audit 로그 권한**: `~/.presence/logs/authz-audit.log` 가 OS 권한 0644 기본일 가능성. 다른 사용자가 읽을 수 있음. 완화: 파일 생성 시 0600 명시 적용 (audit.js 구현부에서 fs.chmod). Y' phase 산출물에 포함

---

## Changelog

- **v1.2 (2026-04-26)**: Y' 인프라 구현 완료. `feature/cedar-governance-v2` 브랜치 5 커밋 (270a38c~52ef096). evaluator (Reader.asks) + boot (3중 parse fail-closed) + audit (JSONL 0600) + paths.js + bootCedarSubsystem + PresenceServer/UserContext invariant 주입. CI-Y1/Y2 (CE1~CE3), CI-Y3 (SC-Y1a + CB1), CI-Y4 (CA1), CI-Y5 (CB2/CB3), CI-Y6 (CB4 — KG-24 호출 정합성은 governance phase 의 GV-Y1~Y4 가 담당), CI-Y7 (CE4) 자동화 완료. Pre-1 wasm 가용성 PASS (`@cedar-policy/cedar-wasm@4.10.0`, AWS 공식, sync API). 87 신규 assertions.
- **v1.1 (2026-04-25)**: codex single-round 리뷰 결함 7 건 (a) 흡수 + 1 건 (b) KG-23 등록.
  - Q1: §1.0 Y' 단점에 latency + audit 무한 증가 + Op wrapping 부재 추가 (§7 와 정합)
  - Q2: §1.4 entity 모델 출처를 a2a-authorization.md (CallerIdentity 정의) 로 정정. Y' phase 산출물 (LocalUser/User/create_agent) vs 후속 phase (LocalAgent/PeerAgent/추가 action) 분리 명시 — §2.3 schema 와 정합. 1.5 Op wrapping 부재는 KG-23 으로 등록 (b 분류)
  - Q3: §3.2 server/index.js + user-context.js 변경의 범위 정당화 명시 (Cedar boot 통합은 인프라 phase 본질). §4 추정 8~12h 의 단서 추가 — wasm 가용성 검증 통과를 전제로 한 lower bound, 미가용 시 조정 시나리오 명시
  - Q4: §5.1 에 CI-Y6 (deny-path 자동화), CI-Y7 (런타임 fail-closed) 신설. §7 에 minimal seed "전부 allow" 가 보안상 의도적 감수 위험으로 명시 + 인프라 단독 머지 금지 정책. audit 로그 0600 권한 위험 + 완화 추가
- **v1 (2026-04-25)**: Cedar 인프라 도입의 결정 항목 식별 + 메타 결정 (§1.0 = 옵션 Y' 최소) 확정 + sub-결정 1.1~1.9 자동 도출 + §2 산출물 + §3 구현 범위 + §4 단계별 커밋 + §5 검증 (CI-Y1~Y5 포함). governance-cedar v2.1 의 §6 선결조건 충족 목적. v1 governance-cedar 의 무한 리뷰 패턴을 메타 결정 명문화로 사전 차단.
