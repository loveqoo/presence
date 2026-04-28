# [FP-76] policy reload 성공 출력의 reloadStartedAt 비교 안내가 직관적이지 않음

**영역**: infra (admin CLI)
**심각도**: medium
**상태**: open
**관련 코드**: `packages/infra/src/infra/auth/cli-policy.js:80-83`

## 시나리오

운영자 A 가 reload 를 호출한다. 거의 동시에 운영자 B 도 reload 를 호출한다. B 의 reload 는 A 가 시작한 것과 같은 reload 작업에 합류(edge-trigger)하여 같은 `reloadStartedAt` 을 받는다. B 는 "내 reload 가 실제로 실행되었는가?"를 알고 싶다.

현재 성공 출력:
```
OK: 정책 reload 성공. version=3
     reloadStartedAt=2026-04-29T10:00:00.000Z reloadedAt=2026-04-29T10:00:00.123Z
Tip: 자기 reload 가 새로 시작됐는지 확인하려면 명시적 두 번째 호출 후 reloadStartedAt 변화 관찰.
```

## 현재 동작

`cmdPolicyReload` 는 성공 시 `version`, `reloadStartedAt`, `reloadedAt` 세 필드를 출력한다. edge-trigger 케이스(concurrent reload 시 같은 reloadStartedAt 반환)를 Tip 으로 설명하고 있으나, Tip 문구가 모호하다.

## 마찰 포인트

| 포인트 | 설명 |
|--------|------|
| Tip 이해 어려움 | "자기 reload 가 새로 시작됐는지 확인하려면 명시적 두 번째 호출 후 reloadStartedAt 변화 관찰" — 이 문장을 처음 보는 admin 이 즉시 이해하기 어렵다 |
| 기대값 부재 | "reloadStartedAt 이 달라야 한다"는 것과 "같으면 concurrent 합류였다"는 것을 명시적으로 설명하지 않는다 |
| 필드명 과다 | `reloadStartedAt` / `reloadedAt` 두 타임스탬프가 한 줄에 나열되는데, 운영자 관점에서 이 둘의 차이가 즉시 명확하지 않다 |
| "자기 reload" 개념 미설명 | single-flight 동작 방식(동시 호출 시 한 번만 실행)이 출력에서 전제되지만, 이 동작 자체가 설명되지 않는다 |

## 제안

### 즉시 적용 가능 — 출력 메시지 명확화

version 과 타임스탬프를 분리하여 의미를 설명하고, single-flight 동작을 명시한다:

```
OK: 정책이 적용되었습니다.
  버전: 3
  reload 시작: 2026-04-29T10:00:00.000Z
  적용 완료:  2026-04-29T10:00:00.123Z

참고: 짧은 시간 내 여러 admin이 동시에 reload를 요청하면 한 번만 실행됩니다.
      "reload 시작" 시각이 이전 호출과 같으면 기존 reload 에 합류된 것입니다.
      새 reload 를 강제하려면 잠시 후 다시 실행하세요.
```

### Tip 위치 — 성공 시에만 표시

Tip 은 현재 항상 출력된다. 실패(500) 경로에서는 Tip 이 아니라 복구 방법이 더 유용하다. 성공 경로에서만 single-flight 안내를 표시하는 것이 적절하다.

## 근거

"자기 reload 가 새로 시작됐는지 확인하려면 명시적 두 번째 호출 후 reloadStartedAt 변화 관찰" 은 single-flight 개념을 아는 사람에게는 명확하지만, 운영자는 이 내부 구현 세부 사항을 알 필요가 없다. 출력 메시지가 운영자의 행동(재시도 여부 판단)을 직접 안내해야 한다.
