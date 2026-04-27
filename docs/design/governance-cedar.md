# Governance Cedar 연결 — 설계 결정 필요 과제

**Status**: 2026-04-27 v2.4 (KG-26 admin 면제 흡수). v2.3 (Phase 1 quota) 위에 admin 면제 + hardLimit 도 Cedar 정책으로 이관. 11-admin-limit.cedar 신규 — `context.isAdmin && context.currentCount >= context.hardLimit` 일 때 forbid. 10-quota.cedar 는 `!isAdmin` 조건 추가. autoApprove=false manual_review 는 여전히 코드 잔류 (Cedar 표현 한계 third state). schema.context 4 필드 (currentCount/maxAgents/isAdmin/hardLimit). §X 는 hybrid 의미론 표 갱신.

**Owner**: Presence core.

**관련 문서**:
- [`a2a-authorization.md`](a2a-authorization.md) — Cedar 도입 전반 설계
- [`agent-identity-model.md`](agent-identity-model.md) §8 — governance 흐름 (quota / approve / admin override)
- [`a2a-transport.md`](a2a-transport.md) — 별도의 A2A 통신 연결 후속 (독립)

---

## 0. 이 문서의 이유

Cedar 를 `agent-governance.js` 의 quota 판정에 연결하려면 **의미론 결정** 4~5 개가 얽혀 있다. plan-reviewer 가 4차례 HIGH 를 지적했고, 각 지적의 공통 뿌리는 "기존 설계 문서의 governance 동작" 과 "Cedar 평가 도입" 사이의 경계가 명확히 그어지지 않은 것이다.

이 문서는 그 결정 포인트를 나열한다. 결정이 확정되면 새 플랜을 작성한다.

---

## 1. 결정해야 할 의미론 (순서대로)

### 1.0 의미론 집중도 원칙 (메타 결정)

§1.1~1.3 sub-결정은 모두 단일 원칙 — **"Cedar 에 governance 의미론을 어디까지 흡수시킬 것인가"** — 의 적용. 메타 결정이 implicit 인 채로 sub-결정을 동시 토론하면 매 라운드 다른 sub-결정의 단점이 메타 결정의 우려로 표면화 → 무한 리뷰. v1 의 plan-reviewer 4 회 HIGH 가 이 패턴이었다.

이 결정을 먼저 박으면 §1.1~1.3 은 자동 도출 (별도 토론 불필요).

**옵션 X — 집중**: Cedar 에 governance 의미론 흡수 (1.1-A + 1.2-A + 1.3-A 조합)
- 장점: 의미론의 single source of truth = Cedar 정책. 정책 추가만으로 거버넌스 변경 가능
- 단점: context 스키마 풍부, Cedar 정책 복잡도 증가, 잘못 박힌 의미론의 마이그레이션 비용 (사용처 늘수록 큼)

**옵션 Y — 최소**: Cedar 는 RBAC 게이트만, 의미론은 코드 (1.1-A + 1.2-B + 1.3-B 조합)
- 장점: Cedar 정책 단순, 회복 가능성, 수렴 용이 (토론 표면 작음). "Cedar 가 박힐 자리" 를 먼저 박고 의미론은 사용 사례가 쌓인 후 재평가
- 단점: 의미론이 두 층 (Cedar / 코드) 에 분산. 첫 인상이 "Cedar 가 trivial 해서 도입 가치 의문". minimal seed 라도 Cedar evaluate 호출 추가 = 부하 발생 (의미 있는 deny 가 없어도 비용은 지불). §7 위험 항목 latency 와 정합

**옵션 Z — 하이브리드**: use case 별 결정 (auto-approve 는 Cedar, hard limit 은 코드 등)
- 장점: 유연
- 단점: 일관성 복잡, "왜 이건 Cedar 이고 저건 코드인가" 의 매 라운드 토론 위험 — 무한 리뷰 재발 가능성

