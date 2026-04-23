# Governance Cedar 연결 — 설계 결정 필요 과제

**Status**: 2026-04-23 v1 초안. Cedar 인프라 플랜 (`.claude/plans/purring-beaming-horizon.md` v5) 에서 의미론 결정이 얽혀 분리된 후속 과제. Cedar 인프라 착수 완료 후 이 문서 기반으로 별도 플랜 작성.

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

### 1.1 어느 함수에서 Cedar 를 호출하는가

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

현재 추천: **옵션 A** (설계 원칙 유지 + 단순). 선택 확정 필요.

### 1.2 `autoApproveUnderQuota=false` 처리

`packages/infra/src/infra/agents/agent-governance.test.js:135` 등에서 검증하듯, `autoApproveUnderQuota=false` 인 사용자는 quota 이내여도 pending 처리. 이 flag 를 Cedar 정책에 반영하려면:

**옵션 A** — Cedar context 에 `autoApprove: bool` 추가. `permit` 조건에 `context.autoApprove && context.currentCount < context.maxAgentsPerUser`
- 장점: Cedar 정책이 auto-approve 전체 로직 표현
- 단점: context 스키마 확장

**옵션 B** — `autoApproveUnderQuota=false` 는 Cedar 호출 전 코드 분기로 처리 (pending 으로 보냄)
- 장점: Cedar 정책 단순 유지
- 단점: governance 의미론이 Cedar 와 코드 분기에 나뉘어 있음

현재 추천: **옵션 A** (의미론을 Cedar 에 집중). 선택 확정 필요.

### 1.3 Admin hard limit (50) 처리

`agent-identity-model.md §9.3` 는 환경변수 `PRESENCE_ADMIN_AGENT_HARD_LIMIT` (기본 50) 으로 악의적 admin 방지. admin 은 quota 면제지만 hard limit 존재.

**옵션 A** — Cedar 정책에 `forbid admin when currentCount >= hardLimit` 추가. context 에 `hardLimit` 전달
- 장점: Cedar 가 모든 한도 표현
- 단점: context 스키마 확장

**옵션 B** — hard limit 체크는 Cedar 밖 코드에서. Cedar 가 admin allow 한 뒤 코드가 한번 더 체크
- 장점: Cedar 정책 단순
- 단점: admin 한도 로직이 Cedar 와 코드에 분산

현재 추천: **옵션 A** (admin 까지 Cedar 단일 평가).

### 1.4 Admin override 표현

옵션 1.1-A 로 가면 (`approveUserAgent` 는 Cedar 호출 없음), admin override 는 별도 표현 불필요 — 기존 동작 그대로.

옵션 1.1-C 로 가면 `approve_agent` Cedar 정책에 `permit(principal.role == "admin")` 추가.

현재 추천: 1.1 결정에 종속.

### 1.5 Audit 기록 범위

- `submitUserAgent` Cedar 호출 시: `{ caller=요청자, action=create_agent, decision=evaluate 결과 }` 기록
- `approveUserAgent` (옵션 1.1-A 일 때): Cedar 호출 없지만 admin override 자체를 감사 대상으로 기록 `{ operator=OS user, action=manual_approve, requestId }` — 감사 추적성
- 두 기록은 **같은 파일** (`~/.presence/logs/authz-audit.log`) 에 다른 `action` 값으로 구분

결정: 확정 (위 안대로)

---

## 2. Seed 정책 의미론 (`00-base.cedar` 재작성)

### 2.1 Cedar 인프라 플랜의 seed (빈 정책) → governance 의미론

Cedar 인프라 플랜은 `00-base.cedar` 를 **빈 정책 (주석만)** 으로 배포한다 (Cedar default deny 유지, fail-closed). 이 플랜이 seed 를 governance 의미론으로 재작성한다.

### 2.2 결정 후 seed 예시

1.1-A + 1.2-A + 1.3-A + 1.4 없음 조합일 때:

