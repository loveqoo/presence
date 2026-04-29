# [FP-77] policy reload 권한 오류 메시지가 조치 방법을 안내하지 않음

**영역**: infra (admin CLI), server
**심각도**: low
**상태**: resolved
**관련 코드**: `packages/infra/src/infra/auth/cli-policy.js:74-77`, `packages/server/src/server/admin-router.js:18-25`

## 시나리오

비-admin 사용자(또는 admin 이 아닌 계정의 token 을 실수로 설정한 admin)가 policy reload 를 실행한다.

현재 출력:
```
policy reload: 권한 없음 (HTTP 403). admin role 토큰 사용 확인.
```

서버 응답 body:
```json
{ "error": "admin only" }
```

## 현재 동작

`cmdPolicyReload` 는 401/403 을 한 번에 처리하며 "admin role 토큰 사용 확인" 문구를 출력한다. 401(인증 없음)과 403(인증은 됐지만 권한 없음)을 구분하지 않는다.

## 마찰 포인트

| 포인트 | 설명 |
|--------|------|
| 401/403 미구분 | 401은 "token 자체가 잘못됐다"이고 403은 "token은 유효하지만 admin 이 아니다"다. 두 상황의 해결 방법이 다른데 같은 메시지를 출력한다 |
| "admin only" 원문 | 서버가 `{ "error": "admin only" }` 를 내려보낸다. CLI 가 이를 그대로 출력하지 않고 번역하고 있는 것은 맞지만, 대응 안내가 충분하지 않다 |
| 조치 방법 없음 | "admin role 토큰 사용 확인"은 문제의 재서술이지 해결 방법이 아니다. admin 토큰 취득 방법을 안내하지 않는다 |

## 제안

### 즉시 적용 가능 — 401/403 분리 + 조치 안내

```javascript
if (response.status === 401) {
  console.error('policy reload: 인증이 필요합니다.')
  console.error('  PRESENCE_ADMIN_TOKEN 이 올바른지 확인하거나 재로그인 후 token 을 갱신하세요.')
  process.exit(1)
}
if (response.status === 403) {
  console.error('policy reload: admin 권한이 필요합니다.')
  console.error('  현재 token 의 계정이 admin role 을 보유하고 있는지 확인하세요.')
  console.error('  다른 계정으로 로그인하거나 admin 계정 token 을 사용하세요.')
  process.exit(1)
}
```

## 근거

심각도가 low 인 이유: 현재 메시지도 최소한의 안내("admin role 토큰")를 제공한다. 그러나 첫 번째로 reload 를 시도하는 admin 이 실수로 일반 계정 token 을 사용했을 때, 출력만으로 즉시 조치를 취하기가 어렵다. 401/403 구분과 짧은 조치 안내 추가는 변경 비용이 매우 낮고 효과는 명확하다.

## 해소 (2026-04-29)

`handleAuthError` 함수에 401/403 별도 분기 추가.

- 401: "인증이 필요합니다" + PRESENCE_ADMIN_TOKEN 갱신 안내.
- 403: "admin 권한이 필요합니다" + admin role 보유 확인 + 다른 계정/admin token 사용 안내.

회귀 커버리지: AR8 (`admin-router.test.js` 서버측 401/403 응답), INV-CEDAR-CLI-AUTH-SPLIT (정적 grep — 분기 + 메시지 + PRESENCE_ADMIN_TOKEN).