**확정**: **옵션 Y** (2026-04-25). 이유:
- 회복 가능성: 잘못 가도 코드 분기로 회복. X 의 마이그레이션 비용 (deferred) 보다 Y 의 분산 비용 (visible) 이 일반적으로 작음
- 수렴 용이: Cedar 정책 단순 → 코덱스 리뷰 라운드 짧음
- 사용자 의도 (경계 먼저, 고도화 나중) 와 align
- Cedar 의 진짜 가치는 C5 (A2A authorization) / C6 (capability migration) 에서 드러남. v1 의 trivial 함은 임시

### 1.1 어느 함수에서 Cedar 를 호출하는가

**§1.0 = Y 결정으로 자동 도출 → 옵션 A** (`submitUserAgent` 만 Cedar). approveUserAgent 는 기존 로직 유지. 이하 옵션 비교는 참고용.

설계 문서 `agent-identity-model.md §8.3` 는 다음 흐름을 명시한다:

- `submitUserAgent`: quota 이내면 auto-approve, 초과면 pending
- `approveUserAgent`: pending 을 admin 이 검토 후 승인/거부 — append

Cedar 를 어디에 꽂을지:

**옵션 A** — `submitUserAgent` 만 Cedar 평가 (auto-approve 판정). `approveUserAgent` 는 기존 로직 유지 (admin override 는 Cedar 와 독립)
- 장점: admin override 의미 유지. Cedar 는 auto-approve 게이트만
- 단점: approve 시 감사 로그에 Cedar 평가 이력 없음

**옵션 B** — 두 함수 모두 Cedar 평가. approve 시 재평가 → deny 면 pending 유지
- 장점: 일관된 Cedar 평가 이력
- 단점: admin 의 수동 승인 override 가 Cedar deny 로 차단됨 — 기존 설계와 충돌

**옵션 C** — Cedar 에 `create_agent` 외 `approve_agent` 액션 추가. approve 시 principal=admin, Cedar 정책으로 admin override 허용
- 장점: Cedar 가 모든 governance 결정 커버
- 단점: Cedar 액션 2개 추가. 스키마 복잡도 증가

**확정 (§1.0 Y 자동 도출)**: 옵션 A. 설계 원칙 유지 + Cedar 단순.

### 1.2 `autoApproveUnderQuota=false` 처리

**§1.0 = Y 결정으로 자동 도출 → 옵션 B** (Cedar 호출 전 코드 분기로 처리). 이하 옵션 비교는 참고용.

`packages/infra/test/agent-governance.test.js:135` (GV6 — autoApproveUnderQuota=false 모두 pending) 등에서 검증하듯, `autoApproveUnderQuota=false` 인 사용자는 quota 이내여도 pending 처리. 이 flag 를 Cedar 정책에 반영하려면:

**옵션 A** — Cedar context 에 `autoApprove: bool` 추가. `permit` 조건에 `context.autoApprove && context.currentCount < context.maxAgentsPerUser`
- 장점: Cedar 정책이 auto-approve 전체 로직 표현
- 단점: context 스키마 확장

**옵션 B** — `autoApproveUnderQuota=false` 는 Cedar 호출 전 코드 분기로 처리 (pending 으로 보냄)
- 장점: Cedar 정책 단순 유지
- 단점: governance 의미론이 Cedar 와 코드 분기에 나뉘어 있음

**확정 (§1.0 Y 자동 도출)**: 옵션 B. Cedar context 스키마 단순 유지.

### 1.3 Admin hard limit (50) 처리

**§1.0 = Y 결정으로 자동 도출 → 옵션 B** (hard limit 은 Cedar 밖 코드 체크). 이하 옵션 비교는 참고용.

`agent-identity-model.md §9.3` 는 환경변수 `PRESENCE_ADMIN_AGENT_HARD_LIMIT` (기본 50) 으로 악의적 admin 방지. admin 은 quota 면제지만 hard limit 존재.

**옵션 A** — Cedar 정책에 `forbid admin when currentCount >= hardLimit` 추가. context 에 `hardLimit` 전달
- 장점: Cedar 가 모든 한도 표현
- 단점: context 스키마 확장

