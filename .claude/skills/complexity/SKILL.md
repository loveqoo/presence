---
name: complexity
description: ESLint 기반 코드 복잡도/품질 검사 및 리팩토링 우선순위 결정
---

# 복잡도 분석

`eslint.config.js` 의 임계치 기반으로 ESLint 가 측정한다 (built-in 규칙 + sonarjs).

## 실행

```bash
# 전체 리포트
npm run lint

# 임계치 초과만 (warning 0 허용 안 함, exit code 사용)
npm run lint:check

# 특정 파일/디렉토리
npx eslint $ARGUMENTS
```

## 측정 지표

| 지표 | 규칙 | 임계치 |
|------|------|--------|
| LOC | `max-lines` (skipBlankLines, skipComments) | 300 |
| Params | `max-params` | 5 |
| Depth | `max-depth` | 6 |
| CC | `complexity` (Cyclomatic Complexity) | 70 |
| Cognitive | `sonarjs/cognitive-complexity` | 50 |

ESLint 의 cyclomatic 측정은 함수 진입 + 분기 + 논리 연산자 등 자체 도구보다 포괄적이라
임계치를 50 → 70 으로 조정 (이전 자체 도구 호환). cognitive complexity 는 SonarSource
표준 — 인지적 복잡도 (중첩, 흐름 단절 가중).

## 출력 해석

각 위반은 ESLint 형식으로 출력 — 파일, 라인, 위반 규칙, 권고치. exit code 0 이 통과,
1+ 가 위반.

```
packages/.../foo.js
  18:21  error  Arrow function has a complexity of 75. Maximum allowed is 70  complexity
```

## 결과 보고

1. 임계치 초과 파일 수
2. 각 위반의 파일/위치/규칙/측정값
3. 자체 도구 시절의 Score 가중합은 제거됨 — ESLint 위반 자체로 판정

## 자체 도구 폐기 (2026-04-25)

이전 `scripts/complexity.js` 는 method 이중 카운트 버그 등 자체 AST 분석 한계로 폐기.
ESLint 가 산업 표준 + 활발 유지보수. SonarJS 가 cognitive complexity 같은 현대적 메트릭
제공. 임계치 조정은 `eslint.config.js` 에서.
