# [FP-79] TUI 에서 정책 버전 확인 단일 경로 부재 — CLI/REST 별도 호출 필요

**영역**: tui
**심각도**: low
**상태**: resolved
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

## 해소 (2026-05-03)

**해소 방식**: TUI 슬래시 커맨드 `/policy version` 신규 추가 (옵션 A — MVP)

**동작**:
- 입력 시 RemoteSession 이 GET `/api/admin/policy/version` 호출
- 200 → `정책 버전: N (적용: YYYY-MM-DD HH:MM:SS)` 표시
- 403 → "이 명령은 관리자 전용입니다." 안내
- 네트워크 오류 → 원본 메시지 노출
- `reloadedAt` 이 null 이면 "초기 부팅 후 reload 없음" fallback 표시

**변경/신규 파일**:
- 신규: `packages/tui/src/ui/slash-commands/policy.js` (`handlePolicy` 핸들러)
- 변경: `packages/tui/src/ui/slash-commands.js` (`commandMap` 등록)
- 변경: `packages/tui/src/ui/App.js` (`onPolicyVersion` prop 추가)
- 변경: `packages/tui/src/remote-session.js` (closure 주입)
- 변경: `packages/tui/src/ui/hooks/useSlashCommands.js` (docstring 갱신)

**i18n**:
- ko/en `policy_cmd` namespace 신설
- 6 키 (version / never_reloaded / usage / admin_only / unexpected_response / not_available) × 2 locale = 12 키
- `help.commands` 에 `/policy version` 라인 추가
- KO/EN parity 232 = 232

**테스트**: `app.test.js` 81d ~ 81l — 9 케이스 23 단언
- help 노출 / 200 admin / 403 / null reloadedAt / 단독 모드 / usage / 네트워크 오류 / 비정상 응답 / dispatch 통합

**후속 phase 후보 (본 phase 범위 밖)**:
- 옵션 B: StatusBar 에 `정책: vN` 세그먼트 상시 표시
- 옵션 C: 서버 reload 시 WS broadcast → TUI 실시간 갱신
- 본 MVP 는 명시적 사용자 호출 시에만 버전 정보를 노출함

**작업 브랜치**: `feature/fp-79-tui-policy-version`