**옵션 B** — hard limit 체크는 Cedar 밖 코드에서. Cedar 가 admin allow 한 뒤 코드가 한번 더 체크
- 장점: Cedar 정책 단순
- 단점: admin 한도 로직이 Cedar 와 코드에 분산

**확정 (§1.0 Y 자동 도출)**: 옵션 B. admin 한도는 코드, Cedar 정책 단순.

### 1.4 Admin override 표현

§1.1 = A (자동 도출) 이므로 `approveUserAgent` 는 Cedar 호출 없음. admin override 는 별도 표현 불필요, 기존 동작 그대로 유지.

### 1.5 Audit 기록 범위

- `submitUserAgent` Cedar 호출 시: `{ caller=요청자, action=create_agent, decision=evaluate 결과 }` 기록
- `approveUserAgent` (옵션 1.1-A 일 때): Cedar 호출 없지만 admin override 자체를 감사 대상으로 기록 `{ operator=OS user, action=manual_approve, requestId }` — 감사 추적성
- 두 기록은 **같은 파일** (`~/.presence/logs/authz-audit.log`) 에 다른 `action` 값으로 구분

결정: 확정 (위 안대로)

---

## 2. Seed 정책 의미론 (`00-base.cedar` 재작성)

### 2.1 Cedar 인프라 플랜의 seed (빈 정책) → governance 의미론

Cedar 인프라 플랜은 `00-base.cedar` 를 **빈 정책 (주석만)** 으로 배포한다 (Cedar default deny 유지, fail-closed). 이 플랜이 seed 를 minimal RBAC 게이트로 재작성한다.

### 2.2 옵션 Y minimal seed (확정)

§1.0 = Y (최소) 자동 도출에 따른 seed:

```cedar
// LocalUser 의 create_agent: RBAC 게이트만 (전부 허용).
// quota / autoApprove / adminHardLimit 은 호출 코드의 분기에서 처리.
// 향후 사용 사례가 쌓이면 의미론을 Cedar 정책으로 이관 검토 (옵션 X 마이그레이션).
permit (
  principal is LocalUser,
  action == Action::"create_agent",
  resource is User
);
```

### 2.3 Cedar context (확장 없음)

```
action "create_agent" appliesTo {
  principal: [LocalUser],
  resource: [User],
  context: {}
};
```

§1.0 = X 로 갈 경우의 풍부한 context (currentCount / maxAgentsPerUser / adminHardLimit / autoApprove) 는 v1 의 §2 에서 옮겨와 향후 마이그레이션 시 참조. 현재는 코드 분기에서 동등 의미 유지.

---

## 3. 구현 범위 (옵션 Y 적용)

### 3.1 변경 파일

**현존 코드 (실제 경로 grep 검증, 2026-04-25)**:
- `packages/infra/src/infra/authz/agent-governance.js` — `submitUserAgent` 진입에 Cedar evaluate 호출 (RBAC 게이트). 기존 quota / autoApprove / hard limit 분기 **유지** (코드에서 처리)
- `packages/infra/src/infra/auth/cli.js` — `agent add` 에 Cedar boot + evaluate + audit. `agent approve` 에 manual_approve audit
- `packages/infra/test/agent-governance.test.js` — 기존 의미론 테스트는 대부분 그대로 (의미론 미변동). Cedar 호출 추가에 대한 단위 테스트만 추가

**Cedar 인프라 산출물 (선결조건 §6 의 별도 플랜에서 생성, 정확한 경로는 그 플랜에서 확정)**:
- `00-base.cedar` (minimal RBAC seed, §2.2)
- `schema.cedarschema` (`create_agent` action 추가, context 확장 없음)
- 실제 디렉토리 위치 (예: `packages/infra/src/infra/authz/defaults/` 또는 `~/.presence/cedar/`) 는 인프라 플랜 결정 후 v3 에서 fix.

### 3.2 건드리지 않는 파일

