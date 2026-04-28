# [FP-78] Cedar 정책 작성 가이드 부재 — 운영자가 50-*.cedar 문법/예시 없이 lint/reload 사용 불가

**영역**: infra (admin CLI), guide
**심각도**: medium
**상태**: open
**관련 코드**: `packages/infra/src/infra/auth/cli-policy.js`

## 시나리오

운영자가 `npm run user -- policy lint --file <path>` 와 `npm run user -- policy reload` 를 사용 가능하다는 것을 알았다. 그런데 실제로 50-*.cedar 파일을 어떻게 작성하는지 알 수 없다.

- Cedar 정책 문법이 무엇인지
- presence schema 의 entity(User, Session 등), action, context 가 어떻게 매핑되는지
- block-user / restrict-archive / quota-override 같은 대표 패턴 예시가 어디 있는지

가이드가 없어 lint/reload 기능을 알고 있어도 실제로 활용하지 못한다.

## 현재 동작

`docs/guide/ko/admin-policy-management.md` 에 lint/reload 사용법은 기술되어 있으나, Cedar 정책 파일 자체를 어떻게 작성하는지에 대한 설명이 없다. CLI usage 출력에도 파일 작성 방법에 대한 안내가 없다.

## 마찰 포인트

| 포인트 | 설명 |
|--------|------|
| 기능 진입 전 단계 차단 | lint/reload 를 사용하려면 먼저 .cedar 파일이 있어야 한다. 파일 작성법을 모르면 두 명령 모두 사용 불가 |
| 문법 학습 외부 의존 | 운영자가 Cedar 공식 문서를 직접 찾아야 한다. presence schema 와의 매핑은 공식 문서에 없다 |
| 예시 부재 | "block-user 정책을 만들어 보려면 어디서 시작하는가?"에 대한 답이 프로젝트 내 어디에도 없다 |

## 제안

`docs/guide/ko/admin-policy-management.md` 또는 별도 `docs/guide/ko/cedar-policy-guide.md` 에 다음을 추가한다:

1. Cedar 정책 문법 입문 (permit/forbid, when, unless 기본 구조)
2. presence schema 의 entity/action/context 매핑표 (User, Session, action 목록, context 필드)
3. 50-*.cedar 예시 파일 4~5개:
   - block-user.cedar — 특정 사용자 차단
   - restrict-archive.cedar — 아카이브 기능 제한
   - quota-override.cedar — 특정 사용자 쿼터 초과 허용
   - admin-only-action.cedar — admin 전용 액션 제한

후속 phase 에서 구현 가능. CLI 에서 `policy lint --help` 실행 시 가이드 문서 경로를 안내하는 한 줄 추가도 즉시 적용 가능하다.

## 근거

lint/reload 기능은 운영자가 정책 파일을 직접 작성할 수 있다는 전제 위에 있다. 그 전제가 충족되지 않으면 두 명령 모두 진입 불가 상태가 된다. 가이드 부재는 기능 발견 이후 두 번째 장벽이며, 이 장벽이 있는 한 hot reload 기능의 실제 활용률은 매우 낮을 것이다.
