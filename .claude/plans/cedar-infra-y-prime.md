# Cedar 인프라 도입 — 옵션 Y' 최소 (5 커밋 + 사전검증)

**v1.2 (2026-04-26)**: plan-reviewer round 2 결함 (a) 4건 흡수 + (b) 1건 KG-24 등록. 커밋 수 5개로 통일, 롤백 자기모순 해소 (evaluator 필수 인자), packages/infra `files` 필드에 정적 자산 명시.

**v1.1 (2026-04-25)**: plan-reviewer round 1 결함 (a) 6건 흡수. 커밋 4 → 4a + 4b 로 분리, 검증 cross-reference 추가, 정적 자산 경로 해소 명시, 테스트 격리 정정, 롤백 의존성 명시, Node 버전 + POSIX 권한 위험 추가.

## Context

`docs/design/governance-cedar.md` v2.1 의 §6 선결조건 ("Cedar 인프라 플랜 완료, `packages/infra/src/authz/*` 모듈 존재") 충족 목적. grep 검증 결과 Cedar 인프라가 완전히 미구현 (`packages/infra/src/infra/authz/cedar/` 부재, `cedar` deps 0건, `*.cedar` 파일 0건). `send-a2a-message.js:30, 55` 에 "Cedar 이관 대상" 주석만 존재.

이 플랜은 Cedar 인프라를 옵션 **Y' (최소)** 수준으로 도입한다. 의미론은 후속 phase (governance-cedar v2.1 phase) 에서 호출처가 evaluator 를 사용하도록 박는다.

**설계 출처**: `docs/design/cedar-infra.md` v1.1 (codex single-round 리뷰 결함 흡수 후 확정). 이 플랜은 v1.1 §3~§5 를 구현 절차로 변환한다. 설계 결정 재토론 금지 — 이미 박힘.

**해결할 문제**:
1. Cedar 인프라 부재 — governance / A2A authorization phase 가 시작 불가
2. cedar-infra v1.1 §6: 별도 플랜이 작성되어 있지 않음

**범위 안**: Y' 최소 인프라 — Cedar wasm runtime, evaluator wrapper, 정적 정책 디렉토리 + minimal seed, 부팅 시 한 번 로딩, JSONL audit, fail-closed.

**범위 밖**: 호출처 통합 (governance-cedar v2.1 phase), hot reload, custom DSL, observability dashboard, DB audit, Op ADT wrapping (KG-23), entity 확장 (Agent/PeerAgent → A2A authorization phase).

---

## 핵심 설계 결정 (cedar-infra v1.1 흡수, 재토론 금지)

### A. 메타 결정 — 옵션 Y' (최소)

`docs/design/cedar-infra.md` §1.0. 정적 정책 + 단순 evaluator wrapper + JSONL audit log. 1~2 일 (8~12h) 작업, 마이그레이션 표면 작음. governance-cedar v2.1 의 옵션 Y 와 정합.

### B. Sub-결정 자동 도출 (cedar-infra v1.1 §1.1~1.9)