- Cedar 인프라의 `entity-bag` (이름은 인프라 플랜에서 확정) — 옵션 Y 에선 context 조립 확장 거의 없음
- `canAccessAgent` 시그니처 (`packages/infra/src/infra/authz/agent-access.js`) — 후속 플랜 (A2A authorization, KG-17) 에서
- `packages/infra/src/infra/admin-bootstrap.js` — 서버 부팅 경로 무변화
- 5 진입점 — runtime 무변화

### 3.3 옵션 Y 의 의도 — enforcement point 확정 phase

옵션 Y 는 Cedar 의 **위치 (enforcement point) + audit 경로** 만 박는다. 의미론은 코드에 그대로. **이 phase 의 산출물 자체가 검증 대상**:
- 산출물 1 — `submitUserAgent` 진입의 Cedar evaluate 호출이 정확히 한 번 일어나고 allow 반환을 받는다
- 산출물 2 — audit 로그 `{ caller, action=create_agent, decision=allow, matchedPolicies }` 가 기록된다
- 산출물 3 — 기존 governance 테스트 (의미론 회귀) 가 모두 통과 — 의미론은 코드 분기로 동일하게 유지된다는 보장

위 3 가지가 이 phase 에서 즉시 입증되는 가치. 다음 phase 가치는 별개:
- C5 (A2A authorization, KG-17): Cedar 가 A2A JWT 호출의 RBAC 게이트로 첫 의미 있는 deny 발생
- C6 (capability migration): capability proof 검증의 자연스러운 도구

**마이그레이션 비용 추정 근거 (옵션 Y → X)**: 변경 표면이 **`agent-governance.js` 의 1 함수 (`submitUserAgent`) + Cedar 정책 파일 + schema 파일** 에 한정. 다른 호출자 (admin-bootstrap, 5 진입점, A2A) 는 governance 의미론에 직접 의존하지 않으므로 영향 없음. 사용처가 늘기 전에 옮길 수 있다는 추정은 v2 시점의 grep 결과에 근거 (`agent-governance.js` 가 의미론 single owner).

---

## 4. 단계별 커밋 (옵션 Y)

1. Cedar seed + schema 재작성 (minimal RBAC, §2.2) — entity-bag 변경 없음
2. `submitUserAgent` 진입에 Cedar evaluate 호출 (RBAC 게이트) + quota 등 기존 분기 유지 + 단위 테스트 추가
3. `agent add` CLI Cedar boot + evaluate + audit (`action=create_agent`)
4. `agent approve` CLI manual_approve audit (Cedar 호출 없음, 감사 추적만)

합계 약 3h, 4 커밋. 옵션 X 대비 약 40% 단축 (entity-bag 확장 + governance 테스트 대거 재작성 제거).

---

## 5. 검증 (옵션 Y)

- `npm test` 전체 회귀
- 수동 (옵션 Y 의미론 — Cedar 는 RBAC 게이트, 나머지는 코드):
  - quota 내 + autoApprove=true → Cedar allow → 코드 분기에서 auto-approve
  - quota 내 + autoApprove=false → Cedar allow → 코드 분기에서 pending
  - quota 초과 비-admin → Cedar allow → 코드 분기에서 pending
  - admin + hardLimit 미만 → Cedar allow → 코드 분기에서 즉시 추가
  - admin + hardLimit 초과 → Cedar allow → 코드 분기에서 거부 + 경고
  - admin 이 `agent approve --id <req>` 로 수동 승인 → Cedar 호출 없음, manual_approve audit 기록
  - `50-custom.cedar` 에 사용자 정책 추가 → Cedar evaluate 통과 분기 확인 (deny 정책 추가 시 코드 분기 도달 전 차단)

옵션 Y 에선 Cedar deny 가 발생할 케이스가 minimal seed 만으로는 없음 (전부 allow). custom 정책 추가가 첫 deny 트리거. 이게 옵션 Y 의 본질 — **enforcement point 만 확정, 의미론은 정책으로 점진적 추가**.

### 5.1 회귀 테스트 항목 (자동화 — 옵션 Y 의 "전부 allow" 가 깨지지 않는다는 보장)