```cedar
// 기본 허용: admin (hard limit 이내) 또는 quota 이내이고 autoApprove=true
permit (
  principal is LocalUser,
  action == Action::"create_agent",
  resource is User
) when {
  (principal.role == "admin" && context.currentCount < context.adminHardLimit) ||
  (context.autoApprove && context.currentCount < context.maxAgentsPerUser)
};

// quota 초과는 명시 거부 (비-admin)
forbid (
  principal is LocalUser,
  action == Action::"create_agent",
  resource is User
) when {
  principal.role != "admin" &&
  context.currentCount >= context.maxAgentsPerUser
};

// admin hard limit 초과 거부
forbid (
  principal is LocalUser,
  action == Action::"create_agent",
  resource is User
) when {
  principal.role == "admin" &&
  context.currentCount >= context.adminHardLimit
};
```

### 2.3 Cedar context 확장 필드

```
action "create_agent" appliesTo {
  principal: [LocalUser],
  resource: [User],
  context: {
    currentCount: Long,
    maxAgentsPerUser: Long,
    adminHardLimit: Long,
    autoApprove: Bool,
  }
};
```

---

## 3. 구현 범위

### 3.1 변경 파일 (예상)

- `packages/infra/src/authz/defaults/00-base.cedar` — 의미론 재작성
- `packages/infra/src/authz/defaults/schema.cedarschema` — context 필드 확장
- `packages/infra/src/authz/entity-bag.js` — context 조립 확장 (autoApprove, adminHardLimit)
- `packages/infra/src/infra/agents/agent-governance.js` — `submitUserAgent` Cedar 평가. quota 분기 제거
- `packages/infra/src/infra/auth/cli.js` — `agent add` 에 Cedar boot + evaluate + audit. `agent approve` 에 manual_approve audit
- 기존 governance 테스트 업데이트

### 3.2 건드리지 않는 파일

- `canAccessAgent` 시그니처 — 후속 플랜 2 (A2A) 에서
- `admin-bootstrap.js` — 서버 부팅 경로 무변화 유지
- 5 진입점 — runtime 무변화

---

## 4. 단계별 커밋 (예상)

1. Cedar seed + schema 재작성 (의미론 확정) + entity-bag context 확장
2. `submitUserAgent` Cedar 평가 연결 + quota 분기 제거 + 테스트 업데이트
3. `agent add` CLI Cedar boot + evaluate + audit
4. `agent approve` CLI manual_approve audit 기록

합계 약 5h, 4 커밋.

---

## 5. 검증

- `npm test` 전체 회귀
- 수동:
  - quota 내 + autoApprove=true → auto-approve (Cedar allow)
  - quota 내 + autoApprove=false → pending (Cedar deny)
  - quota 초과 비-admin → pending (Cedar deny)
  - admin + hardLimit 미만 → allow
  - admin + hardLimit 초과 → deny
  - admin 이 `agent approve --id <req>` 로 수동 승인 → Cedar 호출 없음, audit 기록
  - `50-custom.cedar` 에 사용자 정책 추가 → Cedar 평가 영향 확인

---

## 6. 선결 조건

- Cedar 인프라 플랜 완료 (`packages/infra/src/authz/*` 모듈 존재)
- 이 문서의 §1 결정 모두 확정

---

## 7. 위험

- 기존 governance 테스트 대거 재작성 필요 (quota 로직 → Cedar 기반)
- `autoApproveUnderQuota` 의미를 Cedar context 로 옮기는 것이 용어 혼동 유발 가능 — 새로운 이름 (`autoApproveEligible`?) 검토
- Cedar 정책이 복잡해져 디버깅 어려움 — Cedar latency 벤치 + matchedPolicies audit 로 완화

---

## Changelog

- **v1 (2026-04-23)**: Cedar 인프라 플랜에서 의미론 결정이 얽혀 분리된 후속 과제로 신설. §1 의 4~5 개 결정 포인트 + §2 seed 재작성 예시 + §3 구현 범위 정리.