| 항목 | 결정 |
|---|---|
| §1.1 런타임 | wasm (`@cedar-policy/cedar-wasm` 또는 동등) |
| §1.2 정책 디렉토리 | `packages/infra/src/infra/authz/cedar/policies/` (in-source) |
| §1.3 schema 위치 | `packages/infra/src/infra/authz/cedar/schema.cedarschema` |
| §1.4 entity 모델 | LocalUser + User + create_agent action 만 (Y' phase 산출물) |
| §1.5 evaluator API | 직접 호출 함수 (Op ADT wrapping 없음, KG-23) |
| §1.6 audit | 파일 JSONL (`~/.presence/logs/authz-audit.log`, 0600 권한) |
| §1.7 boot | 부팅 시 한번 로딩, hot reload 없음 |
| §1.8 정책 우선순위 | 사전순 통합 평가 (Cedar 표준) |
| §1.9 default + 실패 | default deny + boot fail-closed + 런타임 fail-closed (deny fallback) |

### C. wasm 가용성 검증을 사전 단계로 (cedar-infra v1.1 §3.4)

플랜 첫 단계 = `@cedar-policy/cedar-wasm` 가용성 검증. 결과에 따라 시간 추정 조정:
- maintained 발견 + Node.js 동기 API 가용 → 8~12h 그대로
- 비활성/미가용 → +1~2 일 (직접 wasm-pack 빌드)
- 가용 패키지 0 → Y'' 재검토 (pure-JS Cedar port 또는 다른 정책 엔진), 플랜 중단 후 design 재작성

검증 통과까지 의존성 commit 미수행. 통과 후 진행.

### D. Y' 의 enforcement point 만 박는 의도 (cedar-infra v1.1 §3.3)

이 phase 는 의미론을 박지 않는다. minimal seed = "전부 allow". 호출처 (`agent-governance.js`) 에 evaluate 호출 추가는 governance-cedar v2.1 phase 의 책임. 인프라 phase 단독 머지는 enforcement 없는 evaluator 도입 = 기존 코드 분기 그대로 작동 = 의미론 우회 위험 0. 단 인프라 + governance phase 머지 간격을 최소화.

---

## 사전 검증 단계 (커밋 없음)

### Pre-1. wasm 패키지 가용성 조사

```bash
# 후보 1: Cedar 공식 wasm 빌드
npm view @cedar-policy/cedar-wasm 2>&1
npm view @cedar-policy/cedar-policy-wasm 2>&1

# 후보 2: maintained fork 검색
npm search cedar-policy 2>&1
```

확인 항목:
- 패키지 존재 + 최근 1년 내 maintained
- Node.js (ESM) 동기 또는 동기적 API 호출 가능 (이 플랜은 evaluate 가 동기 함수 가정)
- TypeScript types 또는 사용 예제

검증 결과 분기:
- **OK**: §3.1 의 `package.json` 의존성으로 그 패키지 fix → 커밋 1 진행
- **부재/비활성**: Rust + wasm-pack 직접 빌드 검토 → +1~2 일. 플랜 갱신 후 진행
- **0 가용**: 플랜 중단, cedar-infra design 으로 돌아가 Y'' 옵션 작성

검증 결과는 plan-reviewer 통과 후 첫 commit 메시지에 명시.

---

## 구현 (커밋 5 개 — 1, 2, 3, 4a, 4b)

### 커밋 1 — wasm 의존성 + evaluator.js + 단위 테스트

**`packages/infra/package.json`**:
- Pre-1 결정 패키지 추가 (예: `@cedar-policy/cedar-wasm@^x.y.z`)
- `npm install` 후 lockfile 갱신
- **`files` 필드에 정적 자산 명시 (plan-reviewer round 2 항목 3 처방)**:
  ```json
  {
    "files": [
      "src/**/*.js",
      "src/infra/authz/cedar/policies/**/*.cedar",
      "src/infra/authz/cedar/*.cedarschema"
    ]
  }
  ```
  - 기존 `files` 항목 유지하면서 정적 자산 glob 추가 (현재 구조 검토 후 정확한 형태 결정 — 현재 `files` 필드 자체 부재라면 위 형태로 신설, 존재하면 cedar 자산 라인만 추가)
  - 이유: 4a 의 `paths.js` 가 `import.meta.url` 로 `policies/*.cedar` + `schema.cedarschema` 를 절대 경로 해석. 이 정적 자산들이 패키지 publish/번들 시 누락되면 boot 단계에서 readFileSync ENOENT — boot fail-closed 로 서버 부팅 실패. 모노레포 workspace 심볼릭 링크 환경에선 즉시 영향 없으나, 향후 publish/bundling 도구가 `files` 필드 기준으로 자산 수집할 때 안전망 제공
  - 검증: `npm pack --dry-run` 로 tarball 내용 확인 — `policies/00-base.cedar` + `schema.cedarschema` 포함되는지

**`packages/infra/src/infra/authz/cedar/evaluator.js`** (신규):
```js
// Cedar wasm wrapper. evaluate 는 동기 함수.
// 호출처에서 직접 import + 호출 (Op ADT wrapping 없음 — KG-23).

export function createEvaluator({ cedarInstance, auditWriter }) {
  return function evaluate({ principal, action, resource, context = {} }) {
    try {
      const result = cedarInstance.isAuthorized({
        principal: `${principal.type}::"${principal.id}"`,
        action: `Action::"${action}"`,
        resource: `${resource.type}::"${resource.id}"`,
        context,
      })
      auditWriter.append({
        ts: new Date().toISOString(),
        caller: principal.id,
        action,
        resource: resource.id,
        decision: result.decision,
        matchedPolicies: result.matchedPolicies ?? [],
        errors: [],
      })
      return result
    } catch (err) {
      // 런타임 fail-closed: deny + audit errors
      const failResult = { decision: 'deny', matchedPolicies: [], errors: [String(err)] }
      auditWriter.append({
        ts: new Date().toISOString(),
        caller: principal.id,
        action,
        resource: resource.id,
        ...failResult,
      })
      return failResult
    }
  }
}
```

**`packages/infra/test/cedar-evaluator.test.js`** (신규):
- **CE1**: minimal seed 인라인 + admin → allow + audit 기록
- **CE2**: minimal seed 인라인 + user → allow (RBAC 게이트만, role 무관) — CI-Y1/Y2
- **CE3**: deny 정책 인라인 + 해당 케이스 → deny + matchedPolicies 정확
- **CE4**: cedarInstance 가 throw → deny fallback + errors 기록 — CI-Y7

테스트는 Cedar wasm 인스턴스를 mock 또는 인라인 실 인스턴스로 격리. boot 흐름 미사용.

### 커밋 2 — boot.js + 정책 디렉토리 + schema + 통합 테스트

**`packages/infra/src/infra/authz/cedar/policies/00-base.cedar`** (신규):
```cedar
// LocalUser 의 create_agent: RBAC 게이트만 (전부 허용).
// 의미론 (quota / autoApprove / hard limit) 은 호출 코드 분기에서 처리.
permit (
  principal is LocalUser,
  action == Action::"create_agent",
  resource is User
);
```

**`packages/infra/src/infra/authz/cedar/schema.cedarschema`** (신규):
```
entity LocalUser { id: String, role: String };
entity User { id: String };
action create_agent appliesTo {
  principal: [LocalUser],
  resource: [User],
  context: {}
};
```

**`packages/infra/src/infra/authz/cedar/boot.js`** (신규):
```js
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export async function bootCedar({ policiesDir, schemaPath }) {
  const cedar = await import('@cedar-policy/cedar-wasm')  // Pre-1 결정 따름
  const schema = readFileSync(schemaPath, 'utf-8')
  const policyFiles = readdirSync(policiesDir)
    .filter(f => f.endsWith('.cedar'))
    .sort()  // 사전순 (§1.8)
  const policies = policyFiles.map(f =>
    readFileSync(join(policiesDir, f), 'utf-8')
  ).join('\n\n')
  // boot fail-closed: parse 실패 시 throw → 서버 부팅 실패
  return cedar.createInstance({ schema, policies })
}
```

**`packages/infra/test/cedar-boot.test.js`** (신규):
- **CB1**: 정상 minimal seed → boot 성공 + evaluator 가용 — CI-Y3
- **CB2**: schema 의도적 syntax 에러 → boot throw — CI-Y5 (boot fail-closed)
- **CB3**: policy 의도적 syntax 에러 → boot throw — CI-Y5
- **CB4**: 정책 파일 다중 (`00-base.cedar` + `50-custom.cedar` deny 정책) → 사전순 통합 평가, deny 케이스 deny 반환 — CI-Y6 (deny-path 자동화)
- **CB5**: 빈 policies 디렉토리 → boot throw 또는 default deny 검증

### 커밋 3 — audit.js + JSONL + 0600 권한

**`packages/infra/src/infra/authz/cedar/audit.js`** (신규):
```js
import { appendFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function createAuditWriter(logPath) {
  // 디렉토리 + 파일 생성 시점에 0600 적용
  if (!existsSync(dirname(logPath))) mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 })
  return {
    append(entry) {
      const line = JSON.stringify(entry) + '\n'
      appendFileSync(logPath, line, { mode: 0o600 })
      try { chmodSync(logPath, 0o600) } catch {}  // 기존 파일 권한 보정
    }
  }
}
```

**`packages/infra/test/cedar-audit.test.js`** (신규):
- **CA1**: append 후 JSONL 한 줄 정확 (jq 파싱 가능) — CI-Y4
- **CA2**: 새 파일 생성 시 0600 권한
- **CA3**: 기존 파일 권한이 0644 면 0600 으로 보정
- **CA4**: 디렉토리 부재 시 0700 으로 생성
- **CA5**: 한 evaluate 호출당 정확히 한 audit entry

### 커밋 4a — PresenceServer 부팅 통합 + 정적 자산 경로 해소

**정적 자산 경로 해소 (plan-reviewer 항목 3 처방)**:

`packages/infra` 의 `*.cedar`/`*.cedarschema` 자산은 ESM `import.meta.url` 기반으로 인프라 패키지 안에서 절대 경로를 계산. server 패키지는 인프라가 노출하는 *경로 helper* 만 호출 — 자산 직접 참조 안 함:

**`packages/infra/src/infra/authz/cedar/paths.js`** (신규, 인프라 내부에서만 자산 위치 알고 있음):
```js
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

export const POLICIES_DIR = join(here, 'policies')
export const SCHEMA_PATH = join(here, 'schema.cedarschema')
```

**`packages/infra/src/infra/authz/cedar/index.js`** (신규, public entry):
```js
import { bootCedar } from './boot.js'
import { createEvaluator } from './evaluator.js'
import { createAuditWriter } from './audit.js'
import { POLICIES_DIR, SCHEMA_PATH } from './paths.js'

// 일괄 부팅 helper. server 가 이것만 호출 — 정적 자산 경로 노출 없음
export async function bootCedarSubsystem({ presenceDir }) {
  const cedarInstance = await bootCedar({
    policiesDir: POLICIES_DIR,
    schemaPath: SCHEMA_PATH,
  })
  const auditWriter = createAuditWriter(`${presenceDir}/logs/authz-audit.log`)
  return createEvaluator({ cedarInstance, auditWriter })
}
```

**`packages/server/src/server/index.js`** (수정):
- `PresenceServer.#boot()` 흐름에 `bootCedarSubsystem({ presenceDir: Config.presenceDir() })` 호출 추가
- boot 실패 시 throw → server.create() 가 reject (process exit 안 함)
- evaluator 를 `PresenceServer` 인스턴스 필드로 보유 (UserContext 변경은 4b 에서)

```js
// PresenceServer.#boot() 안
import { bootCedarSubsystem } from '@presence/infra/infra/authz/cedar/index.js'
this.evaluator = await bootCedarSubsystem({ presenceDir: this.config.presenceDir() })
// UserContext 주입은 4b 에서
```

**`packages/server/test/server.test.js`** (수정 또는 신규 케이스):
- **SC-Y1a**: 서버 부팅 성공 → `presenceServer.evaluator` 함수로 가용 — CI-Y3 통합 검증
- **SC-Y2**: 정책 syntax 에러 fixture (`bootCedar` 가 throw 하도록 mock 또는 비정상 정책) → `PresenceServer.create()` reject — boot fail-closed 검증. **process exit 검증 안 함** (현 `createTestServer` 헬퍼와 격리, plan-reviewer 항목 4 처방)
- **SC-Y3**: 정상 부팅 후 `evaluator({ LocalUser admin, create_agent, User })` 1 회 호출 → audit log 파일 entry 1 줄

이 커밋의 단일 책임: **server 부팅에 Cedar 통합 + 정적 자산 경로 해소**.

### 커밋 4b — UserContext evaluator 주입 + 호출 인터페이스

**`packages/infra/src/infra/user-context.js`** (수정):
- `UserContext` constructor 가 `evaluator` 인자를 **필수** 로 받음 (`opts.evaluator` 부재 또는 falsy 시 throw — Cedar 인프라가 부팅된 상태가 invariant)
- `userContext.evaluator(...)` 로 호출처가 사용 (또는 import 경로)

**`packages/server/src/server/user-context-manager.js`** (수정):
- `getOrCreate(username)` 시 `presenceServer.evaluator` 를 UserContext 에 전달 (필수 인자)

**`packages/infra/test/user-context.test.js`** (수정 또는 신규):
- **UC-Y1**: UserContext 가 evaluator 보유 → `userContext.evaluator({...})` 정상 동작
- **UC-Y2**: evaluator 미전달 (`new UserContext({ ... })` 에 `evaluator` 부재) → constructor throw — invariant 검증 (legacy fallback 없음)

**evaluator 필수 인자 결정 근거 (plan-reviewer round 2 항목 5 처방 (i))**: "선택 인자 + fallback" 패턴은 롤백 표 ("4a 단독 revert → 4b 호환 깨짐") 와 자기모순. 실제 사용에서 evaluator 부재 상태로 UserContext 만드는 시나리오가 없음 (Cedar boot 가 PresenceServer.#boot() 의 본질적 산출물, §3.3 참조). invariant 로 박아 모순 해소.

기존 테스트 호환성 영향: `UserContext` 직접 인스턴스화하는 테스트가 있다면 mock evaluator 주입 필요. 주요 영향 grep:

```bash
grep -rn "new UserContext\|UserContext.create" packages/ --include="*.test.js"
```

이 커밋의 단일 책임: **호출 인터페이스 노출 (UserContext)** + **Cedar invariant 강제**. 4a 와 분리되어 실패 시 원인 분리 명확.

---

## 재사용 실사

- **`Config.presenceDir()`** (`packages/infra/src/infra/config.js`) — audit log 경로의 베이스. 재사용
- **`UserContext`** — evaluator 주입 대상. 기존 라이프사이클 활용
- **`PresenceServer.#boot()`** — Cedar boot 통합 지점. 기존 부트 흐름 확장
- **better-sqlite3 패턴 (동기 API)** — Cedar wasm 도 동기 호출 가정. presence 의 일관성

신규 추상 = Cedar wrapper 3 모듈 (evaluator/boot/audit). 도메인 특정 추상은 도입 안 함 (Op wrapping = KG-23 후속).

---

## 검증

### 단위
- `node packages/infra/test/cedar-evaluator.test.js` — CE1~CE4 (CI-Y1/Y2/Y7)
- `node packages/infra/test/cedar-boot.test.js` — CB1~CB5 (CI-Y3/Y5/Y6)
- `node packages/infra/test/cedar-audit.test.js` — CA1~CA5 (CI-Y4)

### 통합
- `node packages/server/test/server.test.js` — SC-Y1a/Y2/Y3
- `node packages/infra/test/user-context.test.js` — UC-Y1/Y2
- `npm test` 전체 — 4156 passed → 4156 + 신규 테스트 (예상 15~18)

### 검증 범위 (이 phase 단독 vs governance phase 결합)

이 phase 단독 검증은 **evaluator 의 동작 + boot 통합 + audit 기록 + UserContext 노출** 만 보장. **enforcement point 의 호출 정합성** (`submitUserAgent` 가 evaluator 를 정확히 한 번 호출 + allow 받음 + 코드 분기 정상 동작) 은 governance-cedar v2.1 phase 의 GV-Y1~Y4 테스트가 담당. cedar-infra v1.1 §5.1 의 CI-Y1~Y7 + governance-cedar v2.1 §5.1 의 GV-Y1~Y4 가 합쳐져야 옵션 Y' 의 enforcement 가 *완전 검증*.

| 검증 단위 | 매핑 | 검증 시점 |
|---|---|---|
| CI-Y1 (admin allow) | `cedar-evaluator.test.js` CE1 | 이 phase |
| CI-Y2 (user allow) | `cedar-evaluator.test.js` CE2 | 이 phase |
| CI-Y3 (evaluator boot 후 가용) | `server.test.js` SC-Y1a | 이 phase |
| CI-Y4 (audit JSONL 정확) | `cedar-audit.test.js` CA1 | 이 phase |
| CI-Y5 (boot fail-closed) | `cedar-boot.test.js` CB2/CB3 | 이 phase |
| CI-Y6 (deny-path 자동화 — 정책/엔진 측만, 호출 정합성은 KG-24) | `cedar-boot.test.js` CB4 | 이 phase |
| CI-Y7 (런타임 fail-closed) | `cedar-evaluator.test.js` CE4 | 이 phase |
| GV-Y1~Y4 (호출 정합성 — KG-24 해소 경로) | governance-cedar v2.1 phase | **다음 phase** |

코드 사실: 현재 `submitUserAgent` 에 Cedar 훅 없음 — 이 plan 에서 호출처를 박지 *않음* (governance-cedar v2.1 phase 책임). 이 분리가 위험 항목 "minimal seed 전부 allow 의미론 우회" 의 안전망 (인프라 단독 머지 시점에 호출처가 evaluator 미사용 = enforcement 부재 = 의미론 우회 위험 0).

### 수동
- 서버 시작 → Cedar boot 로그 확인 (정책 1 개 로딩, schema OK)
- `~/.presence/logs/authz-audit.log` 생성 + 0600 권한 (`stat -f "%p"`)
- `00-base.cedar` 의도적 syntax 에러 (예: `permit (` 불완전) → 서버 부팅 실패
- `50-custom.cedar` 일시 추가 (`forbid (principal is LocalUser, action == Action::"create_agent", resource is User) when { principal.id == "blocked-user" };`) + evaluate({ blocked-user, ... }) → deny + audit `decision=deny`. 테스트 후 정책 파일 삭제

---

## 위험 / 완화 (cedar-infra v1.1 §7 흡수)

| 위험 | 완화 |
|---|---|
| Cedar wasm 패키지 비활성/부재 | Pre-1 가용성 검증을 첫 단계로. 미가용 시 직접 wasm-pack 빌드 (+1~2일) 또는 Y'' 재검토 |
| Hot reload 부재 운영 부담 | minimal 단계엔 정책 변경 드물음. 사용 사례 쌓이면 X' 마이그레이션 트리거 |
| Audit 로그 무한 증가 | rotation 별도 작업 (logrotate 또는 자체 helper). Y' 범위 밖 — 후속 KG 등록 |
| Cedar latency | 인프라 구현 후 벤치 (목표 < 5ms p99). 미달 시 caching 검토 (X' 영역) |
| Op wrapping 부재 (KG-23) | 인프라 phase 호출처가 서비스 레이어 (LLM 경계 밖). LLM 직접 트리거 시나리오 생기면 도입 |
| **CI-Y6 호출 정합성 미검증 (KG-24)** | 이 phase 의 CI-Y6 은 정책/엔진 측 deny 능력만 검증. 호출처 (`agent-governance.js`) 가 evaluator 를 정확히 호출하는지는 governance-cedar v2.1 phase 의 GV-Y1~Y4 가 담당. 인프라 단독 머지 시점엔 호출처 미사용 = enforcement 부재 = 의미론 우회 위험 0 (안전망). governance phase 와 머지 간격 최소화로 완화 |
| Minimal seed "전부 allow" 의 의미론 우회 | **인프라 단독 머지 금지** — governance-cedar v2.1 phase 와 함께 머지. 인프라만 단독 머지 시점엔 호출처가 evaluator 를 사용하지 않으므로 enforcement 부재 = 기존 코드 분기 그대로 작동 = 의미론 우회 위험 0. 단 머지 간격 최소화 |
| Audit log 권한 0644 (다른 사용자 읽기) | `audit.js` 에서 0600 명시 적용 + 기존 파일 권한 보정 (`chmodSync` try/catch) |
| **Node.js 버전 의존**: Cedar wasm 패키지가 특정 Node 버전 (예: 18+ ESM 동기 import) 요구. 기존 presence 가 그보다 낮은 Node 지원 시 incompatible | Pre-1 단계에서 `npm view <pkg> engines` 확인 + `packages/infra/package.json` 의 `engines` 필드에 명시. 기존 다른 패키지 engines 와 충돌 시 Y' 자체 재검토 |
| **POSIX 권한 의미 차이 (Windows)**: `chmodSync(0o600)` 는 Windows 에서 read-only 비트만 영향, POSIX 권한 의미와 다름. 다른 사용자 차단 효과 없음 | Y' 범위에서 Windows 보안 보장 불가 명시. 운영 가정: presence 서버는 macOS/Linux 환경. Windows 배포 시점에 별도 KG 등록 후 처리 (NTFS ACL 등). cedar-infra design 의 후속 검토 항목 |

---

## 롤백

**커밋 의존성 (단독 revert 가능 여부)**:

| 커밋 | 단독 revert 가능? | 이유 |
|---|---|---|
| 4b (UserContext 주입) | **단독 불가** | 4b 의 UserContext invariant (evaluator 필수 인자) 가 4a 의 evaluator 가용성에 의존. 4a 단독 revert 시 4b 가 throw — 4a + 4b 함께 revert |
| 4a (server boot 통합) | **단독 불가** | 4b 가 4a 의 evaluator 에 invariant 로 의존 — 4a 단독 revert 시 4b throw. 4a + 4b 함께 revert |
| 3 (audit.js) | **단독 불가** | 1 의 evaluator 가 audit 사용 → 3 revert 만 하면 evaluator 부팅 실패. 3 + 4a + 4b 함께 revert |
| 2 (boot + 정책 + schema) | **단독 불가** | 1 의 evaluator 가 cedarInstance 의존 → 2 revert 시 evaluator 미부팅. 2~4b 묶음 revert |
| 1 (wasm + evaluator) | **단독 불가** | 2~4b 가 1 의 evaluator 에 의존 (역방향). 1 revert 시 2~4b 모두 깨짐. 1~4b 묶음 revert |

**모든 커밋이 단독 revert 불가** — Y' 인프라는 5 커밋 묶음으로 atomic. 부분 revert 시 항상 4b 의 invariant 가 깨짐 (evaluator 필수 인자, 4b commit 후 시점부터). 권장 운영 rollback 단위: **1~4b 전체 묶음 revert (5 커밋)**.

**권장 운영 rollback 단위**: 1~4b 전체 묶음 revert (5 커밋). 부분 revert 는 의존성 충돌 위험.

**운영 rollback (feature flag 없음)**:
- Y' 는 의도적으로 feature flag 미도입. 인프라 단독 머지 후 호출처 미박힘 상태에서는 evaluator 가용성만 영향 — 호출처 (governance phase) 가 박힌 후엔 1~4b + governance phase 묶음 revert

**데이터 rollback**:
- audit log 파일 삭제 (감사 추적 손실, 서비스 영향 0)
- 정책 변경 = 코드 PR 이므로 git revert

---

## 후속

- **governance-cedar v2.1 phase** (의미론 호출처 통합) — 이 플랜 머지 직후 진행. governance-cedar.md §3~§4
- **a2a-authorization phase** (KG-17 해소) — A2A JWT + Cedar entity 확장
- **capability migration** (Y' → X' 검토) — 사용 사례 쌓인 후
- **KG-23 해소** — LLM 직접 트리거 시나리오 발생 시 Op ADT wrapping 도입
- **Audit rotation 정책** — Y' 범위 밖. 별도 KG 등록 필요 시 추가

---

## 일정 (추정)

| 단계 | 시간 |
|---|---|
| Pre-1 wasm 가용성 검증 | 1~2h |
| 커밋 1 (의존성 + evaluator + 단위 테스트) | 2~3h |
| 커밋 2 (boot + 정책 + schema + 통합 테스트) | 2~3h |
| 커밋 3 (audit + 권한 + 단위 테스트) | 1~2h |
| 커밋 4a (server boot 통합 + 정적 자산 경로 + SC-Y1a/Y2/Y3) | 1.5h |
| 커밋 4b (UserContext 주입 + UC-Y1/Y2) | 1h |

합계 약 **8.5~13.5h** (Pre-1 가용 시). wasm 직접 빌드 시 +1~2 일. 5 커밋.
