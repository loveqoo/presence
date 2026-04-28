# [FP-79] TUI 에서 정책 버전 확인 단일 경로 부재 — CLI/REST 별도 호출 필요

**영역**: tui
**심각도**: low
**상태**: open
**관련 코드**: `packages/tui/src/ui/`, `packages/server/src/server/admin-router.js:90-93`

## 시나리오

운영자가 `policy reload` 를 실행한 후 변경이 실제로 적용되었는지 TUI 화면에서 확인하고 싶다. 또는 나중에 "현재 어떤 버전의 정책이 활성화되어 있는가?"를 TUI 를 보면서 파악하고 싶다.

현재 가능한 방법:
- `npm run user -- policy reload` 응답의 version 필드를 스크롤해서 확인
- 별도 터미널에서 `curl -H "Authorization: Bearer $PRESENCE_ADMIN_TOKEN" http://localhost:3000/api/admin/policy/version` 직접 호출
- (FP-74 구현 후) `npm run user -- policy version` 별도 실행

TUI 화면을 보는 것만으로는 현재 활성 정책 버전을 알 수 없다.

## 현재 동작

TUI StatusBar 또는 admin 관련 화면에 정책 버전 정보가 표시되지 않는다. reload 이벤트가 발생해도 TUI 에 반영되지 않는다.

## 마찰 포인트

| 포인트 | 설명 |
|--------|------|
| 상태 가시성 부재 | TUI 를 보면서 서버 상태를 운영하는 흐름에서, 정책 버전은 보이지 않는 상태다 |
| 별도 도구 필요 | TUI 외부에서 CLI 또는 curl 을 별도로 실행해야만 확인 가능 |
| reload 결과 확인 불가 | TUI 에서 reload 를 간접적으로 지시하거나 이벤트를 받더라도 결과를 화면에서 확인할 수 없다 |

## 제안

### 후속 phase — TUI 정책 버전 표시

TUI StatusBar 또는 `/admin status` 슬래시 명령에 현재 활성 정책 버전을 표시한다.

예시 (StatusBar):
```
[사용자: admin] [세션: 3개 활성] [정책: v3]
```

예시 (`/admin status` 명령 출력):
```
서버 상태
  활성 세션: 3
  정책 버전: 3 (적용: 2026-04-29 10:00:00)
```

WS 이벤트로 reload 발생 시 자동 갱신하면 운영자가 별도 확인 없이 적용 여부를 TUI 에서 실시간으로 파악할 수 있다.

## 근거

심각도가 low 인 이유: FP-74 (`policy version` CLI wrapper) 가 해소되면 CLI 에서 확인 경로가 생긴다. TUI 표시는 그 이후 단계의 개선이다. 그러나 TUI 가 운영자의 주 화면이라면, 정책 버전이 보이지 않는 것은 상태 가시성 원칙에서 벗어난다. 후속 phase 에서 WS 이벤트 구조가 확장될 때 함께 구현하면 비용이 낮다.
