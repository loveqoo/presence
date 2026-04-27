# Agent Identity 정책

## 목적

presence 의 에이전트 정체성 모델을 정의한다. AgentId canonical form, session-agent 결합 불변식, agent 실행 진입점 제어, governance(quota + 승인), soft-delete 정책을 보장한다. 세부 A2A JWT / Cedar 정책은 `docs/design/a2a-authorization.md` 에 위임.

**설계 토대**: `docs/design/agent-identity-model.md` v5.

---

## 불변식 (Invariants)

- I1. **AgentId canonical form**: `{username}/{agentName}`. slash 정확히 1개. 각 part는 kebab-case (소문자 시작, 끝은 소문자/숫자, 연속 하이픈 금지, 언더바 금지, 숫자 시작 금지), 길이 1~63. 단일 검증 함수 `validateAgentId` (`packages/core/src/core/agent-id.js`) 가 유일 진실. 모든 진입점이 이 함수를 공유.

- I2. **Reserved username `admin`**: `RESERVED_USERNAMES = ['admin']`. `admin/*` agent는 JWT sub='admin' 인 호출자만 접근 가능. `isReservedUsername(u)` 함수로 판별.

- I3. **모든 세션에 agentId 필수**: `Session` 생성자가 `opts.agentId`를 강제 검증. 부재 또는 빈 문자열이면 throw. 생성 후 불변. 세션 persistence 복원 시 agentId는 재persist 하지 않는다 — 생성 시점 값이 권위.

- I4. **5 진입점 모두 `canAccessAgent` 의무 호출**: 모든 agent 실행 이전에 `canAccessAgent({ jwtSub, agentId, intent, registry? })` 호출. `allow=false` 시 즉시 거부. 진입점:
  1. HTTP `/api/sessions/*` — `session-api.js` (NEW_SESSION 또는 CONTINUE_SESSION)
  2. HTTP `/a2a/*` — `a2a-router.js` (DELEGATE)
  3. WebSocket session join — `ws-handler.js` (CONTINUE_SESSION)
  4. Scheduler job run — `scheduler-factory.js` (SCHEDULED_RUN)
  5. `Op.Delegate` — `packages/infra/src/interpreter/delegate.js` (DELEGATE)

