# [FP-74] GET /api/admin/policy/version 에 대응하는 CLI wrapper 없음

**영역**: infra (admin CLI)
**심각도**: medium
**상태**: resolved
**관련 코드**: `packages/server/src/server/admin-router.js:90-93`, `packages/infra/src/infra/auth/cli-policy.js`

## 시나리오

**변경 적용 확인 흐름**: 운영자가 reload 를 실행한 후 "현재 어떤 버전의 정책이 활성화되어 있는가?"를 확인하고 싶다. reload 성공 메시지에서 version 을 봤지만, 나중에 다시 확인하거나 다른 터미널에서 확인하려면 별도 조회가 필요하다.

**실패 회복 흐름**: 잘못된 정책으로 reload 실패 후, 현재 활성 버전이 무엇인지 독립적으로 확인하고 싶다.

현재 운영자가 할 수 있는 것:
```bash
curl -H "Authorization: Bearer $PRESENCE_ADMIN_TOKEN" \
     http://localhost:3000/api/admin/policy/version
```
→ `{"version":3,"reloadedAt":"..."}` (raw JSON)

## 현재 동작

`GET /api/admin/policy/version` 엔드포인트는 존재하지만, `dispatchPolicy` 에 `version` 액션이 없다. `policy` 서브커맨드 핸들러의 default 분기가 다음을 출력한다:

```
Unknown policy action: version
Actions: lint, list, reload
```

usage 출력에도 `policy version` 이 표시되지 않는다.

## 마찰 포인트

| 포인트 | 설명 |
|--------|------|
| REST ↔ CLI 비대칭 | reload 와 version 은 REST API 에 함께 있지만 CLI 에는 reload 만 있다. 운영자가 직접 curl 을 사용해야 한다 |
| 확인 경로 부재 | reload 성공 후 "정말 적용됐는가?" 를 CLI 로 재확인할 방법이 없다. reload 출력을 스크롤 위로 올려봐야 한다 |
| JSON 노출 | curl 직접 호출 시 raw JSON 이 표시된다 — 필드명 `version`, `reloadedAt` 는 운영자 언어가 아니다 |

## 제안

### 즉시 적용 가능

`dispatchPolicy` 에 `version` 액션 추가:

```javascript
case 'version': return cmdPolicyVersion()
```

`cmdPolicyVersion` 출력 예시:
```
현재 활성 정책: 버전 3 (적용: 2026-04-29 10:00:00)
```

usage 에도 추가:
```
npm run user -- policy version   (현재 활성 정책 버전 확인)
```

이 명령도 `PRESENCE_ADMIN_TOKEN` 이 필요하다.

## 근거

변경 적용 확인은 reload 흐름의 마지막 단계다. reload → version 확인 은 자연스러운 쌍이며, REST API 에 이미 엔드포인트가 존재한다. CLI wrapper 부재는 운영자를 curl + jq 조합으로 강제하는 두 번째 진입 장벽이다.

## 해소 (2026-04-29)

`cmdPolicyVersion` 함수 추가 및 `dispatchPolicy` 에 `version` 분기 연결.

- `GET /api/admin/policy/version` 호출 wrapper 구현.
- 운영자 친화 출력: "현재 활성 정책: 버전 N (적용: YYYY-MM-DD HH:MM:SS)".
- usage 에 `policy version` 항목 노출 (FP-72 해소와 함께 적용).

회귀 커버리지: CLI-X7 (token 부재), CLI-X8 (서버 미가동), INV-CEDAR-CLI-VERSION (정적 검증).
