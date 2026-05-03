# [FP-82] cedar-policy-guide / admin-policy-management 정책 파일 경로 회귀 — `~/.presence/cedar/policies/` 안내 vs 코드는 패키지 in-source 만 읽음

**영역**: ux (guide)
**심각도**: high
**상태**: resolved
**관련 코드**: `packages/infra/src/infra/authz/cedar/paths.js`, `packages/infra/src/infra/authz/cedar/boot.js`
**관련 ticket**: FP-78 (가이드 ship — 본 회귀의 원인)

## 시나리오

FP-78 (Cedar 정책 작성 가이드 부재) 해소 작업으로 2026-05-03 ship 한 두 가이드 (`docs/guide/ko/cedar-policy-guide.md`, `docs/guide/ko/admin-policy-management.md`) 가 정책 파일 위치를 `~/.presence/cedar/policies/` (사용자 홈 디렉토리) 라고 안내함.

운영자가 가이드대로 따라하면:
1. `~/.presence/cedar/policies/50-block-user.cedar` 파일 생성
2. `npm run user -- policy lint --file ~/.presence/cedar/policies/50-block-user.cedar` → OK 응답
3. `npm run user -- policy reload` → 성공 응답
4. 그러나 정책은 적용 안 됨

원인: 코드 (`packages/infra/src/infra/authz/cedar/paths.js:10`) 는 `POLICIES_DIR = packages/infra/src/infra/authz/cedar/policies/` (패키지 in-source 디렉토리) 만 읽음. boot/reboot 모두 이 디렉토리만 스캔. 사용자 홈 디렉토리 (`~/.presence/cedar/policies/`) 는 절대 읽지 않음.

스펙 (`docs/design/cedar-infra.md §1.2`) 도 명시적으로:
> `packages/infra/src/infra/authz/cedar/policies/` 에 정적 배포. 빌드 시 패키지에 포함. `~/.presence/cedar/` 같은 사용자 경로는 X' 에서. minimal 에선 정책 변경 = 코드 PR.

가이드가 스펙과 코드 모두를 거스르고 있었음.

## 영향

- production: 가이드 따라간 운영자의 정책 추가 시도가 모두 침묵 실패 (lint OK / reload OK 인데 동작 안 함)
- 디버깅 비용: 운영자 입장에서 reload 가 성공했는데 적용 안 되는 것을 추적하려면 코드까지 들어가야 함
- 신뢰도: 가이드를 production-ready 로 ship 한 직후 회귀 — guide writer 의 코드/스펙 cross-check 부재

## 발견 경로

KG-30 (Hot reload 디스크 자동 롤백 부재) 작업 중 정책 lint --all 구현하려고 `POLICIES_DIR` / `bootCedar` 추적하다가 가이드와 모순 발견.

## 해소 (2026-05-03)

같은 작업 사이클 (`feature/kg-30-policy-lint-all` 브랜치, Cedar 거버넌스 종결 사이클) 에서 즉시 정정. user-guide-writer 가 두 가이드 갱신:

- 정책 파일 위치 `packages/infra/src/infra/authz/cedar/policies/` 로 정정 (모든 명령 예시 / 파일 경로 / 출력 예시 포함)
- 전제 조건 박스 추가 — "단일 머신 / 단일 admin / git commit 권장 / 정책 변경 = 코드 변경" 가정 명시
- 운영 환경 풀 경로 예시 추가 (`/srv/presence/packages/...`)
- "왜 홈 디렉토리는 안 되는지" 설명 추가 (코드가 in-source 만 읽음 + 스펙 §1.2 인용)
- cedar-policy-guide.md §9 문제 해결에 "혹시 `~/.presence/cedar/`에 만든 것 아닌가?" 자주 묻는 질문 추가
- 두 파일 합쳐 약 +40줄 순증, 핵심 구조 (9 섹션 / 4 예시) 유지

## 회귀 방지

본 phase 범위 밖이지만 후속에서 검토:
- guide writer agent 가 코드/스펙 cross-check 단계 의무화 (현재는 ticket / 사용자 코드 입력만 검토)
- 또는 가이드의 path / 명령 예시에 대해 정적 검증 (`grep -r '~/.presence/cedar' docs/guide/` → CI 실패) 도입

## 근거

ship 직후 회귀 감지 cycle 자체가 의미있는 데이터 — guide writer 결과물의 production 전 cross-check 필요성을 보여줌.
