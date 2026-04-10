# 인증/인가 정책

## 목적

presence의 인증 경계를 정의한다. 유저 등록, 로그인, 토큰 갱신, 비밀번호 변경, WS 인증이 일관된 규칙 하에 작동함을 보장한다. 인증 없이는 어떤 기능도 사용 불가.

## 불변식 (Invariants)

- I1. **유저는 설정 파일(CLI)로만 추가**: 런타임 셀프 가입 없음. `~/.presence/users.json`에 등록 가능한 CLI 커맨드 4종:
  - `npm run user -- init [--username <name>]` — 최초 설정 (JWT secret 생성 포함, 이미 유저가 있으면 에러)
  - `npm run user -- add --username <name>` — 추가 유저 등록
  - `npm run user -- passwd --username <name>` — 비밀번호 재설정 (기존 세션 전체 무효화)
  - `npm run user -- list` — 등록된 유저 목록 출력
- I2. **인증 없이 서비스 사용 불가**: `/api` 하위 모든 엔드포인트는 유효한 Access Token 없이 403/401 반환. 예외: `/api/auth/login`, `/api/auth/refresh`, `/api/auth/logout`, `/api/auth/status`, `/api/instance`. (`auth-setup.js:28` publicPaths 목록 기준) `authEnabled`는 `PresenceServer.#boot()`에서 `true`로 하드코딩. 런타임 또는 설정 파일로 override 불가. `session-api.js`와 `ws-handler.js`에 존재하는 `authEnabled &&` 조건 분기는 테스트/레거시 호환 목적이며, 운영 환경에서는 항상 true 경로를 탄다.
- I3. **mustChangePassword 강제**: 최초 등록 사용자는 `mustChangePassword: true`. 이 상태에서 `/api/auth/change-password`, `/api/auth/refresh`, `/api/auth/logout` 외 모든 API 403 반환. 실제 상수는 `http-service.js`의 `MUST_CHANGE_PASSWORD_ALLOWLIST`이며 `req.path` 기준으로 `/auth/change-password`, `/auth/refresh`, `/auth/logout` 형식 (Express 라우터가 `/api` prefix를 벗긴 후 매칭). 외부 URL 기준으로는 `/api/auth/...`와 동일 endpoint.
- I4. **Access Token 수명**: 15분. Refresh Token 수명: 7일.
- I5. **Refresh Token Rotation**: 토큰 갱신 시 기존 refresh 세션 무효화 후 새 세션 발급. `validateRefreshChain`에서 두 가지 경로 모두 `revokeAllRefreshSessions(sub)` 호출 후 즉시 거부:
  1. `!hasRefreshSession(sub, jti)` — 이미 폐기된 jti 재사용 → **탈취 감지** → `AUTH_ERROR.TOKEN_REVOKED` (401)
  2. `user.tokenVersion !== tokenVersion` — 비밀번호 변경 등으로 tokenVersion이 증가한 후 이전 refresh 재사용 → `AUTH_ERROR.TOKEN_INVALIDATED` (401)
- I6. **비밀번호 최소 길이**: 8자 이상. bcrypt 12 라운드 해시.
- I7. **유저명 형식**: `^[a-zA-Z0-9_-]{1,64}$`. 이 외 형식 addUser 시 에러.
- I8. **WS 인증**: WebSocket upgrade 시 아래 3단계 폴백 순서로 인증을 시도한다. 실패 시 연결 즉시 close. WS close 코드 단일 진원: `@presence/core/core/policies.js`의 `WS_CLOSE` 상수 객체 (`AUTH_FAILED=4001, PASSWORD_CHANGE_REQUIRED=4002, ORIGIN_NOT_ALLOWED=4003`). `packages/server/src/server/constants.js`는 re-export만 담당.
  1. `Authorization` 헤더 (Bearer access token)
  2. URL query param `?token=` (access token)
  3. Cookie `refreshToken` (refresh token — 갱신 후 access token으로 전환)
  각 경로는 "부재(absence)"와 "실패(invalid)"를 구분한다. 부재인 경우에만 다음 경로로 폴백하며, 실패인 경우 즉시 `AUTH_FAILED(4001)`로 close한다.
