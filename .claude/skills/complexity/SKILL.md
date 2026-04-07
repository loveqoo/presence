---
name: complexity
description: AST 기반 코드 복잡도 분석 및 리팩토링 우선순위 결정
---

# 복잡도 분석

`scripts/complexity.js`를 실행하여 코드 복잡도를 측정한다.

## 실행

인자가 없으면 전체 리포트를 실행하고, 인자가 있으면 그대로 전달한다.

```bash
node scripts/complexity.js $ARGUMENTS
```

## 측정 지표

| 지표 | 설명 | 임계치 |
|------|------|--------|
| LOC | 빈 줄/주석 제외 코드 라인 | 300 |
| Fn | 함수/메서드 수 | 25 |
| Params | 최대 파라미터 수 (destructuring 포함) | 5 |
| Depth | 최대 중첩 깊이 (AST 기반) | 6 |
| CC | Cyclomatic Complexity (분기 + 논리연산자) | 50 |
| Imports | import 문 수 | 15 |
| Score | 가중합 (LOC*0.5 + Fn*1 + Params*3 + Depth*5 + CC*2 + Imports*0.5) | - |

## 출력 해석

결과 테이블은 Score 내림차순으로 정렬된다. Score가 높을수록 리팩토링 우선순위가 높다.

- Score 200 이상: 즉시 리팩토링 대상
- Score 150~200: 주의 관찰
- Score 150 미만: 양호

## 결과 보고

실행 결과를 바탕으로 다음을 간결하게 보고한다:

1. 전체 파일 수와 임계치 초과 파일 수
2. Score 상위 10개 파일 테이블
3. 임계치 초과 항목이 있는 파일별 구체적 위반 내용
