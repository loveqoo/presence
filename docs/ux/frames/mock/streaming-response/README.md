# streaming-response

에이전트 응답 스트리밍 경험을 검증한다. FP-29(입력 비활성 상태 이유 미표시), FP-30("receiving N chars..." 내부 용어 노출)을 재현한다.

**결과**: 7/7 단계 통과

| # | 단계 | 상태 | 오류 |
|---|------|------|------|
| 1 | 초기 idle 화면 | ok |  |
| 2 | working 전이 — thinking 표시 | ok |  |
| 3 | 스트리밍 시작 — content 도착 전 receiving 단계 | ok |  |
| 4 | 스트리밍 중 — "receiving N chars..." 내부 용어 노출 재현 | ok |  |
| 5 | 스트리밍 content 도착 — 마크다운 렌더로 전환 | ok |  |
| 6 | 턴 완료 — success + idle 복귀 | ok |  |
| 7 | 완료 후 프레임 — 응답이 ChatArea에 남아있는가 | ok |  |

각 단계의 프레임은 같은 디렉토리의 `NN-*.txt` 파일에 저장되어 있습니다.