- I5. **Archived agent soft-delete**: `archived: true` 마킹. `canAccessAgent`가 `intent !== 'continue-session'`인 경우 거부. `continue-session`(기존 세션 계속 실행)은 허용. `admin/manager`는 archive 불가 (서버 불변식). v1에서 hard delete 없음. **v2.5 (governance-cedar §X): archived 분기는 `20-archived.cedar` 정책 (`forbid ... when context.archived && context.intent != "continue-session"`) 으로 흡수. `canAccessAgent` 가 옵션 `evaluator` 인자 받으면 Cedar 위임. v2.6 (governance-cedar §X1): evaluator invariant 강제 (fallback 제거) — registry + entry 있을 때 evaluator 필수. 5 진입점 모두 evaluator 전달. v2.7 (governance-cedar §X): admin/* (reserved owner) archive 금지는 `30-protect-admin.cedar` (`forbid ... when context.reservedOwner`) 로 흡수 — `archive_agent` action + Cedar 정책이 서버 불변식을 선언적으로 강제. 현재 archive transition (archived false → true) 구현 부재 — 정책만 forward, transition land 시 자동 적용.**

- I6. **Admin bootstrap 상태기계**: 서버 부팅 시 3단계 idempotent 상태기계 실행. 실패 시 서버 부팅 거부.
  - State 0: admin 계정 없으면 생성 + 초기 비밀번호 파일 (`admin-initial-password.txt`, 0600)
  - State 1: admin config의 `admin/manager` agent + `primaryAgentId` 없으면 등록
  - State 2: `agent-policies.json` 없으면 기본값 작성 (`maxAgentsPerUser: 5`, `autoApproveUnderQuota: true`)

- I7. **Governance quota**: non-admin user가 agent 추가 시 `agent-policies.json`의 `maxAgentsPerUser` 기준 체크. quota 내 + `autoApproveUnderQuota=true`이면 자동 승인. 초과 시 `pending/` 파일 작성. active count는 `config.agents.filter(!archived).length`로 매번 재계산 — 캐시 없음.

- I-CEDAR-QUOTA. **Quota 의미론은 Cedar 정책에서 평가** (governance-cedar v2.4 §X, Phase 1 옵션 Y' hybrid + admin 면제 흡수): `submitUserAgent` 가 `Op.CheckAccess` 를 `context: { currentCount, maxAgents, isAdmin, hardLimit }` 와 함께 호출. 두 forbid 정책: `10-quota.cedar` (`!isAdmin && currentCount >= maxAgents`), `11-admin-limit.cedar` (`isAdmin && currentCount >= hardLimit`). `isAdmin = (requester === ADMIN_USERNAME)`. `hardLimit` 은 `PRESENCE_ADMIN_AGENT_HARD_LIMIT` 환경변수 (부재 시 50). 호출 순서: validate → duplicate (Cedar 전 단락) → count/policies 계산 → Cedar → `interpretCedarDecision` 매핑. Cedar `decision='deny' && errors.length > 0` → DENIED(`evaluator-error`); `decision='deny'` (errors 없음) → PENDING(`quota-exceeded`, admin hardLimit 초과 포함); `decision='allow' && !autoApprove` → PENDING(`manual-review`); `decision='allow' && autoApprove` → APPROVED. 운영자 정책 슬롯 (`50-*.cedar`) 은 `boot.js readPoliciesDir` 가 P4 까지 차단 — cedar-wasm 4.10.0 의 `matchedPolicies` 가 정책 파일 식별 불가 → quota 매치와 운영자 deny 의 분리가 어렵기 때문. P4 의 lint/reload 인프라 도입 후 슬롯 개방.

- I-CEDAR-ARCHIVED. **archived agent 접근은 Cedar 정책에서 평가** (governance-cedar v2.5 §X, v2.6 §X1): `canAccessAgent` 가 `Op.CheckAccess` 를 `action='access_agent'` + `context: { intent: String, archived: Bool }` + `principal={ type: 'LocalUser', id: jwtSub }` + `resource={ type: 'Agent', id: agentId }` 로 호출. `20-archived.cedar` 의 `forbid ... when context.archived && context.intent != "continue-session"` 매치 시 Cedar deny → `REASON.ARCHIVED`. registry + entry 있을 때 evaluator 필수 — 미전달 시 `REASON.MISSING_EVALUATOR` fail-closed (v2.6 §X1). 5 진입점 (session-api new/continue, a2a-router DELEGATE, ws-handler CONTINUE_SESSION, scheduler-factory SCHEDULED_RUN, delegate interpreter) 가 PresenceServer.evaluator 또는 UserContext.evaluator 를 통해 전달. legacy fallback (코드 분기) 제거됨.

- I-CEDAR-ARCHIVE-PROTECT. **reserved owner agent 는 archive 불가** (governance-cedar v2.7 §X): `archive_agent` action 이 `context.reservedOwner = true` 인 resource 에 대해 실행되면 Cedar 가 forbid. `30-protect-admin.cedar` 의 단일 forbid 절이 이를 담당. `reservedOwner` 는 호출측에서 결정 — `isReservedUsername(agentId.split('/')[0])` 결과. 현재 archive transition (archived false → true) 을 수행하는 callsite 없음 — 정책만 forward. transition 이 land 할 때 Cedar 호출이 반드시 경유해야 하며, 미경유 시 I-CEDAR-EVALUATOR-INVARIANT 가 fail-closed 로 차단.

- I-CEDAR-PERSONA. **`/persona set|reset` 은 `set_persona` Cedar action 을 경유 (fail-closed)** (governance-cedar v2.9 §X4): `slash-commands.js` 의 `persona` 핸들러가 `set` / `reset` 서브커맨드 실행 전 (1) `evaluator` / `jwtSub` / `agentId` 중 하나라도 없으면 즉시 deny (`"Persona change denied: missing-evaluator"`) — fail-closed. (2) 조건 통과 후 `Op.CheckAccess({ action: 'set_persona', principal: { type: 'LocalUser', id: jwtSub }, resource: { type: 'Agent', id: agentId }, context: { isAdmin, reservedOwner } })` 를 호출하고 `runCheckAccess(evaluator, op)` 로 Cedar 평가. Cedar deny 시 `matchedPolicies` 노출. `31-protect-persona.cedar` 가 `reservedOwner && !isAdmin` 조건에서 forbid — admin/* agent 의 persona 는 admin 만 변경 가능. 이 정책은 ownership middleware 가 없는 future paths (admin CLI / a2a / interpreter) 에서도 admin/* persona 보호. `handleSlashCommand` 는 `session-api.js` 에서만 호출되므로 production 호환성 영향 없음. `/persona show` 는 read-only 이므로 Cedar 호출 없음.

- I-CEDAR-EVALUATOR-INVARIANT. **registry + entry 있을 때 evaluator 필수** (governance-cedar v2.6 §X1): `canAccessAgent` 가 `registry` 를 받고 해당 `agentId` 의 entry 를 찾으면, `evaluator` 가 함수가 아닌 경우 즉시 `deny(REASON.MISSING_EVALUATOR)` 반환 (fail-closed). 이 조건을 통과한 후에만 Cedar `Op.CheckAccess` 를 실행한다. 의도: registry+entry 있는데 evaluator 부재 = silent fail-open 위험. 명시적 fail-closed 로 결정 + audit 양쪽 보존. `REASON.MISSING_EVALUATOR = 'missing-evaluator'` 신규 상수. 5 진입점은 이미 evaluator 전달 — 외부 직접 호출자만 영향.

- I8. **Admin quota 면제**: `role === 'admin'`이면 quota 체크 스킵. 단, 환경변수 `PRESENCE_ADMIN_AGENT_HARD_LIMIT` (기본 50) 하드 상한 존재. **v2.4 (KG-26 resolved): Cedar 정책 (`11-admin-limit.cedar`) 으로 hardLimit 강제. `submitUserAgent` 가 `requester === ADMIN_USERNAME` 일 때 `context.isAdmin=true` + `hardLimit` (env `PRESENCE_ADMIN_AGENT_HARD_LIMIT` 또는 50) 첨부. admin 의 일반 quota (maxAgentsPerUser) 는 면제, hardLimit 만 적용.**

- I9. **Governance 파일 원자성**: user config append, pending→approved/rejected 이동 모두 atomic (tmp + rename). approve 재실행 시 config 선확인(idempotent replay) — config에 이미 있으면 파일만 정리.

- I10. **Op.Delegate qualifier 파싱**: `resolveDelegateTarget(target, { currentUserId })`. slash 없음 → `{currentUserId}/{target}`으로 qualify. slash 1개 → 절대 agentId. slash 2개 이상 → Left(에러). reserved username 자체를 agentName으로 사용 시 Left(에러). Parser → Resolver → Authz 순서 강제.

- I11. **A2A 비활성 기본**: `config.a2a.enabled` 기본 `false`. false이면 `/a2a/*` 라우트 미등록, self card 미생성. `true`이면 `publicUrl` 필수 — 없으면 라우터 생성 실패.

- I13. **세 토큰 type 완전 분리 + Bearer 강제 + fail-closed 부팅** (KG-17 resolved, 2026-04-26 강화):
  - 세 토큰 type 이 sign/verify 양쪽에서 명시 강제됨:
    - `signAccessToken` payload `type: 'access'` 포함. `verifyAccessToken` 은 `type !== 'access'` 이면 `Either.Left('not an access token')` 반환.
    - `signRefreshToken` payload `type: 'refresh'` 포함. `verifyRefreshToken` 은 `type !== 'refresh'` 이면 `Either.Left('not a refresh token')` 반환.
    - `signA2aToken(sub)` payload `type: 'a2a'` 포함. `verifyA2aToken` 은 `type !== 'a2a'` 이면 `Either.Left('not an a2a token')` 반환.
  - 토큰 교차 사용(misuse) 은 세 verify 함수 모두에서 거부됨 — 어느 토큰도 다른 경로로 우회 불가.
  - POST `/a2a/*` 는 `Authorization: Bearer <a2a-jwt>` 헤더 필수. 헤더 없으면 `AUTH_MISSING(-32000)`, 검증 실패이면 `AUTH_INVALID(-32002)` 반환.
  - `createA2aRouter` 부팅 시 `tokenService.verifyA2aToken` 함수 부재이면 throw — 의존성 누락 fail-closed.
  - scope: self-A2A (같은 머신 = 같은 secret). 멀티 머신 간 검증 (peer key registry / mTLS) 은 Phase 2.

- I12. **USER 세션 agentId = config.primaryAgentId**: 모든 USER 타입 세션의 agentId 는 `config.primaryAgentId` 에서 결정. 부재 시 `${userId}/default` fallback. persistence path 의 agent 디렉토리도 동일 규칙. `resolvePrimaryAgent` 헬퍼 (`packages/core/src/core/agent-id.js`) 가 단일 진실의 원천. 4 진입점 (boot 기본 세션 / lazy 접근 / POST /sessions / scheduler legacy fallback) 모두 헬퍼 경유. (KG-16 resolved)

- I-WD. **workingDir = Config.userDataPath(userId) 고정**: 모든 세션의 `workingDir`은 생성 시 `Config.userDataPath(userId)`로 자동 결정된다. 외부 입력(`opts.workingDir`, TUI `cwd`, `POST /sessions` body `workingDir`)은 무시된다. 런타임 변경 불가. 세션 유형(USER/SCHEDULED/AGENT)과 무관하게 동일 규칙이 적용된다. `workingDir`은 persistence에 저장하지 않으며 복원 시에도 `userId` 기반으로 재계산한다. tool 경계 검증(`isWithinWorkspace`), `shell_exec` cwd, system prompt `WORKING_DIR` 섹션의 유일 기준점.

---

## 경계 조건 (Edge Cases)

- E1. `validateAgentId(null | undefined | 123)` → Left (타입 가드)
- E2. `validateAgentId('anthony/abc-')` → Left (끝 하이픈)
- E3. `validateAgentId('anthony/a--b')` → Left (연속 하이픈)
- E4. `validateAgentId('Anthony/default')` → Left (대문자)
- E5. `validateAgentId('a/b/c')` → Left (slash 2개)
- E6. non-admin 유저가 `admin/manager`에 접근 → `canAccessAgent` `allow=false`, `reason=admin-only`
- E7. archived agent에 `new-session` intent → `allow=false`, `reason=archived`
- E8. archived agent에 `continue-session` intent → `allow=true` (graceful retire §5.4)
- E9. registry에 미등록 agentId → archived 판정 불가, ownership check만 수행 → 통과 (세션 생성 이후 단계에서 막힐 수 있음)
- E10. `resolveDelegateTarget('admin', { currentUserId: 'anthony' })` → Left (reserved name을 agentName으로 사용 거부)
- E11. `resolveDelegateTarget('summarizer', {})` (currentUserId 없음) → Left (qualify 불가)
- E12. `canAccessAgent` `intent` 파라미터가 INTENT enum 외 값 → `allow=false`, `reason=invalid-intent`
- E13. admin bootstrap State 0 실패(디스크 쓰기 실패 등) → throw → 서버 부팅 거부
- E14. admin bootstrap State 1: admin config.json이 손상되어 파싱 불가 → 빈 config로 fallback 후 덮어씀
- E15. `submitUserAgent` 동일 agentName(non-archived) 재시도 → `ALREADY_EXISTS` 반환
- E16. `a2a.enabled=true`이고 `publicUrl=null`이면 `createA2aRouter` 호출 시 throw (라우터 미생성)
- E17. admin singleton session: `canAccessAgent({ agentId: 'admin/manager', intent: 'new-session', findAdminSession: () => sessionManager.findAdminSession() })` 호출 시 기존 active USER 세션 확인 — `findAdminSession()` 결과가 `{ kind: 'present' }` 이면 deny (`reason=admin-singleton`). 회복은 `DELETE /api/sessions/:id` 명시 삭제 또는 서버 재시작. (KG-15 resolved)

---

## Known Gaps

- **KG-15**: ~~Admin singleton session 강제 미구현. 설계 §9.3.5에서 concurrent approve race 차단을 위해 admin 계정 단일 session 강제를 요구하나, `canAccessAgent`에 기존 session 확인 로직이 없다. 동시 approve race는 idempotent replay (I9)로 crash recovery에는 대응되나 concurrent race는 미차단. v2 대상.~~ resolved by feature/cedar-governance-v2 (2026-04-26). 옵션 (a) 채택: takeover 제거, 활성 admin USER session 존재 시 새 session 거부. `SessionManager.findAdminSession()` 추가 (tagged union `{ kind: 'present'|'absent' }`), `canAccessAgent`가 옵션 콜백 `findAdminSession` 수용, `REASON.ADMIN_SINGLETON` 추가. TTL 자동 만료는 미구현 — UserSession idle monitor 후속 과제.
- **KG-16**: ~~M3 미완료. `config.primaryAgentId` 적용 없이 `{username}/default` hardcode (I12). M3 완료 전까지 `primaryAgentId` 변경 CLI 동작이 세션 생성에 반영되지 않는다.~~ resolved by feature/cedar-governance-v2 (2026-04-26). `resolvePrimaryAgent` 헬퍼 추가 (core/agent-id.js). Config.Schema 에 `primaryAgentId` 추가로 admin 의 `admin/manager` 가 런타임에 보존됨. 4 진입점 (boot 기본 세션 / lazy /api/sessions/:id 접근 / POST /api/sessions / scheduler legacy null-owner fallback) 모두 헬퍼 경유.
- **KG-17**: ~~`canAccessAgent` 진입점 #2 (a2a-router) 의 A2A JWT 인증 미완성. 현재 `X-Presence-Caller` 헤더 stub 사용. 실제 JWT 서명 검증은 authz phase (P23-5) 구현 후 연결 예정.~~ resolved by feature/cedar-governance-v2 (2026-04-26). `X-Presence-Caller` 헤더 stub 완전 제거. `Authorization: Bearer <a2a-jwt>` 파싱 → `tokenService.verifyA2aToken` (서명/만료/audience/type) → `payload.sub` 를 caller 로 추출. `AUTH.A2A_TOKEN_EXPIRY_S = 60` 으로 짧은 만료. self-A2A scope (같은 머신 = 같은 secret). 멀티 머신 간 검증은 Phase 2. I13 으로 불변식 승격.
- **KG-18**: ~~5진입점 enforcement 테스트가 정적 grep 수준 (text 존재 여부). 실제 `canAccessAgent` 반환값을 무시하는 코드가 추가되어도 테스트가 통과할 수 있다.~~ resolved by 2026-04-25. `agent-access.js`에 ring 버퍼(cap 200) spy infra(`inspectAccessInvocations` / `resetAccessInvocations`) 도입. 5 진입점 각각에 동적 spy 검증 추가: #1 server.test.js S1, #2 a2a-invoke.test.js AI1, #3 server.test.js S10, #4 scheduler-e2e.test.js SE1, #5 delegate.test.js #1. spy unit 테스트는 agent-access.test.js AA17~AA19. 정적 grep(test/regression/agent-access-enforcement.test.js)은 1차 방어로 병존 유지.
- **KG-19**: ~~JobStore 소유권 필터링 누락.~~ resolved by fix/kg-19-job-owner-filter (2026-04-24, tool boundary 봉합 범위). `listJobs` / `getJob` / `updateJob` / `deleteJob` / `getRunHistory` 5 메서드에 `{ ownerAgentId }` 옵션 추가. `JobToolFactory` 가 고정 전달해 agent tool 경로는 자기 소유 job 만 관리 가능. 시스템 스케줄러 경로(`getDueJobs` / `startRun` 등)는 owner 무시 유지. Legacy owner-null row 는 tool 경로에서 조회 불가. 미해소 범위: 관측성 분리, TODO_REVIEW agent-per-instance 정책, 시스템 경로 자동 drift 탐지. M3 복수 agent 허용 시 재검토 필요.

- **KG-20** (REGISTRY: KG-20): ~~AgentId branded type 런타임 강제 부재. 설계 (`docs/design/agent-identity-model.md` §14.2): JS 환경에서 `string & { __brand }` 타입 시뮬레이션은 컴파일 타임 방어이며, 실제 `makeAgentId` 팩토리 호출 discipline 강제는 통합 테스트에 의존. 그러나 `validateAgentId` 미경유 raw 문자열을 `Session({ agentId })` 등에 직접 주입하는 경로의 회귀 검증 부재. 영향: M3 다중 agent 도입 시 raw `${user}/${name}` 조립 코드가 늘어나면 검증 우회 위험. 후속: KG-18 spy infra 패턴 확장 (validateAgentId 호출 trace) 또는 Session 생성자가 매번 `validateAgentId.either(opts.agentId)` 검증.~~ resolved by feature/cedar-governance-v2 (2026-04-26). 후속의 두 옵션 중 후자(Session 생성자 항상 검증)는 이미 `assertValidAgentId(opts.agentId)` 로 시행 중임을 실사로 확인 — 누락된 건 회귀 방어. KG-18 의 INV-AGENT-ACCESS 정적 grep 패턴을 미러한 INV-AGENT-ID-VALIDATION 정적 검사 (`test/regression/agent-id-validation-enforcement.test.js`) 도입으로 5 핵심 사이트 (Session 생성자, AgentRegistry.register, resolveDelegateTarget, Op.SendA2aMessage 인터프리터, A2A self card) 의 validateAgentId/assertValidAgentId 호출 라인 회귀를 정적으로 차단. 동적 spy 강화는 미적용 — 정적 grep + 단위 테스트 (SD11~13, RDT1~9) 조합으로 회귀 검증 부재 해소.

- **KG-21** (REGISTRY: KG-21): ~~Parser→Resolver→Authz 순서 런타임 검증 부재. 설계 (`docs/design/agent-identity-model.md` §14.2 item 2): `UnresolvedTarget` / `ResolvedAgentId` shape 분리로 컴파일 타임 방어 (TypeScript 였다면). JS 환경에선 `resolveDelegateTarget` 결과 (`ResolvedAgentId`) 를 거치지 않고 raw target 을 `canAccessAgent` 에 직접 넣는 경로가 회귀로 들어와도 탐지 불가. 영향: I10 (Parser→Resolver→Authz 순서) 의 런타임 보장 없음. KG-18 spy 가 `agentId` 캡처는 하지만 "이 값이 resolver 를 거쳤는가" 는 모름. 후속: ResolvedAgentId 에 `__resolved: true` 마커 추가 + `canAccessAgent` 가 마커 없는 입력 거부, 또는 resolver 진입 spy 와 authz spy 의 호출 순서 검증.~~ resolved by feature/cedar-governance-v2 (2026-04-26). 후속의 두 옵션 (ResolvedAgentId 마커 / 호출 순서 spy) 모두 침습적 — 실사 결과 `delegate.js` 가 이미 Parser→Resolver→Authz 순서로 호출하고 있음 (line 18 resolveDelegateTarget, line 27 canAccessAgent). 부족했던 건 회귀 방어. KG-18 INV-AGENT-ACCESS / KG-20 INV-AGENT-ID-VALIDATION 패턴을 미러한 INV-DELEGATE-ORDER 정적 검사 (`test/regression/delegate-order-enforcement.test.js`) 도입으로 호출 라인 순서 회귀를 정적으로 차단. 동적 spy 보강은 미적용 — KG-18 spy 가 이미 DELEGATE intent 의 agentId 자취를 캡처.

---

## 테스트 커버리지

- I1 → `packages/core/test/core/agent-id.test.js` (전체 §3.2 표 커버)
- I1 (회귀) → `test/regression/agent-id-validation-enforcement.test.js` (5 사이트 import + 호출 정적 검사)
- I12 → `packages/core/test/core/agent-id.test.js` PA1~PA6, `packages/server/test/auth-e2e.test.js` AE18
- I2 → `packages/infra/test/agent-access.test.js` AA2/AA3/AA15
- I3 → `packages/infra/test/session.test.js` SD11/SD12/SD13 (생성자 invalid agentId throw)
- I4 → `test/regression/agent-access-enforcement.test.js` (5진입점 정적 grep) + 동적 spy: S1(session-api), AI1(a2a-router), S10(ws-handler), SE1(scheduler-factory), delegate.test.js #1(Op.Delegate)
- I5 → `packages/infra/test/agent-access.test.js` AA-X1/AA-X2 (evaluator 경로 archived 시나리오)
- I6 → `packages/infra/test/agent-governance.test.js` (runAdminBootstrap 통합)
- I7 → `packages/infra/test/agent-governance.test.js` GV4/GV5/GV6
- I-CEDAR-QUOTA → `packages/infra/test/agent-governance.test.js` GV-X1~GV-X14, `packages/infra/test/cedar-evaluator.test.js` CE7~CE11, `packages/infra/test/cedar-boot.test.js` CB7~CB9, `packages/infra/test/check-access-interpreter.test.js` CK4, `test/regression/cedar-quota-policy.test.js` (INV-CEDAR-QUOTA-POLICY + INV-CEDAR-ADMIN-EXEMPT + INV-SUBMIT-USER-AGENT-CONTEXT + INV-CREATE-AGENT-CALLERS + INV-CEDAR-CUSTOM-BLOCK)
- I-CEDAR-ARCHIVED → `packages/infra/test/agent-access.test.js` AA-X1(archived+new-session deny)/AA-X2(archived+continue-session allow)/AA-X3(Cedar context 셰이프)/AA-X5(non-archived allow)/AA-X6(registry 없으면 evaluator skip), `packages/infra/test/cedar-evaluator.test.js` CE12, `packages/infra/test/cedar-boot.test.js` CB10, `test/regression/cedar-quota-policy.test.js` (INV-CEDAR-ARCHIVED-POLICY + INV-ACCESS-AGENT-CALLERS)
- I-CEDAR-ARCHIVE-PROTECT → `packages/infra/test/cedar-evaluator.test.js` CE13.1 (reservedOwner=false → allow) / CE13.2 (reservedOwner=true → deny), `packages/infra/test/cedar-boot.test.js` CB11 (실 자산 부팅 후 30-protect-admin 동작). cedar-mock.js decideArchiveAgent 분기 추가.
- I-CEDAR-PERSONA → `packages/infra/test/cedar-evaluator.test.js` CE14.1 (!reservedOwner → allow + audit 1건), CE14.2 (reservedOwner+isAdmin → allow), CE14.3 (reservedOwner+!isAdmin → deny + audit deny). `packages/infra/test/cedar-boot.test.js` CB12 — 실 자산 부팅 후 3 케이스 (!reservedOwner allow / reservedOwner+!isAdmin deny / reservedOwner+isAdmin allow). `test/regression/cedar-quota-policy.test.js` INV-CEDAR-PERSONA-PROTECT (31-protect-persona.cedar 존재 + forbid 조건 + slash-commands fail-closed 패턴 grep). `packages/server/test/server.test.js` S7b (mock evaluator 경로 /persona show·set·reset 정상 동작). `/persona show` 의 Cedar 비호출은 별도 테스트 없음 — S7b 로 간접 검증.
- I-CEDAR-EVALUATOR-INVARIANT → `packages/infra/test/agent-access.test.js` AA-X4 (registry+entry 있는데 evaluator 미전달 → MISSING_EVALUATOR fail-closed)
- I9 → `packages/infra/test/agent-governance.test.js` GV9/GV10/GV14
- I10 → `packages/infra/test/resolve-delegate-target.test.js` RDT1~RDT9 (Parser→Resolver→Authz §3.6 전체 케이스) + `test/regression/delegate-order-enforcement.test.js` (Op.Delegate 인터프리터 호출 순서 정적 검사)
- I11 → `packages/server/test/a2a-discovery.test.js` AD4a (`GET /a2a/.well-known/agents` — agents 배열 JSON 미반환) / AD4b (`GET /a2a/admin/manager/card` — card shape 미반환) / AD4c (`POST /a2a/admin/manager` — JSON-RPC envelope 미반환, router 핸들러 미실행). 세 케이스 모두 negation 검증으로 라우트 미등록 확인. enabled=true + publicUrl=null 부팅 거부는 E16 커버 (`packages/server/test/a2a-boot-guard.test.js`)
- I13 → `packages/infra/test/auth-token.test.js`:
  - A2A1 (sign + verify 정상, payload.type='a2a' 확인)
  - A2A2 (access 토큰 → verifyA2aToken Left 'not an a2a token')
  - A2A3 (A2A 토큰 → verifyAccessToken Left 'not an access token' — 이전 Right에서 의미 반전)
  - A2A4 (malformed/empty/null → Left)
  - A2A5 (refresh 토큰 → verifyAccessToken Left 'not an access token' — 신규)
  - A2A6 (access 토큰 payload.type='access' 확인 — 신규)
  - `packages/server/test/a2a-invoke.test.js` AI2 (AUTH_MISSING), AI10 (위조 서명 → AUTH_INVALID -32002), AI11 (access 토큰 오용 → 'not an a2a token')
- I-WD → `packages/infra/test/session.test.js` SD6 (workingDir = userDataPath), `packages/server/test/server.test.js` S20b (body workingDir 무시 + 응답 effective 확인), `packages/server/test/scheduler-e2e.test.js` SE3 (SCHEDULED 세션 workingDir)
- E6 → `packages/infra/test/agent-access.test.js` AA3
- E7/E8 → `packages/infra/test/agent-access.test.js` AA-X1(E7: evaluator 경로 archived+new-session deny)/AA-X2(E8: evaluator 경로 archived+continue-session allow)
- E12 → `packages/infra/test/agent-access.test.js` AA14
- E15 → `packages/infra/test/agent-governance.test.js` GV7
- E17 → `packages/infra/test/agent-access.test.js` AS1~AS5, `packages/infra/test/session-manager-routing.test.js` SM-admin1~4

---

## 관련 코드

- `packages/core/src/core/agent-id.js` — validateAgentId, validateAgentNamePart, isReservedUsername, assertValidAgentId, RESERVED_USERNAMES, resolvePrimaryAgent
- `packages/infra/src/infra/config.js` — Config.Schema.primaryAgentId (z.string().optional())
- `packages/infra/src/infra/authz/agent-access.js` — canAccessAgent, INTENT, REASON
- `packages/infra/src/infra/authz/agent-governance.js` — submitUserAgent, approveUserAgent, denyUserAgent, loadAgentPolicies, getActiveAgentCount
- `packages/infra/src/infra/admin-bootstrap.js` — runAdminBootstrap, 3단계 상태기계, deleteInitialPasswordFile
- `packages/infra/src/infra/agents/resolve-delegate-target.js` — resolveDelegateTarget
- `packages/infra/src/infra/agents/agent-registry.js` — createAgentRegistry
- `packages/infra/src/infra/sessions/session.js` — Session 생성자 (agentId 필수 검증)
- `packages/server/src/server/session-api.js` — 진입점 #1 (NEW_SESSION/CONTINUE_SESSION), agents/{agentName}/sessions/{sid}/ 경로 생성
- `packages/server/src/server/a2a-router.js` — 진입점 #2 (DELEGATE, Bearer JWT 검증)
- `packages/infra/src/infra/auth/token.js` — `createTokenService`: `signA2aToken` / `verifyA2aToken` (type='a2a' 분리)
- `packages/infra/src/infra/auth/policy.js` — `AUTH.A2A_TOKEN_EXPIRY_S` (현재 60s)
- `packages/infra/src/infra/agents/a2a-protocol.js` — `JsonRpcErrorCode.AUTH_INVALID = -32002`
- `packages/infra/src/infra/agents/a2a-client.js` — `sendTask(..., { callerToken })`: callerToken 있으면 Bearer 헤더 자동 첨부
- `packages/server/src/server/ws-handler.js` — 진입점 #3 (CONTINUE_SESSION)
- `packages/server/src/server/scheduler-factory.js` — 진입점 #4 (SCHEDULED_RUN)
- `packages/infra/src/interpreter/delegate.js` — 진입점 #5 (DELEGATE)
- `packages/infra/src/infra/jobs/job-store.js` — JobStore schema v1 (owner_user_id + owner_agent_id), agent tool 경로 5 메서드 ownerAgentId 필터링
- `packages/infra/src/infra/jobs/job-tools.js` — JobToolFactory, 5 tool(list_jobs/update_job/delete_job/job_history/run_job_now) ownerAgentId 고정 전달
- `packages/infra/src/infra/memory.js` — Memory 클래스 (agentId 파라미터 격리)
- `packages/infra/src/infra/actors/memory-actor.js` — MemoryActor (agentId 기반 recall/save)
- `packages/infra/src/infra/sessions/internal/session-actors.js` — sessionEnv에 agentId 주입
- `packages/infra/src/infra/auth/remove-user.js` — removeUserCompletely (agentIds 순회 clearAll)
- `packages/server/src/server/slash-commands.js` — /memory 슬래시 커맨드 ctx.agentId 전달, /persona set|reset Cedar 게이트 (I-CEDAR-PERSONA)
- `packages/core/src/core/repl-commands.js` — Repl agentId 기반 memory 조회

---

## 변경 이력

- 2026-04-22: 초기 작성 — feature/agent-identity-model 브랜치 23커밋 검증 후 작성. KG-15~18 등록.
- 2026-04-23: I-WD 추가 — W1(cb6c59a) workingDir 단일 규칙 리팩토링 반영. `workingDir = Config.userDataPath(userId)` 고정, 외부 입력 무시, persistence 미저장 규칙. 테스트 커버리지 I-WD 추가.
- 2026-04-24: KG-19 추가 — feature/agent-scoped-data 브랜치 data-scope 조사에서 발견. JobStore 의 owner_user_id/owner_agent_id 컬럼이 schema 에만 존재, 조회/수정/삭제 쿼리에서 필터링에 사용 안 됨. 이번 data-scope 리팩토링 범위 분리 — 별도 티켓으로 등록.
- 2026-04-24: KG-19 resolved — fix/kg-19-job-owner-filter. JobStore agent tool 경로 5 메서드 owner 필터링 활성화. JobToolFactory ownerAgentId 고정 전달. tool boundary 봉합 범위(partial resolve). 관련 코드 목록에 job-tools.js 추가.
- 2026-04-24: data-scope-alignment 완료 반영 — Memory/Session 격리 단위 변경(docs/design/data-scope-alignment.md) 구현 완료. 관련 코드 목록에 memory.js / memory-actor.js / session-actors.js / remove-user.js / slash-commands.js / repl-commands.js 추가. session-api.js 설명에 agents/{agentName}/sessions/{sid}/ 경로 생성 명시.
- 2026-04-25: KG-18 resolved — spy infra 도입 + 5진입점 동적 검증 완료. I4 테스트 커버리지 갱신.
- 2026-04-25: KG-20 + KG-21 추가 — A2A Phase 1 S4 + KG-18 spy infra 마무리 후 진실의 원천 정합성 검증에서 발견된 branded type 런타임 강제 부재(KG-20) 및 Parser→Resolver→Authz 순서 런타임 검증 부재(KG-21).
- 2026-04-26: KG-16 resolved — feature/cedar-governance-v2 (2026-04-26). M3 primaryAgentId 적용 완료. Config.Schema 에 `primaryAgentId` 추가로 admin 의 'admin/manager' 가 런타임에 보존됨. `resolvePrimaryAgent` 헬퍼 신규 (core/agent-id.js). 4 진입점이 헬퍼 경유로 통일. I12 텍스트 개정, 테스트 커버리지 PA1~PA6 / AE18 추가.
- 2026-04-26: KG-15 resolved — feature/cedar-governance-v2. admin singleton session 강제 구현 (옵션 a: takeover 제거, 활성 세션 존재 시 신규 거부). E17 callback 시그니처 갱신, 테스트 커버리지 E17 추가.
- 2026-04-26: KG-20 resolved — INV-AGENT-ID-VALIDATION 정적 검사 추가 (5 사이트 정적 grep). 기존 단위 테스트 (SD11~13, RDT1~9) 는 stale 했던 ⚠️ 표기 제거하며 매핑 정리.
- 2026-04-26: KG-21 resolved — INV-DELEGATE-ORDER 정적 검사 추가. delegate.js 의 resolveDelegateTarget/canAccessAgent 호출 순서를 라인 번호 비교로 강제. 후속 두 옵션 (마커 / spy) 은 침습적이라 미적용 — 정적 grep 으로 회귀 방어 충분.
- 2026-04-26: KG-17 resolved — feature/cedar-governance-v2. A2A 라우터 caller 인증을 `X-Presence-Caller` 헤더 stub 에서 JWT Bearer 서명 검증으로 교체. `signA2aToken` / `verifyA2aToken` (type='a2a' 분리) 추가. `AUTH.A2A_TOKEN_EXPIRY_S = 60`. `AUTH_INVALID(-32002)` 에러 코드 추가. I13 불변식 신규 등록. 테스트 커버리지 A2A1~A2A4 / AI10 / AI11 추가. 관련 코드에 token.js / policy.js / a2a-protocol.js / a2a-client.js 추가.
- 2026-04-26: I11 테스트 매핑 갱신 — AD4 를 AD4a/b/c 로 확장하여 세 라우트 미등록 (agents 목록, card, JSON-RPC invoke) 을 모두 negation 검증으로 확인. ⚠️ 미커버 표기 해소.
- 2026-04-26: I13 강화 — verifyAccessToken 도 type 분리 검사 적용. 세 토큰 type 모두 명시 분리 (access/refresh/a2a 모두 sign + verify 양쪽 강제). 테스트 A2A3 의미 반전 (Right → Left) + A2A5/A2A6 신규 추가 (총 36 passed).
- 2026-04-27: I-CEDAR-QUOTA 신규 등록 — governance-cedar v2.3 (옵션 Y' hybrid). `submitUserAgent` 의 quota 분기를 `10-quota.cedar` 정책으로 흡수. `interpretCedarDecision` 순수 함수가 Cedar 결과를 governance 4-state 로 매핑. 운영자 슬롯(`50-*.cedar`)은 P4 까지 차단 (cedar-wasm 4.10.0 matchedPolicies 파일 식별 불가 제약). I8 끝에 KG-26 갭 주석 추가. 테스트 커버리지 I-CEDAR-QUOTA 항목 추가. 배포 영향: cedar/policies/ 디렉토리에 50-*.cedar 가 존재하는 운영 환경은 부팅 거부 (P4 까지 차단). 기존 호출자는 호환 — submitUserAgent 의 시그니처/리턴 shape 무변동.
- 2026-04-27: KG-26 resolved — admin 면제 + hardLimit 을 Cedar 정책으로 흡수 (governance-cedar v2.4). `11-admin-limit.cedar` 신규, `10-quota.cedar` 에 `!isAdmin` 조건 추가, schema.context 4 필드 (currentCount/maxAgents/isAdmin/hardLimit). `submitUserAgent` 가 isAdmin/hardLimit 첨부. I-CEDAR-QUOTA 본문 갱신, I8 의 갭 마커 제거. INV-CEDAR-ADMIN-EXEMPT 정적 회귀 추가. 배포 영향: `PRESENCE_ADMIN_AGENT_HARD_LIMIT` 환경변수 미설정 시 기본 50 적용 — 기존 admin 환경에서 50개 미만 agent 가 있으면 무영향.
- 2026-04-28: I-CEDAR-ARCHIVED 신규 + I5 갱신 — archived agent 분기를 `20-archived.cedar` 정책으로 흡수 (governance-cedar v2.5). entity `Agent` + action `access_agent` schema 추가, `00-base.cedar` 가 access_agent permit. canAccessAgent 옵션 evaluator + 5 진입점 evaluator 전달 (PresenceServer/UserContext 의 evaluator). 잔여 코드 의미론은 `manual-review` (autoApprove=false) 1 항목. 배포 영향: 5 진입점 호출처에서 evaluator 전달 — 미전달 시 코드 분기 fallback 으로 동작 변경 없음.
- 2026-04-28: I-CEDAR-EVALUATOR-INVARIANT 신규 + I5/I-CEDAR-ARCHIVED 갱신 — governance-cedar v2.6 §X1. registry+entry 있을 때 evaluator 필수, 미전달 시 `REASON.MISSING_EVALUATOR` fail-closed. legacy fallback (코드 분기) 제거. AA5/AA6/AA7/AA7b (legacy fallback 의존) 삭제; AA-X1~X3/X5 가 evaluator 경로로 대체; AA-X4 의미 변경 (legacy fallback → MISSING_EVALUATOR 검증). 5 진입점은 이미 evaluator 전달 — 외부 직접 caller 만 영향. 테스트 커버리지 I5/E7/E8 갱신, I-CEDAR-EVALUATOR-INVARIANT 매핑 추가.
- 2026-04-28: I-CEDAR-ARCHIVE-PROTECT 신규 + I5 갱신 — governance-cedar v2.7 §X. `archive_agent` action + `30-protect-admin.cedar` 정책 도입. reserved owner(admin/*) archive 금지를 Cedar 선언적 정책으로 흡수. 현재 archive transition 구현 부재 — 정책만 forward, transition land 시 자동 적용 (Cedar 호출 누락 시 I-CEDAR-EVALUATOR-INVARIANT 가 fail-closed). 테스트 커버리지 I-CEDAR-ARCHIVE-PROTECT 매핑 추가 (CE13.1/CE13.2, CB11, cedar-mock decideArchiveAgent).
- 2026-04-28: I-CEDAR-PERSONA 신규 — governance-cedar v2.8 §X3. `/persona set|reset` 의 `set_persona` Cedar action + `00-base.cedar` permit + audit JSONL governance trace 도입. 의미 제약 forbid 정책 없음 — ownership 은 session middleware 의 canAccessAgent 가 이미 보장. evaluator/jwtSub/agentId 미전달 시 게이트 skip (fail-open, CLI·테스트 호환). `slash-commands.js` 통합, session-api.js chat 핸들러에서 evaluator/jwtSub 추가 전달. 테스트 커버리지 CE14/CB12/S7b 매핑 추가. 관련 코드 slash-commands.js 주석 갱신.
- 2026-04-28: I-CEDAR-PERSONA fail-open → fail-closed 전환 (governance-cedar v2.9 §X4). `31-protect-persona.cedar` 신규 (`reservedOwner && !isAdmin → deny`). `slash-commands.js` 가 evaluator/jwtSub/agentId 누락 시 즉시 deny (fail-closed). 모든 Cedar 게이트가 fail-closed 로 통일. v2.8 spec-guardian design tension 해소. 테스트 커버리지 CE14 → CE14.1/14.2/14.3 매트릭스, CB12 → 3 케이스, INV-CEDAR-PERSONA-PROTECT 정적 회귀 추가. I-CEDAR-PERSONA 불변식 본문 갱신.
