---
description: 인증 + 웹 클라이언트 횡단 관심사
globs:
  - "packages/infra/src/infra/auth-*.js"
  - "packages/server/src/server/**/*.js"
  - "packages/web/src/**/*.js"
  - "packages/web/src/hooks/**/*.js"
---

# 인증 + 웹 횡단 관심사 규칙

## 쿠키

- refresh token 쿠키 Path는 `/` (WS 포함 모든 경로에서 전달)
- HttpOnly + SameSite=Strict + Secure(production)
- 쿠키 속성 변경 시 반드시 확인: API, WS, 브라우저 모든 경로에서 동작하는가?

## 상태 초기화 순서

- authRequired 설정은 refresh 시도 완료 후 — LoginPage 깜빡임 방지
- usePresence WS 연결은 `authRequired === false || isAuthenticated` 일 때만
- 비동기 상태 변경(setAuthRequired, setAccessToken)의 렌더링 영향을 항상 고려

## refresh token rotation

- refresh 1회 → 이전 jti 폐기 + 새 jti 발급
- 폐기된 jti 재사용 시 → theft detection → 모든 session 삭제
- 테스트에서 여러 context가 같은 refresh token을 사용하면 충돌 — 공유 context 사용

## WS 인증

- 브라우저: HttpOnly 쿠키 자동 전송 (same-origin)
- TUI: Authorization 헤더 (ws 라이브러리)
- Origin 검사: 브라우저 WS에서 CSRF 방지
