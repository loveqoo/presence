# Live Probes

티켓(FP/KG)별 재현 시나리오를 **상시 tracked** 로 보관하는 디렉토리. 디버그
리포트에서 발견한 버그를 임시 script 로만 확인하고 버리지 않고, probe 파일로
남겨 언제든 재검증.

## 원칙

- 파일명: `<ticket-id>-<slug>.test.js` (예: `fp-62-web-fetch-quality.test.js`)
- `live-helpers.js` 의 `connect()` + `probeTool()` 을 사용 — 임시 유저 자동
  생성/삭제, REST만으로 chat 한 번 돌려 toolTranscript 검증
- `test/run.js` 에 등록하지 **않는다** — 라이브 LLM 이 필요하므로 자동 회귀
  불가. 수동 실행 전용
- 서버가 실행 중이어야 한다 (`npm start` 선행)

## 실행

```bash
node test/e2e/live-probes/fp-62-web-fetch-quality.test.js
```

성공/실패는 stdout 로 명시. LLM 출력의 편차가 크므로 assertion 은 "구조적
특징" (tool 호출 여부, 경고 prefix 존재 등) 에 초점. 정확한 응답 문자열은
지양.

## 새 probe 추가 시

1. FP/KG 티켓 등록 후 번호 확보
2. `<id>-<slug>.test.js` 로 파일 생성
3. `connect()` → `probeTool()` → assertion → `teardown()` 흐름
4. 해소되면 파일을 지우지 않고 유지 — 회귀 검증용. comment 에 "resolved"
   표시만 추가