`packages/infra/test/agent-governance.test.js` 에 단위 테스트 추가 (기존 GV1~GV15 와 별도):
- **GV-Y1** — minimal seed (`00-base.cedar`) 만 적용된 상태에서 `submitUserAgent({ admin/user, quota 안/초과, autoApprove 任 })` 8 케이스 전부 Cedar evaluate 가 allow 반환
- **GV-Y2** — Cedar evaluate 호출 횟수 = `submitUserAgent` 호출 횟수 (1회 보장, 누락/중복 방지)
- **GV-Y3** — Cedar allow 후 코드 분기에서 의미론 (quota / autoApprove / hard limit) 이 의도대로 동작 — 기존 GV1~GV6 의 의미론 expectation 그대로 통과
- **GV-Y4** — `50-custom.cedar` 에 deny 정책 1 줄 추가 → 그 케이스에서 Cedar deny 반환, 코드 분기 미도달 (enforcement point 작동 확인)

이 4 항목이 옵션 Y 의 *불변식* 을 코드로 박음. 옵션 Y → X 마이그레이션 시 GV-Y3 가 자연스럽게 X 의미론 테스트로 진화 (코드 분기가 정책으로 옮겨감), GV-Y1/Y2/Y4 는 그대로 유지.

---

## 6. 선결 조건

- Cedar 인프라 플랜 완료 (`packages/infra/src/authz/*` 모듈 존재)
- 이 문서의 §1 결정 모두 확정

---

## 7. 위험 (옵션 Y)

- **첫 인상의 trivial 함**: Cedar minimal seed 가 "전부 allow" 이라 도입 가치가 의문스럽게 보일 수 있음. 완화: §3.3 의 가치 설명을 README/PR 본문에 명시. C5 (A2A authorization) 도입 시 첫 진짜 활약 보장
- **의미론의 두 층 분산**: governance 의미론이 Cedar (RBAC) + 코드 (quota / autoApprove / hard limit) 에 분산. 신규 정책 추가 시 어느 층인지 혼동 가능. 완화: `agent-governance.js` 진입부 주석에 "이 함수의 *권한 게이트* 는 Cedar, *의미론* 은 코드 분기" 명시
- **옵션 X 마이그레이션 비용 (deferred)**: 사용 사례가 쌓인 후 의미론을 Cedar 로 옮기려면 코드 분기 → 정책 변환 + 테스트 재작성. 완화: 변경 표면을 한 파일 (`agent-governance.js`) + 정책 파일에 한정 (§3.3)
- **Cedar latency**: minimal seed 라도 evaluate 호출 추가 = 부하. 완화: matchedPolicies audit + latency 벤치 추가

---

## §X — Phase 1 quota 흡수 (옵션 Y' hybrid)

v2.3 의 의미론은 Cedar 정책 + 코드 분기에 분산. interpretCedarDecision 표:

| Cedar 결과 | autoApprove | governance status | reason |
|---|---|---|---|
| `decision='deny' && errors.length > 0` | 任 | DENIED | `evaluator-error` |
| `decision='deny'` (10-quota 매치) | 任 | PENDING | `quota-exceeded` |
| `decision='allow'` | `false` | PENDING | `manual-review` |
| `decision='allow'` | `true` | APPROVED | — |

호출 순서 (`submitUserAgent`):
1. `agentName` 검증 — Either.Left → throw
2. duplicate (config.agents 에 active 동명) → ALREADY_EXISTS, Cedar 호출 *전* 단락
3. count + policies 계산 (Cedar context 의 입력)
4. Cedar `CheckAccess` 호출 with context `{ currentCount, maxAgents }`
5. `interpretCedarDecision` 매핑 → governance status

이 phase 의 정책 구성:
- `00-base.cedar` — `permit (LocalUser, create_agent, User)` (RBAC 게이트, 변경 없음)
- `10-quota.cedar` — `forbid ... when context.currentCount >= context.maxAgents` (신규)
- `50-*.cedar` — boot.js 가 차단 (P4 까지 미지원)

