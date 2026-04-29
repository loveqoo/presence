# [FP-72] usage 출력에 "policy reload 미지원" 문구가 KG-28 P5 구현 후에도 잔존

**영역**: infra (admin CLI)
**심각도**: high
**상태**: resolved
**관련 코드**: `packages/infra/src/infra/auth/cli.js:206`

## 시나리오

신규 admin 이 hot reload 기능이 있다는 것을 알지 못하는 상태에서, `npm run user` (인자 없음) 를 실행하여 사용법을 확인한다.

출력:
```
Cedar policy:
  npm run user -- policy lint --file <path.cedar>
  npm run user -- policy list
  npm run user -- policy reload  (미지원 — 서버 재시작 필요)
```

## 현재 동작

`cli.js` 207번째 줄의 usage 문자열이 KG-28 P5 구현 이전 상태를 그대로 유지하고 있다. `cmdPolicyReload` 는 이미 완전히 구현되어 작동하지만, usage 에는 "(미지원 — 서버 재시작 필요)"가 출력된다.

## 마찰 포인트

| 포인트 | 설명 |
|--------|------|
| 기능 접근 불가 | admin 이 기능 목록을 보고 "reload 는 지원 안 되는구나"라고 판단하여 시도조차 하지 않는다 |
| 신뢰 손상 | 실제로 실행하면 작동하는 명령이 usage 에서 "미지원"이라고 표시된다 — 도구를 신뢰하기 어렵게 만든다 |
| 발견 가능성 0 | 시나리오 5번 (신규 admin 이 hot reload 가능하다는 것을 어떻게 발견하는가?) 에 대한 답이 없다. usage 가 유일한 발견 경로인데 그 경로가 막혀 있다 |

## 제안

### 즉시 적용 가능

usage 문자열을 실제 구현 상태에 맞게 수정한다:

```
Cedar policy:
  npm run user -- policy lint --file <path.cedar>
  npm run user -- policy list
  npm run user -- policy reload                      (서버 재시작 없이 정책 즉시 적용)
  npm run user -- policy version                     (현재 활성 정책 버전 확인)
```

추가 설명이 필요하다면:
```
  policy reload: PRESENCE_ADMIN_TOKEN env 필수. npm run user -- policy reload --help 로 안내 확인.
```

`policy version` 은 GET /api/admin/policy/version 에 대응하는 CLI wrapper 가 없는 상태이므로 usage 에 노출 전 wrapper 추가 여부를 결정해야 한다 (별도 마찰점 참고).

## 근거

usage 는 admin 이 기능을 발견하는 1차 경로다. KG-28 P5 구현 이후에도 usage 가 갱신되지 않아, hot reload 기능은 "알고 있는 사람만 쓸 수 있는" 숨겨진 기능이 되었다. 코드 변경 후 usage 문자열 동기화가 누락된 것으로, 기능 자체가 아니라 발견 경로가 막힌 마찰점이다.

## 해소 (2026-04-29)

`cli.js` usage 문자열 갱신.

- `policy reload` 항목에서 "(미지원 — 서버 재시작 필요)" 문구 제거, "(서버 재시작 없이 정책 즉시 적용)"으로 교체.
- `policy version` 항목 신규 추가 (현재 활성 정책 버전 확인).
- PRESENCE_ADMIN_TOKEN env 필수 안내 한 줄 추가.

회귀 커버리지: CLI-X9 (`cedar-policy-cli.test.js`).
