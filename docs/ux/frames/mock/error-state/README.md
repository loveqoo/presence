# error-state

에이전트가 에러 상태에 들어갔을 때 유저가 원인을 파악할 수 있는 경로를 검증한다. FP-01(StatusBar의 ✗ error만으로 원인 불명), FP-08(/status 출력의 내부 필드명 노출)을 재현한다.

**결과**: 5/6 단계 통과

| # | 단계 | 상태 | 오류 |
|---|------|------|------|
| 1 | 초기 idle 화면 | ok |  |
| 2 | working 진입 | ok |  |
| 3 | 에이전트 턴 실패 — planner_parse 에러 | ok |  |
| 4 | StatusBar 에러 프레임 — 원인이 표시되는가? — FP-01 | ok |  |
| 5 | /status 커맨드로 에러 조회 | ok |  |
| 6 | /status 출력 — 내부 필드명 노출 여부 — FP-08 | assertion-failed | assertion failed at "/status 출력 — 내부 필드명 노출 여부 — FP-08" |

각 단계의 프레임은 같은 디렉토리의 `NN-*.txt` 파일에 저장되어 있습니다.