`boot.js readPoliciesDir` 가 `5[0-9]-*.cedar` 패턴 발견 시 throw — cedar-wasm 4.10.0 의 `matchedPolicies` 가 `policy0` 같은 인덱스만 반환, 정책 파일 출처 식별 불가. P4 의 lint/reload 인프라 도입 후 슬롯 개방.

audit trail (운영):
- APPROVED / PENDING(quota-exceeded) / DENIED(evaluator-error) — Cedar evaluator 가 audit JSONL (`~/.presence/logs/authz-audit.log`) 에 자동 기록. allow/deny/failure 모두 trace 보존.
- PENDING(manual-review) — Cedar allow → audit allow row 기록 + pending queue 작성.

## §Y — admin 면제 spec/코드 갭 (KG-26 resolved, v2.4)

v2.3 시점에서 `agent-identity-model.md §8.3` + `agent-identity.md I8` 의 admin 면제 (quota 면제 + hardLimit) 가 코드 미반영 → KG-26 으로 추적. v2.4 에서 Cedar 정책 흡수 (옵션 X) 로 해소:

- 정책 — `11-admin-limit.cedar`: `forbid ... when context.isAdmin && context.currentCount >= context.hardLimit`
- 정책 — `10-quota.cedar` 갱신: `!context.isAdmin` 조건 추가 — admin 은 maxAgents 면제
- 코드 — `agent-governance.js submitUserAgent` 가 `isAdmin = (requester === ADMIN_USERNAME)` 결정 + `hardLimit = resolveAdminHardLimit()` (PRESENCE_ADMIN_AGENT_HARD_LIMIT 환경변수 우선, 부재 시 50) 첨부

대안 (코드 분기 부활) 대비 장점: 의미론을 정책 1 곳에 집중, 운영자가 정책 텍스트만 보면 admin 면제 / hardLimit 확인 가능. 단점: schema.context 4 필드로 늘어남. trade-off 수용 — Y' hybrid 의 잔여 의미론 (manual-review) 만 코드 잔류.

---

## Changelog

