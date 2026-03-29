---
description: 테스트 작성 규칙
globs:
  - "test/**/*.js"
  - "packages/web/e2e/**/*.js"
---

# 테스트 규칙

## 필수 원칙

- 실패 시나리오 우선 설계. 성공만 전제하는 테스트 금지
- 테스트 작성 후 반드시 직접 실행하고 통과 확인까지 완료. 작성만 하고 끝내는 패턴 금지
- mock 테스트 통과에 안주하지 않기 — live 환경에서의 통합 동작을 항상 고려

## 횡단 관심사 검증

- 인증 변경 시: mock E2E + live E2E 모두 검증
- 쿠키/토큰 변경 시: WS 연결, API 요청, 브라우저 모든 경로 검증
- 상태 초기화 변경 시: 렌더링 순서, 비동기 타이밍 검증

## 브릿지 동치 테스트

Reader 전환된 모듈은 레거시 브릿지 동치 테스트 필수:
```javascript
assert.deepStrictEqual(createX(mockDeps), xR.run(mockDeps))
```

## 라이브 테스트

- 인증 필요 서버: --username/--password 또는 loginIfRequired 헬퍼 사용
- refresh token rotation 주의: storageState 대신 공유 context 사용
- 이전 테스트 잔여 상태: /clear로 초기화 후 진행
