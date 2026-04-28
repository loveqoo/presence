# Governance Cedar 연결 — 설계 결정 필요 과제

**Status**: 2026-04-28 v2.9 (P3 follow-up — set_persona fail-closed 전환). v2.8 의 fail-open skip 을 fail-closed deny 로 전환. `31-protect-persona.cedar` 추가 — `reservedOwner && !isAdmin` 시 forbid. admin/* (reserved owner) agent persona 는 admin 만 변경 가능 (ownership 우회 경로 defense-in-depth). slash-commands.js 가 evaluator/jwtSub/agentId 중 하나라도 누락 시 즉시 deny. 모든 Cedar 게이트가 fail-closed 로 통일 — v2.8 spec-guardian design tension 해소. v2.6 위에 archive transition 의 Cedar 정책 슬롯 추가. `archive_agent` Cedar action + `context: { isAdmin, reservedOwner }`. `30-protect-admin.cedar` 가 `reservedOwner` 일 때 forbid (I5 admin/* archive 불가). 현재 archive transition callsite 부재 — 정책만 forward. transition land 시 Cedar 호출 누락 = `INV-EVALUATOR-INVARIANT` 위반 → fail-closed. 잔여 코드 의미론은 `manual-review` (autoApprove=false) 1 항목.

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

## §X4 — set_persona fail-closed + 31-protect-persona (P3 follow-up, v2.9)

§X3 (v2.8) 도입 직후 spec-guardian 가 design tension 지적: I-CEDAR-EVALUATOR-INVARIANT (canAccessAgent archived) 는 fail-closed, I-CEDAR-PERSONA 는 fail-open. 이유는 v2.8 의 `set_persona` 는 audit-only (의미 forbid 정책 없음) 라 skip 이 보안 우회가 아니라는 판단. 그러나:

- 모든 Cedar 게이트가 fail-closed 로 통일되어야 운영자가 정책 의도를 일관되게 읽을 수 있다.
- 의미 forbid 정책을 도입하면 audit-only 가 아니라 실제 deny 게이트가 된다.

**v2.9 변경**:

1. **`31-protect-persona.cedar` 신규** — admin/* (reserved owner) persona 는 admin 만 변경:
```cedar
forbid (
  principal is LocalUser,
  action == Action::"set_persona",
  resource is Agent
) when { context.reservedOwner && !context.isAdmin };
```

2. **slash-commands.js fail-closed**:
```js
if (typeof evaluator !== 'function' || !jwtSub || !agentId) {
  return { type: 'system', content: 'Persona change denied: missing-evaluator (server context required)' }
}
// Cedar 호출 → deny 시 matchedPolicies 노출
```

`handleSlashCommand` 는 `session-api.js` 에서만 호출 — production 호환성 영향 없음. CLI/테스트 경로에서 호출되더라도 deny 가 올바른 결과 (CLI 는 evaluator 없이 persona 변경 시도하면 안 됨).

**defense-in-depth 의의**: ownership 은 `canAccessAgent` (session middleware) 가 이미 보장. 그러나 future 경로 (admin CLI 가 직접 updatePrimaryPersona / interpreter 가 우회 / a2a 가 cross-user persona 시도) 에서 ownership middleware 가 우회될 수 있다. 31-protect-persona 가 Cedar 정책으로 admin/* persona 보호 — 다층 방어.

**테스트 커버리지**: CE14.1 (!reservedOwner → allow), CE14.2 (reservedOwner+isAdmin → allow), CE14.3 (reservedOwner+!isAdmin → deny). CB12 매트릭스 3 케이스. INV-CEDAR-PERSONA-PROTECT 정적 회귀.

---

## §X3 — set_persona action + slash-commands 통합 (P3 C3, v2.8 — v2.9 에서 fail-closed 전환)

`set_persona` Cedar action 신규. `context: { isAdmin: Bool, reservedOwner: Bool }`.

**의도**: `/persona set` / `/persona reset` 의 audit trail. Cedar evaluator 가 매 호출에서 audit JSONL 에 principal/resource/decision/timestamp 기록 → governance trace 확보.

**`00-base.cedar` permit 만, forbid 없음**. 이유: ownership 이 session middleware (`canAccessAgent`) 에서 이미 강제됨. `/persona` 는 user 의 own session 에서만 호출 가능하므로 cross-owner 공격 표면이 없다. forbid 정책을 도입할 의미 제약이 현재 없다.

**slash-commands.js 통합**:
```js
// /persona set|reset 시
if (typeof evaluator === 'function' && jwtSub && primaryAgentId) {
  const op = CheckAccess({
    principal: { type: 'LocalUser', id: jwtSub },
    action:    'set_persona',
    resource:  { type: 'Agent', id: primaryAgentId },
    context:   { isAdmin: jwtSub === ADMIN_USERNAME, reservedOwner: isReservedUsername(ownerPart) },
  })
  const decision = runCheckAccess(evaluator, op)
  if (decision.decision !== 'allow') return /* deny 응답 */
}
// allow → updatePrimaryPersona
```

**fail-open 설계 결정**: evaluator/jwtSub/agentId 미전달 시 게이트 skip. CLI/테스트 호환 + audit-only 게이트라 skip 이 보안 우회가 아님. 단 후속 phase 에서 forbid 정책 추가 시 (예: `!isAdmin && reservedOwner` 차단) fail-closed 로 전환 필요. 현재는 design tension 으로 명시.

`I-CEDAR-EVALUATOR-INVARIANT` (canAccessAgent archived) 는 fail-closed — 의미 deny 정책 (20-archived) 이 있어 evaluator 누락 = 우회. `I-CEDAR-PERSONA` 와 의미가 다른 게이트라 정책이 다른 것이 정합.

---

## §X2 — archive_agent action + 30-protect-admin (P3 C2, v2.7)

`archive_agent` Cedar action 신규. `context: { isAdmin: Bool, reservedOwner: Bool }`.

**의도**: agent-identity I5 의 "admin/manager (reserved owner) 는 archive 불가" 서버 불변식을 Cedar 정책으로 흡수. v2.7 까지 코드 분기로 구현되지 않았던 이유: archive transition 자체가 코드 미구현. 정책만 먼저 land 시켜서 transition 이 도착하면 자동 적용.

**`30-protect-admin.cedar`**:
```cedar
forbid (
  principal is LocalUser,
  action == Action::"archive_agent",
  resource is Agent
) when { context.reservedOwner };
```

**현재 callsite 부재**: agent transition 이 코드에 land 하기 전이라 `Op.CheckAccess({ action: 'archive_agent' })` 를 호출하는 곳이 없다. P3 C2 는 정책 자산 + Cedar evaluator 동작 검증 (CE13 / CB11) 만 수행. transition 이 land 하면:
1. callsite 가 `runCheckAccess` 로 archive_agent 호출
2. `context.reservedOwner = isReservedUsername(agentId.split('/')[0])` 로 채움
3. `isReservedUsername` 결정은 호출측 책임 (Cedar 정책은 boolean 만 신뢰)
4. transition 누락 시 I-CEDAR-EVALUATOR-INVARIANT 가 fail-closed (registry+entry 있는 곳에서 evaluator 누락도 deny)

**추가 의미론 가능**: `isAdmin` context 도 받도록 schema 정의 — admin 만 user 의 agent archive 가능하게 forbid 정책 확장 여지. P3 단계는 reservedOwner 만 사용. 후속 phase 에서 정책 추가 가능.

---

## §X1 — evaluator invariant 강제 (P3 C1, v2.6)

v2.5 까지 `canAccessAgent` 가 evaluator 옵션이었다 — 미전달 시 archived 분기에서 코드 fallback (`archived && intent !== CONTINUE_SESSION`) 으로 deny. 호환 phase 의 산출물.

문제: registry+entry 가 있는데 evaluator 가 누락되면 silent fail-open 위험. 새 진입점 추가 시 evaluator 전달을 잊으면 archived 판정은 지나가지만 Cedar audit JSONL 도 미작성 → 결정과 추적이 동시에 사라진다.

해소 (v2.6): registry+entry 있을 때 evaluator 필수. 미전달 시 `REASON.MISSING_EVALUATOR` fail-closed.

```js
// agent-access.js — v2.6 §X1
if (registry) {
  const entry = ...
  if (entry) {
    if (typeof evaluator !== 'function') return deny(REASON.MISSING_EVALUATOR)
    // Cedar 위임 (20-archived.cedar)
  }
}
```

영향:
- 5 진입점 (session-api / ws-handler / a2a-router / scheduler-factory / delegate.js) 은 v2.5 부터 이미 evaluator 전달 → 무영향
- 외부 caller (테스트 등) 가 evaluator 누락하면 deny — 명시적 fail-closed
- `AA5/AA6/AA7/AA7b/AA8` (legacy fallback 의존) 는 `AA-X1/AA-X2/AA-X3/AA-X5` (evaluator 경로) 로 대체. `AA-X4` 는 의미 변경 — 이전 = legacy fallback, 현재 = MISSING_EVALUATOR fail-closed

`REASON.MISSING_EVALUATOR = 'missing-evaluator'` 신규.

---

## §X5 — Cedar 운영자 custom policy 슬롯 (50-*) unblock (KG-27, P4)

**상태**: resolved (v2.11). v2.3 의 `boot.js` 50-* throw 가드 — "cedar-wasm 4.10.0 의 `matchedPolicies` 가 정책 파일 식별 불가 (실측 `policy0` 만 반환)" — 가 잘못된 진단으로 확인됨 (2026-04-28). 입력 모양 전환 + classifyDeny priority 분류 + admin CLI lint/list 추가로 unblock 완료.

**실측 (cedar-wasm 4.10.0)**:

| 입력 모양 | matchedPolicies (response.diagnostics.reason) |
|---|---|
| `staticPolicies: <단일 문자열 concat>` | `["policy0", "policy1", ...]` (인덱스 기반) |
| `staticPolicies: { "alpha": text, "beta": text }` | `["beta"]` (제공된 ID 그대로) |

cedar-wasm API 가 두 입력 모양을 모두 받으며, 맵 형태일 때 정책 식별이 가능. 외부 라이브러리 한계가 아니라 우리가 잘못된 입력 모양 (`readPoliciesDir` 가 `.join('\n\n')`) 을 쓴 것이 원인. 외부 의존 없이 unblock 가능.

**해소 범위 (P4)**:
1. `boot.js readPoliciesDir` — 단일 문자열 → `{ filename: text }` 맵 (filename = `00-base`, `10-quota`, `20-archived`, `30-protect-admin`, `31-protect-persona`, ...)
2. `evaluator.js` — `staticPolicies` 에 맵 그대로 전달
3. `interpretCedarDecision` — `matchedPolicies` 의 prefix 매치를 사유로 분류 (`10-` → quota, `11-` → admin-limit, `20-` → archived, `30-`/`31-` → protect, `50-` → operator-defined)
4. `boot.js` 50-* throw 가드 제거
5. admin CLI:
   - `policy lint <file>` — `cedar.checkParsePolicySet` 활용한 문법/스키마 검증
   - `policy reload` — runtime evaluator 재구성 (재부팅 없이)
   - `policy list` — 활성 정책 카테고리별 목록
6. 회귀: 정책 식별 정확성 (CE-X), 50-* 정상 부팅 (CB-X), interpretCedarDecision 50-* 분기 (GV-X), CLI lint/reload (CLI-X)

**구현 결과 (v2.11)**:
- `boot.js readPoliciesDir` — `{ basename: rawText }` 맵 반환 (50-* throw 가드 제거).
- `boot.js bootCedarR` — `cedar.policySetTextToParts` 로 다중 statement 파일을 split 후 `{ basename: stmt }` (단일) 또는 `{ basename-N: stmt }` (다중) 형태의 `policiesMap` 생성. parse + validate 모두 맵 입력.
- `evaluator.js` — Reader env 의 `policiesMap` 객체를 `staticPolicies` 에 그대로 전달.
- `agent-governance.js` — `REASON` enum 재구성 (DENIED_OPERATOR / DENIED_PROTECT / DENIED_ADMIN_LIMIT / DENIED_EVALUATOR / DENIED_UNSPECIFIED + PENDING_QUOTA / PENDING_MANUAL). `classifyDeny(matchedPolicies)` 가 priority 기반 다중 매치 분류 (operator > protect > admin-limit > quota → unspecified). `PENDING_REASON` 은 하위 호환 alias.
- 매핑 결정 (codex H3 흡수):
  - 50-* (operator-denied) → `STATUS.DENIED` terminal
  - 30-/31- (protect-violated) → `STATUS.DENIED` terminal
  - 11-admin-limit (admin-hardlimit) → `STATUS.DENIED` terminal (admin 자체 한계)
  - 10-quota (quota-exceeded) → `STATUS.PENDING` (admin 이 quota 상향 검토 가능 — 유일 PENDING)
  - 빈 matchedPolicies deny → `STATUS.DENIED(unspecified)` fail-closed
- admin CLI 추가:
  - `npm run user -- policy lint --file <path>` — `cedar.policySetTextToParts` 로 split → `checkParsePolicySet` (parse) + `validate` (schema 적합성). 다중 statement 파일도 처리.
  - `npm run user -- policy list` — POLICIES_DIR 카테고리별 표 (filename | category | size).
  - `npm run user -- policy reload` — 미지원, exit 1 + 안내 (P5 후속).
- 회귀: CB-X1/X2/X3 (50-* 정상 부팅 + matchedPolicies 매치 + forbid-overrides-permit), GV-X16~X19 (DENIED 매핑 + priority + fail-closed + ordering 무관성), CLI-X1~X5 (lint/list/reload). INV-CEDAR-CUSTOM-BLOCK 제거 + INV-CEDAR-POLICY-MAP / INV-INTERPRET-MATCHED-POLICIES / INV-DENIED-VS-PENDING 신규.
- 4583 passed, 0 failed (이전 4540 + 43).

**Reference**:
- 잘못된 진단 출처: v2.3 Changelog (2026-04-26).
- 실증: 2026-04-28 cedar-wasm 4.10.0 직접 호출 비교 — 두 입력 모양에 대한 응답 차이 확인. `policySetTextToParts` 가 다중 statement 파일 split 도구.

---

## §X6 — Cedar policy hot reload (KG-28, P5)

**상태**: open (v2.12). P4 가 50-* 운영자 슬롯 unblock + admin CLI lint/list 까지만 다루고 `policy reload` 는 명시적으로 미지원 (서버 재시작 필요). P5 가 hot reload 를 제공해 정책 변경 → 즉시 적용 경로를 만든다.

**현재 (P4 시점)**:
- `bootCedarSubsystem` 는 서버 부팅 시 단발 호출 (`packages/server/src/server/index.js:133`).
- evaluator 는 `bootCedar()` 의 `policiesMap` closure 를 캡처 (`evaluator.js:40`) — 정책 파일 수정 후에도 메모리 상태 그대로.
- evaluator 는 `UserContext.create({ evaluator })` 로 주입되며 (`user-context.js:54`), `UserContext.evaluator` 필드에 저장. `UserContextManager` 가 single-flight 부팅으로 동시 첫 접근 race 차단 (`user-context-manager.js:34~41`).
- `cmdPolicyReload` 는 stub — exit 1 + 안내 (`cli-policy.js:48~52`).

**해소 범위 (P5)**:
1. **트리거**: 운영자 명시적 명령 (REST 엔드포인트 또는 시그널) — file watch 자동 reload 는 P5 범위 밖 (운영자 의도성 우선).
2. **재부팅**: `rebootCedarSubsystem({ presenceDir, logger })` — 새 evaluator 부팅. lint 가 선결 검증 — 파일 시스템 race 가능하므로 부팅 자체가 fail 시 이전 evaluator 유지 (rollback).
3. **atomic 교체**: 모든 `UserContext.evaluator` 참조를 새 인스턴스로 동시 교체. 진행 중인 isAuthorized 호출은 이전 evaluator 로 끝남 (closure capture).
4. **동시성**: reload 단발 보장 (single-flight). reload 중 들어온 reload 트리거는 진행 중 Promise 공유 또는 거부.
5. **CLI**: `npm run user -- policy reload` 가 서버 REST 호출. 서버 미가동 시 명확한 안내. lint 선결 검증 권장 메시지.
6. **invariant**: I-CEDAR-RELOAD-ATOMIC (모든 UserContext 가 같은 시점에 같은 evaluator 참조) + I-CEDAR-RELOAD-FAIL-SAFE (부팅 실패 시 이전 evaluator 유지).

**상세 설계 + plan-reviewer (codex) 비판 리뷰** 는 별도 플랜 파일에서 확정.

---

## Changelog

- **v2.12 (2026-04-29)**: KG-28 등록 (open, medium, infra) — Cedar policy hot reload. P4 의 후속 (`policy reload` 미지원 안내를 실제 경로로 대체). §X6 신규. atomic evaluator 교체 + fail-safe rollback + single-flight reload 가 핵심. 트리거는 운영자 명시 명령 (REST/시그널), file watch 자동 reload 는 범위 밖.
- **v2.11 (2026-04-28)**: KG-27 P4 resolved — 50-* 운영자 슬롯 unblock + classifyDeny priority 분류 + admin CLI lint/list. plan-reviewer (codex) 비판 리뷰 8 결함 (H1~H4 + M5~M8) 흡수: (H1) parse/validate 도 맵 입력 지원 — fallback 없이 진행. (H2) priority 기반 다중 매치 분류 — first-match ordering 가정 제거. (H3) 50-/30-/31-/11- → DENIED terminal, 10-quota 만 PENDING. 빈 매치 → DENIED(unspecified) fail-closed. (H4) atomic 단일 커밋 — slot 개방 + lint CLI 동시 머지. lint 가 parse + schema validate 둘 다 호출 (action 이름 오타 잡음). (M5) CB-X3 — operator permit vs system forbid 의미론 (forbid-overrides-permit) 회귀. (M6) cedar-mock 의 prefix 분류는 governance 분류기 입력 검증용. 라이브러리 의미론은 실 cedar 부팅으로만 검증. (M7) 롤백 honest — atomic revert 만 완전 복원. (M8) I-CEDAR-MATCH-ID 약화: matchedPolicies 는 정책 파일 basename 의 부분집합. ordering 미명세. CB-X1/X2/X3 + GV-X16~X19 + CLI-X1~X5 + INV-CEDAR-POLICY-MAP / INV-INTERPRET-MATCHED-POLICIES / INV-DENIED-VS-PENDING. 4583 passed.
- **v2.10 (2026-04-28)**: KG-27 등록 — Cedar 운영자 custom policy 슬롯 (50-*) boot 차단 unblock 가능. v2.3 의 진단 (cedar-wasm 4.10.0 matchedPolicies 정책 식별 불가) 이 잘못됐음을 실증으로 확인. `staticPolicies` 가 `string` 외에 `{ id: text }` 맵도 받으며, 맵 형태일 때 매치된 정책 ID 가 그대로 surface 됨. 외부 라이브러리 신버전 대기 불필요 — `boot.js` / `evaluator.js` / `interpretCedarDecision` 입력 모양 변경 + admin CLI (lint/reload/list) 추가로 P4 unblock 가능. §X5 신규 섹션. REGISTRY 에 KG-27 (open, medium, infra) 추가.
- **v2.9 (2026-04-28)**: P3 follow-up — `set_persona` fail-open → fail-closed 전환. `31-protect-persona.cedar` 신규 (`reservedOwner && !isAdmin` forbid). slash-commands.js 의 evaluator/jwtSub/agentId 누락 시 즉시 deny. handleSlashCommand 는 session-api.js 단일 caller — production 호환성 영향 없음. 모든 Cedar 게이트 (canAccessAgent / submitUserAgent / persona) 가 fail-closed 로 통일 — v2.8 spec-guardian design tension 해소. defense-in-depth: ownership 은 session middleware 가 보장하나 future 경로 (admin CLI / interpreter / a2a) 우회 시에도 admin/* persona 보호. CE14.1/14.2/14.3 (3 케이스 매트릭스), CB12 갱신 (3 케이스), INV-CEDAR-PERSONA-PROTECT 정적 회귀, cedar-mock decideSetPersona. agent-identity I-CEDAR-PERSONA 갱신. 4535 passed.
- **v2.8 (2026-04-28)**: P3 C3 — `set_persona` action + slash-commands `/persona` 통합. schema `set_persona` action + `context: { isAdmin: Bool, reservedOwner: Bool }`. `00-base.cedar` permit 만 (forbid 없음 — ownership 이 session middleware 에서 이미 보장, audit trail 이 핵심). `slash-commands.js persona handler` 가 evaluator + jwtSub + agentId 있을 때 `Op.CheckAccess({ action: 'set_persona' })` 호출 → Cedar audit JSONL 자동 기록. 미전달 시 fail-open skip (CLI/테스트 호환, audit-only 게이트라 보안 우회 아님). session-api `/api/sessions/:sessionId/chat` 가 evaluator + jwtSub 를 ctx 에 추가 전달. CE14 (실 cedar set_persona + audit), CB12 (실 자산 통합), 기존 server S7b (/persona show/set/reset) 가 mock evaluator 통과. cedar-mock.js set_persona 분기. agent-identity I-CEDAR-PERSONA 신규. design tension: forbid 정책 추가 시 fail-closed 전환 검토 — 후속 phase. 4515 passed.
- **v2.7 (2026-04-28)**: P3 C2 — `archive_agent` action + `30-protect-admin.cedar` 신규. schema 에 `archive_agent` action + `context: { isAdmin: Bool, reservedOwner: Bool }`. `00-base.cedar` 가 `archive_agent` permit 추가. `30-protect-admin.cedar` 가 `reservedOwner` 일 때 forbid (I5 admin/* archive 불가 흡수). 현재 archive transition callsite 부재 — 정책만 forward, transition land 시 자동 적용. Cedar 호출 누락 = INV-EVALUATOR-INVARIANT 위반 → fail-closed. CE13.1/13.2 (실 cedar archive_agent), CB11 (실 자산 통합), cedar-mock.js `decideArchiveAgent` 추가. agent-identity.md I-CEDAR-ARCHIVE-PROTECT 신규 + I5 갱신. 4509 passed.
- **v2.6 (2026-04-28)**: P3 C1 — evaluator invariant 강제. `canAccessAgent` archived 분기의 legacy fallback 제거. registry+entry 있을 때 evaluator 미전달 시 `REASON.MISSING_EVALUATOR` fail-closed. 5 진입점은 v2.5 부터 이미 evaluator 전달 → 무영향. v2.5 hybrid phase 종료. 의도: silent fail-open + audit 누락 위험 → 명시적 fail-closed. `AA5/AA6/AA7/AA7b/AA8` 삭제 (legacy fallback 의존, `AA-X1/X2/X3/X5` 가 evaluator 경로로 대체). `AA-X4` 의미 변경 (legacy fallback → MISSING_EVALUATOR). `delegate.test.js` / `prod.test.js` 가 `prodInterpreterR.run({...evaluator: createMockEvaluator()})` 추가. agent-identity.md I-CEDAR-EVALUATOR-INVARIANT 신규 + I5 / I-CEDAR-ARCHIVED 갱신. 4502 passed.
- **v2.5 (2026-04-28)**: P2 archived agent → Cedar 흡수. `20-archived.cedar` 신규 (`forbid ... when context.archived && context.intent != "continue-session"`). `00-base.cedar` 가 `access_agent` permit 추가. schema 에 entity `Agent` + action `access_agent` (context: `{ intent: String, archived: Bool }`) 추가. `canAccessAgent` 시그니처에 옵션 `evaluator` — Cedar 위임 / 코드 분기 fallback 양립. 5 진입점 (session-api new/continue, a2a-router DELEGATE, ws-handler CONTINUE, scheduler-factory SCHEDULED_RUN, delegate interpreter) 모두 evaluator 전달. cedar-mock.js default 도 archived 의미론 모사. AA-X1~X6 (agent-access), CE12 (실 cedar archived 매트릭스), CB10 (실 자산 정책 통합), INV-CEDAR-ARCHIVED-POLICY + INV-ACCESS-AGENT-CALLERS 정적 회귀 추가. 4509 passed. evaluator invariant 강제 (필수화) 는 P3 와 함께 — 현재는 옵션으로 호환.
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