- I9. **비밀번호 변경 시 전체 세션 무효화**: `changePassword` 호출 시 `tokenVersion` 증가 + `refreshSessions = []`.
- I10. **Rate Limiting**: IP 기준 실패한 로그인 시도만 윈도 내 카운트. 한도 초과 시 429. 성공 로그인은 카운트하지 않는다. 상수: `AUTH.RATE_LIMIT_MAX_ATTEMPTS`(5회), `AUTH.RATE_LIMIT_WINDOW_MS`(60,000ms). 서버 프로세스 수명과 동일한 in-memory 카운터. (`http-service.js` `loginHandler()` — `record(ip)`는 `result.left` 실패 분기에서만 호출)
- I11. **Principal 정규화**: 모든 인증 경로(access token payload, refresh chain user)는 `{ username, roles, mustChangePassword }` 형태의 단일 Principal로 변환. `username` 부재 시 즉시 Left 반환. `mustChangePassword` 부재 시 `false`로 기본값 처리 — 이 기본값은 `user-store.js` 레코드 로드(`findUser`), `toPrincipal()` payload 변환(`policy.js:48 ?? false`), `service.js` 토큰 발급(`|| false`) 세 곳에서 일관되게 적용된다. 레거시 유저 레코드(해당 필드 없음)와 테스트 편의를 위한 의도적 설계이며, 부재를 `true`(강제 변경 필요)로 해석하지 않는다는 점에서 보안상 안전한 기본값이다.

## 경계 조건 (Edge Cases)

- E1. `users.json` 파일이 없는 상태에서 서버 시작 → `userStore.hasUsers()` false → 두 경로가 독립적으로 거부:
  1. CLI 진입점(`index.js:304`) — `process.exit(1)`로 조기 종료.
  2. 프로그램적 진입점 `createAuthSetup()`(`auth-setup.js:24`) — `throw new Error('No users configured...')`로 `#boot()` 실패.
  두 경로 모두 `hasUsers()` false를 거부하는 의도된 이중 방어다. 독립 테스트 없음(`index.js` CLI 분기 + `auth-setup.js` throw 모두 자동화 미커버). ⚠️
- E2. `mustChangePassword: true` 상태의 유저가 `/api/sessions/:id/chat` 요청 → 403 반환. 세션 상태 변경 없음.
- E3. 만료된 Access Token으로 API 접근 → 401 반환. Refresh Token으로 갱신 후 재시도 필요.
- E4. 이미 폐기된 jti로 refresh 시도 → 탈취 감지(`TOKEN_REVOKED`): 해당 유저 모든 refresh 세션 삭제 → 401 반환. 유저는 재로그인 필요.
- E4b. 비밀번호 변경 후 이전 refresh token 재사용 → tokenVersion 불일치(`TOKEN_INVALIDATED`): 해당 유저 모든 refresh 세션 삭제 → 401 반환. 유저는 재로그인 필요. (I9의 `changePassword` 경로와 독립적으로 갱신 시점에도 감지됨)
- E5. 동일 유저명으로 `addUser` 재시도 → `User already exists: {username}` 에러.
- E6. 쿠키 기반 WS 연결 시 `Origin` 헤더가 localhost/127.0.0.1/WsHandler 생성 시 주입된 `opts.host`(서버 리슨 주소, 기본 `127.0.0.1`) 외 → WS 즉시 close (CSRF 방지). Config 스키마에 `host` 항목은 없으며, `opts.host`는 `PresenceServer` 생성자의 `opts` 파라미터로 전달된다.
- E7. `authEnabled=true`이고 `Authorization` 헤더가 없는 WS 연결 → Origin 체크를 수행한다. Origin이 허용되지 않으면 `WS_CLOSE.ORIGIN_NOT_ALLOWED(4003)`으로 즉시 close. **쿠키 유무는 Origin 체크 트리거 조건에 영향 없다.** 조건: `this.#authEnabled && !req.headers.authorization && !this.#checkOrigin(req)` (`ws-handler.js:68`).
- E8. `roles`가 없는 레거시 유저 레코드 → `toPrincipal`에서 기본값 `[]` 반환.
- E10. `/api/auth/status`는 `userStore.listUsers()?.[0]?.username`을 반환한다. 멀티유저 환경에서는 첫 번째 등록 유저만 노출 — 주로 부팅 시 '등록된 유저 존재 여부' 확인 용도. 두 번째 이상 유저의 존재를 확인하는 수단이 아니다. (`auth-setup.js:37-40`)
- E9. Rate Limiter는 서버 재시작 시 초기화됨. 재시작으로 rate limit 우회 가능 — 알려진 한계.

## 테스트 커버리지

