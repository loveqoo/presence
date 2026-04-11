# approve-prompt

승인 프롬프트의 위험도 구분(FP-03)과 거부 피드백(FP-02)을 검증한다. 낮은 위험(file_read)은 일반 레이블, 높은 위험(shell_exec rm -rf)은 HIGH RISK 레이블을 사용해야 하고, 거부 후 ChatArea에 "거부됨" 기록이 남아야 한다.

**결과**: 5/5 단계 통과

| # | 단계 | 상태 | 오류 |
|---|------|------|------|
| 1 | 초기 idle 화면 | ok |  |
| 2 | 낮은 위험 승인 프롬프트 — file_read (일반 레이블이어야 함) | ok |  |
| 3 | 높은 위험 승인 프롬프트로 교체 — shell_exec rm -rf (HIGH RISK 레이블이어야 함) | ok |  |
| 4 | FP-46 회귀 — curl | sh 도 HIGH RISK 로 표시되어야 함 | ok |  |
| 5 | 거부 입력 n — ChatArea에 거부 기록이 남아야 함 | ok |  |

각 단계의 프레임은 같은 디렉토리의 `NN-*.txt` 파일에 저장되어 있습니다.
