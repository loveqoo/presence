# slash-typo

등록되지 않은 슬래시 커맨드 입력을 검증한다. FP-7(알 수 없는 /command가 에이전트 턴으로 그대로 전달됨)을 재현한다. session.md E12에 Known Gap으로 명시된 사안.

**결과**: 3/5 단계 통과

| # | 단계 | 상태 | 오류 |
|---|------|------|------|
| 1 | 초기 화면 — routed 버퍼 초기화 | ok |  |
| 2 | 알 수 없는 슬래시 커맨드 입력 — /mem (실제는 /memory) | ok |  |
| 3 | 입력 후 화면 — "알 수 없는 커맨드" 안내가 표시되는가 (기대: 실패 = FP-7 재현) | assertion-failed | assertion failed at "입력 후 화면 — "알 수 없는 커맨드" 안내가 표시되는가 (기대: 실패 = FP-7 재현)" |
| 4 | 또 다른 오타 /model (실제는 /models) | ok |  |
| 5 | 오타가 에이전트 onInput까지 도달했는지 확인 (기대: 도달 = FP-7 재현) | assertion-failed | assertion failed at "오타가 에이전트 onInput까지 도달했는지 확인 (기대: 도달 = FP-7 재현)" |

각 단계의 프레임은 같은 디렉토리의 `NN-*.txt` 파일에 저장되어 있습니다.