- I1 → `packages/infra/test/auth-user-store.test.js` (addUser, 중복 방지)
- I2 → `packages/server/test/auth-e2e.test.js` (미인증 요청 거부)
- I3 → `packages/server/test/server.test.js` (mustChangePassword 403)
- I4 → `packages/infra/test/auth-token.test.js` (토큰 만료 검증)
- I5 → `packages/infra/test/auth-middleware.test.js` (rotation, 탈취 감지)
- I8 → `packages/server/test/server.test.js` (WS 4001/4002/4003)
- I9 → `packages/infra/test/auth-user-store.test.js` (changePassword refreshSessions 초기화)
- I10 → `packages/infra/test/auth-provider.test.js` (rate limit 검증)
- I11 → `packages/infra/test/auth-middleware.test.js` (toPrincipal)
- E1 → `packages/server/src/server/index.js` CLI 분기 (hasUsers 체크 — 자동화 테스트 없음) ⚠️
- E4 → `packages/infra/test/auth-middleware.test.js` (탈취 감지 시나리오)
- E6 → `packages/server/test/server.test.js` (WS origin 체크)

## 관련 코드

- `packages/infra/src/infra/auth/policy.js` — AUTH 상수, AUTH_ERROR, AuthError, toPrincipal
- `packages/infra/src/infra/auth/user-store.js` — 유저 CRUD, refreshSessions 관리 (`~/.presence/users.json`)
- `packages/infra/src/infra/auth/token.js` — JWT 발급/검증 (node:crypto HMAC-SHA256)
- `packages/infra/src/infra/auth/service.js` — AuthService 기반 클래스
- `packages/infra/src/infra/auth/http-service.js` — HTTP 인증 (rate limiter, mustChangePassword allowlist)
- `packages/infra/src/infra/auth/ws-service.js` — WebSocket 인증
- `packages/server/src/server/auth-setup.js` — Express 라우터/미들웨어 조립
- `packages/server/src/server/ws-handler.js` — WS 연결 인증 + close 코드 매핑

## 변경 이력

- 2026-04-10: 초기 작성
- 2026-04-10: I8 WS close 코드 순서 정정 (4001=AUTH_FAILED, 4002=PASSWORD_CHANGE_REQUIRED, 4003=ORIGIN_NOT_ALLOWED). close 코드 단일 정의는 server-ws.md에 위임
- 2026-04-10: E6 `config.host` → `opts.host` 정정. Config 스키마에 host 항목 없음을 명시.
- 2026-04-10: I2 public paths 목록에 `/api/instance` 추가 — auth-setup.js:28 publicPaths 실제 값과 일치.
- 2026-04-10: I3 allowlist 경로 표기 정정 — req.path 기준(`/auth/...`)과 외부 URL 기준(`/api/auth/...`)의 관계, MUST_CHANGE_PASSWORD_ALLOWLIST 상수 위치 명시.
- 2026-04-10: I8 WS 인증 경로 3단계 폴백 전체 기술 — Authorization 헤더(access), query param `?token=`(access), Cookie refreshToken(refresh) 순서와 부재/실패 구분 명시.
- 2026-04-10: E7 Origin 체크 조건 정정 — 쿠키 유무는 트리거 조건 아님. `authEnabled && !authorization && !checkOrigin` 조건 코드 기준으로 정정.
- 2026-04-10: I1 CLI 커맨드 목록 보충 — passwd(비밀번호 재설정), list(유저 목록) 추가. 각 커맨드 역할 명시.
- 2026-04-10: I5 두 번째 거부 경로 추가 — tokenVersion 불일치(TOKEN_INVALIDATED) 경로와 각각의 AUTH_ERROR 코드 명시. E4b 추가 (TOKEN_INVALIDATED 경계 조건).
- 2026-04-10: I10 정정 — rate limit이 실패한 로그인만 카운트함을 명시. RATE_LIMIT_MAX_ATTEMPTS(5), RATE_LIMIT_WINDOW_MS(60,000ms) 상수 이름/값 추가.
- 2026-04-10: E1 확장 — hasUsers 이중 방어 경로 명시. CLI 진입점(index.js:304, process.exit) + 프로그램적 진입점(auth-setup.js:24, throw). 독립 테스트 없음 명시.
- 2026-04-10: I11 확장 — mustChangePassword 기본값 false의 의도 명시. user-store.js/toPrincipal/service.js 세 곳 일관 적용 및 레거시 호환 설계임 명시.
- 2026-04-10: I2에 authEnabled 하드코딩 명시 — PresenceServer.#boot()에서 true 고정, 운영 override 불가. E10 추가 — /api/auth/status 멀티유저 한계 명시.
- 2026-04-10: I8 WS close 코드 단일 진원 정정 — server/constants.js가 아닌 core/policies.js의 WS_CLOSE가 진원, constants.js는 re-export만.
