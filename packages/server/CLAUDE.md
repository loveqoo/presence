# @presence/server

Express + WebSocket 서버. 1 서버 = N 유저.

## 정책

### 사용자 등록

관리자가 CLI로 등록. 셀프 가입 없음.

```bash
npm run user -- init --username <이름>    # 등록 + 임시 비밀번호
npm run user -- add --username <이름>     # 추가 사용자
npm run user -- passwd --username <이름>  # 비밀번호 재설정
npm run user -- list                      # 사용자 목록
```

최초 로그인 시 비밀번호 변경 강제. 변경 전까지 기능 사용 불가.

### 유저 데이터 격리

```
~/.presence/data/{username}/
├── config.json       ← LLM, locale, persona 등
├── memory.json       ← MemoryGraph
├── mem0_history.db   ← mem0 SQLite
├── jobs.db           ← 스케줄러 JobStore
└── persistence/      ← 세션 영속화
```

다른 머신 이동: 유저 폴더 통째로 복사.

### 인증

- bcrypt 해시 + HMAC-SHA256 JWT (node:crypto)
- Access token (15분) + Refresh token (7일, rotation)
- `POST /api/auth/login`, `/refresh`, `/logout`, `/change-password`

### 횡단 관심사

인증/토큰 변경 시 확인:
- WS, API 모든 경로에서 동작하는가?
- refresh rotation이 다른 클라이언트/테스트에 영향을 주는가?
