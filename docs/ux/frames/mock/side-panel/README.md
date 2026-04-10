# side-panel

SidePanel을 열어 Agents/Tools/Memory/TODOs/Events 5개 섹션의 가시성을 검증한다. FP-06(deadLetter 미표시), FP-07(TODO 상태 없음), FP-11(도구 목록 잘림)을 재현한다.

**결과**: 4/6 단계 통과

| # | 단계 | 상태 | 오류 |
|---|------|------|------|
| 1 | 초기 화면 — 패널 닫힘 | ok |  |
| 2 | /panel 로 사이드 패널 열기 | ok |  |
| 3 | 패널 펼침 — 모든 섹션이 보이는가 | ok |  |
| 4 | 도구 12개 중 잘림 표시 — FP-11 | ok |  |
| 5 | TODO 상태 표시 — FP-07 | assertion-failed | assertion failed at "TODO 상태 표시 — FP-07" |
| 6 | deadLetter 노출 — FP-06 | assertion-failed | assertion failed at "deadLetter 노출 — FP-06" |

각 단계의 프레임은 같은 디렉토리의 `NN-*.txt` 파일에 저장되어 있습니다.