- **v2.4 (2026-04-27)**: KG-26 admin 면제 갭 해소 — admin 면제 + hardLimit 을 Cedar 정책으로 흡수. `11-admin-limit.cedar` 신규 (`forbid ... when context.isAdmin && context.currentCount >= context.hardLimit`). `10-quota.cedar` 에 `!context.isAdmin` 조건 추가. schema.context 가 `{ currentCount, maxAgents, isAdmin, hardLimit }` 4 필드. `agent-governance.js submitUserAgent` 가 isAdmin (requester === ADMIN_USERNAME) + hardLimit (PRESENCE_ADMIN_AGENT_HARD_LIMIT env, 기본 50) 첨부. cedar-mock.js 의 default decisionFn 도 admin 면제 모사. GV-X11 (admin under hardLimit), GV-X12 (admin over hardLimit), GV-X13 (non-admin 은 admin hardLimit 무관), GV-X14 (context isAdmin/hardLimit 첨부 검증), CE10 (admin 면제 실 cedar), CE11 (admin hardLimit 실 cedar), CB7 갱신 (admin 정책 동작), INV-CEDAR-ADMIN-EXEMPT 정적 회귀 추가. 잔여 코드 의미론은 manual-review (autoApprove=false) 1 항목.
- **v2.3 (2026-04-26)**: Phase 1 quota 의미론 → Cedar 정책 흡수 (옵션 Y' hybrid). `10-quota.cedar` 추가 — `currentCount >= maxAgents` 일 때 forbid. schema 에 context `{ currentCount, maxAgents }` 추가. `interpretCedarDecision` 순수 함수로 Cedar 결과 → governance 4-state 매핑. `submitUserAgent` 호출 순서 재배치 (validate → duplicate → count → Cedar → mapping). `boot.js` 가 50-* 운영자 정책 슬롯을 P4 까지 차단 — cedar-wasm 4.10.0 의 `matchedPolicies` 가 정책 파일 식별 불가 (실측 `policy0` 만 반환) → 50-* 가 quota 와 분리되지 않음. autoApprove=false manual_review (third state, Cedar 표현 한계) + admin 면제 (별도 KG-26) 는 코드 잔류. cedar-mock.js 에 decisionFn 시그니처 + 기본 quota-aware 추가. GV-X1~X10 (governance) + CE7~9 (실 cedar-wasm) + CB7~9 (50-* boot throw) + CK4 갱신 (context 셰이프). 이전 GV-Y1/Y4 는 Y' 흡수로 의미가 바뀌어 GV-X 로 대체. 잔여 의미론 (admin 면제) 은 KG-26 등록.
- **v2.2 (2026-04-26)**: Phase 구현 완료. `feature/cedar-governance-v2` 브랜치 14 커밋 (디자인 4 + 플랜 3 + 인프라 5 + 의미론 통합 2). GC1 (`cce021b`) `submitUserAgent` 에 Cedar enforcement point + STATUS.DENIED + cli.js cmdAgentAdd Cedar boot. GC3 (`b114399`) `cmdAgentApprove` manual_approve audit (Cedar evaluate 호출 없음, §1.4 admin override 정합). GV-Y1.1~1.8 (8 케이스 allow), GV-Y2 (호출 횟수 정합), GV-Y4 (mock deny → 코드 분기 미도달), GV-Y5 (evaluator invariant) 자동화 완료. GV-Y3 는 기존 GV1~GV15 가 mock evaluator 주입 후 그대로 통과 — 의미론 회귀 0건. AC4b (cli.js manual_approve audit JSONL) 추가. 전체 4270 passed.
- **v2.1 (2026-04-25)**: codex single-round 리뷰 결함 3 건 (a) 흡수.
  - Q1: §1.0 Y 단점에 "Cedar evaluate latency" 추가, §7 위험 항목과 정합. §3.3 제목/본문 정합화 — 제목을 "enforcement point 확정 phase" 로 갱신, 본문에 *이 phase 산출물 자체* 의 즉시 검증 가치 (Cedar 호출 / audit 로그 / 의미론 회귀 통과) 3 항목 명시. 마이그레이션 비용 추정 근거 (grep 결과) 추가.
  - Q3: §3.1 변경 파일 경로를 grep 검증된 실제 경로로 정정 (`packages/infra/src/infra/authz/agent-governance.js`, `packages/infra/test/agent-governance.test.js`). Cedar 인프라 산출물 (`00-base.cedar`, `schema.cedarschema`) 은 "선결조건 §6 의 별도 플랜에서 생성, 정확한 경로는 그 플랜에서 확정" 명시. §1.2 라인 인용 (GV6) 도 실제 경로로 갱신.
  - Q4: §5.1 신설 — minimal seed "전부 allow" 가 회귀하지 않는다는 자동화 검증 항목 4 개 (GV-Y1~Y4). 옵션 Y 불변식을 코드로 박음. Y → X 마이그레이션 시 GV-Y3 가 자연 진화, 나머지는 유지.
  - Q2 (자동 도출 정합) 는 정합 — 변경 없음.
- **v2 (2026-04-25)**: §1.0 메타 결정 신설 (의미론 집중도 = 옵션 Y "최소" 확정). §1.1~1.3 sub-결정은 Y 에서 자동 도출 (1.1-A / 1.2-B / 1.3-B). §2 seed 를 minimal RBAC 로 단순화 (context 확장 없음). §3 entity-bag 확장 제거, governance 테스트 대거 재작성도 제거. §4 커밋은 4 개 그대로지만 entity-bag 작업 제거로 약 3h 로 단축. §5 검증 항목 옵션 Y 의미론에 맞춰 갱신. §7 위험 항목 갱신 (트리비얼 첫인상 / 두 층 분산 / 마이그레이션 비용 / latency). v1 의 무한 리뷰 원인 — 메타 결정이 implicit 한 채 sub-결정 3 개 동시 토론 — 을 §1.0 명문화로 차단.
- **v1 (2026-04-23)**: Cedar 인프라 플랜에서 의미론 결정이 얽혀 분리된 후속 과제로 신설. §1 의 4~5 개 결정 포인트 + §2 seed 재작성 예시 + §3 구현 범위 정리.
