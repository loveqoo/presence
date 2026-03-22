# Presence 사용 가이드

개인 업무 대리 에이전트 플랫폼.

## 빠른 시작

```bash
# 설치
npm install

# 설정 파일 생성
cp config.example.json ~/.presence/config.json
# 에디터로 열어 API 키 등을 설정

# 실행
npm start

# 테스트
npm test
```

## 설정

설정 파일 위치: `~/.presence/config.json`

환경변수 `PRESENCE_CONFIG`로 경로를 변경할 수 있습니다.

### 최소 설정 (OpenAI)

```json
{
  "llm": {
    "apiKey": "sk-..."
  }
}
```

나머지는 기본값이 적용됩니다 (model: gpt-4o, responseFormat: json_schema).

### 로컬 모델 설정 (MLX, Ollama 등)

```json
{
  "llm": {
    "baseUrl": "http://127.0.0.1:8045/v1",
    "model": "qwen3.5-35b",
    "apiKey": "local",
    "responseFormat": "json_object"
  },
  "heartbeat": {
    "enabled": false
  }
}
```

로컬 모델은 `json_schema`가 느리거나 지원되지 않을 수 있으므로 `json_object`를 권장합니다.

### 전체 설정 옵션

| 경로 | 기본값 | 설명 |
|------|--------|------|
| `llm.baseUrl` | `https://api.openai.com/v1` | LLM API 엔드포인트 |
| `llm.model` | `gpt-4o` | 모델 이름 |
| `llm.apiKey` | `null` | API 키 |
| `llm.responseFormat` | `json_schema` | `json_schema` / `json_object` / `none` |
| `llm.maxRetries` | `2` | JSON 파싱 실패 시 재시도 횟수 |
| `llm.timeoutMs` | `120000` | LLM 요청 타임아웃 (ms) |
| `maxIterations` | `10` | Incremental Planning 최대 반복 횟수 |
| `locale` | `ko` | UI 언어 (`ko` / `en`) |
| `embed.provider` | `openai` | 임베딩 프로바이더 (`openai` / `cohere` / `custom`) |
| `embed.baseUrl` | `null` | 임베딩 API 엔드포인트 (로컬 서버용) |
| `embed.apiKey` | `null` | 임베딩 전용 API 키 (없으면 llm.apiKey 사용) |
| `embed.model` | `null` | 임베딩 모델 (프로바이더 기본값 사용) |
| `embed.dimensions` | `256` | 임베딩 벡터 차원 |
| `memory.path` | `~/.presence/memory/graph.json` | 메모리 저장 경로 |
| `mcp` | `[]` | MCP 서버 목록 |
| `heartbeat.enabled` | `true` | 주기적 점검 활성화 |
| `heartbeat.intervalMs` | `300000` | 점검 주기 (ms) |
| `heartbeat.prompt` | `정기 점검: 현황 확인` | Heartbeat 프롬프트 |
| `prompt.maxContextTokens` | `8000` | 프롬프트 최대 컨텍스트 토큰 |
| `prompt.reservedOutputTokens` | `1000` | 출력용 예약 토큰 |
| `tools.allowedDirs` | `[process.cwd()]` | 파일 도구 허용 디렉토리 |
| `delegatePolling.intervalMs` | `10000` | 원격 delegate 폴링 주기 (ms) |

### 환경변수 오버라이드

설정 파일보다 환경변수가 우선합니다.

```bash
OPENAI_API_KEY=sk-...           # llm.apiKey
OPENAI_MODEL=gpt-4o-mini        # llm.model
OPENAI_BASE_URL=http://...      # llm.baseUrl
PRESENCE_RESPONSE_FORMAT=json_object
PRESENCE_MEMORY_PATH=/custom/path
PRESENCE_EMBED_PROVIDER=cohere
PRESENCE_EMBED_API_KEY=...
PRESENCE_EMBED_DIMENSIONS=512
PRESENCE_HEARTBEAT=false
PRESENCE_HEARTBEAT_MS=60000
```

## 사용법

### 명령어

실행 후 `>` 프롬프트에서 입력합니다.

**대화:**

| 명령 | 설명 |
|------|------|
| `/clear` | 대화 이력 초기화 (메모리는 유지) |

**정보:**

| 명령 | 설명 |
|------|------|
| `/status` | 현재 상태 (턴, 모드, 큐 현황) |
| `/tools` | 등록된 도구 목록 |
| `/agents` | 등록된 에이전트 목록 |
| `/todos` | TODO 목록 |
| `/events` | 이벤트 큐 + dead letter 현황 |

**설정:**

| 명령 | 설명 |
|------|------|
| `/models` | 모델 조회 및 전환 (예: `/models gpt-4`) |
| `/memory` | 메모리 관리 (예: `/memory list`, `/memory clear 7d`) |
| `/statusline` | 상태바 표시 항목 설정 (예: `/statusline +turn`) |

**화면:**

| 명령 | 설명 |
|------|------|
| `/panel` | 사이드 패널 토글 |
| `/report` | 디버그 리포트 저장 (`~/.presence/reports/`) |
| `/quit` | 종료 |

### 단축키

| 키 | 설명 |
|----|------|
| `Ctrl+T` | 트랜스크립트 오버레이 (Op 추적, 프롬프트, 응답 확인) |
| `Ctrl+O` | 상세 보기 토글 (도구 결과 펼침) |
| `ESC` | 턴 취소 (작업 중) / 도움말 닫기 (대기 중) |
| `↑ / ↓` | 입력 이력 탐색 |

### 에이전트 동작 방식

Incremental Planning Engine:
1. LLM이 실행 계획을 JSON으로 생성
2. 계획을 파싱하여 Free Monad 프로그램으로 변환
3. 인터프리터가 순차 실행
4. 결과를 관찰하고, 추가 정보가 필요하면 다시 1번으로 (최대 `maxIterations`회)
5. 충분한 정보가 모이면 `direct_response`로 최종 답변

### 내장 도구

| 도구 | 설명 | APPROVE |
|------|------|---------|
| `file_read` | 파일 읽기 | 불필요 |
| `file_write` | 파일 쓰기 | **필수** |
| `file_list` | 디렉토리 목록 (트리 형태) | 불필요 |
| `web_fetch` | URL 내용 가져오기 (15초 타임아웃, 최대 10KB) | 불필요 |
| `shell_exec` | 셸 명령 실행 (30초 타임아웃) | **필수** |
| `calculate` | 수학 표현식 계산 | 불필요 |

`file_write`와 `shell_exec`는 실행 전 사용자 승인을 요청합니다.
파일 도구는 `tools.allowedDirs`에 지정된 디렉토리만 접근 가능합니다.

### 승인(APPROVE) 시스템

위험한 작업 전에 에이전트가 승인을 요청합니다:

```
⚠ 승인 필요: 셸 명령 실행: rm -rf /tmp/old
  계속하시겠습니까? (y/n) >
```

- `y` → 작업 실행
- `n` → 작업 거부, 에이전트가 대안을 제시

백그라운드 턴(heartbeat, 이벤트)에서는 APPROVE가 자동 거부됩니다.

### MCP 서버 연동

외부 MCP 서버는 설정 파일의 `mcp` 배열에 추가합니다.

```json
{
  "mcp": [
    {
      "serverName": "github",
      "enabled": true,
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }
    }
  ]
}
```

도구 이름은 `{serverName}_{toolName}` 형태로 등록됩니다 (예: `github_list_pull_requests`).

### 메모리 시스템

대화 기록이 자동으로 episodic memory에 저장됩니다.

- **영속화**: `~/.presence/memory/graph.json` (lowdb)
- **검색**: 키워드 + 벡터 유사도 하이브리드
- **임베딩**: API 키가 있으면 자동 벡터 생성 (없으면 비활성)
- **계층**: working (임시) → episodic (대화) → semantic (일반화)
- **자동 승격**: 동일 주제가 3회 이상 반복되면 episodic → semantic으로 자동 승격
- **관리**: `/memory list`, `/memory clear 7d` 등으로 관리

### 대화 이력 압축

대화가 15턴을 넘으면 자동으로 오래된 이력을 LLM으로 요약 압축합니다.

- 최근 5턴은 원본 유지, 나머지를 3-5문장 요약으로 교체
- 요약 위에 새 대화가 쌓이면 다시 압축 (점진적 요약 병합)
- `/clear`로 전체 초기화 가능

### 프롬프트 예산

토큰 예산 기반으로 프롬프트를 자동 조립합니다.

1. 고정 시스템 메시지 (역할, 규칙, 도구 목록)
2. 대화 이력 (최신 우선, 예산 내에서 최대한)
3. 관련 메모리 (남은 예산으로)

예산 사용량이 90%를 넘거나 이력이 제외되면 경고 메시지가 표시됩니다.

### Heartbeat

주기적으로 에이전트 턴을 실행합니다 (기본 5분).

```json
{
  "heartbeat": {
    "enabled": true,
    "intervalMs": 300000,
    "prompt": "정기 점검: PR, 이슈 현황 확인"
  }
}
```

이벤트 큐를 통해 실행되며, 에이전트가 작업 중이면 큐에 대기합니다.

## 아키텍처

```
User Input → Free Monad Program → Interpreter → Side Effects
                                              ↓
                                    State + Hook → Memory, Persistence, Events
```

- **Free Monad**: 프로그램 선언과 실행의 분리
- **ADT**: 상태 전이를 합타입으로 표현 (Phase, TurnResult, ErrorInfo)
- **Either/Maybe**: 에러와 null을 값으로 처리
- **Interpreter**: prod (실제), test (mock), traced (로깅), dryrun (검증)
- **Policies**: 정책 상수를 `src/core/policies.js`에 통합 관리

## 테스트

```bash
npm test              # 전체 (1578 tests, 39 files)
node test/core/agent.test.js    # 개별 파일
```

모든 테스트는 외부 의존성 없이 실행됩니다.

## 트러블슈팅

### 응답이 너무 느림

- `~/.presence/config.json`에서 `responseFormat`을 `json_object`로 변경
- 로컬 모델이면 `json_schema` 대신 `json_object` 필수

### "LLM API error" 반복

- `/status`로 상태 확인
- `~/.presence/config.json`의 `llm.apiKey`와 `llm.baseUrl` 확인

### 도구가 안 보임

- `/tools`로 등록된 도구 확인
- 로컬 도구는 `tools.allowedDirs` 설정 확인

### 메모리가 안 쌓임

- `/memory`로 확인
- 실패 턴은 메모리에 저장되지 않음 (의도된 동작)
- `~/.presence/memory/graph.json` 파일 존재 확인

### 프롬프트 예산 경고가 뜸

- `/clear`로 대화 이력 초기화
- `/memory clear 7d`로 오래된 메모리 정리
- `prompt.maxContextTokens` 값 증가 검토

### 모델을 변경하고 싶음

- `/models`로 사용 가능한 모델 조회
- `/models gpt-4o-mini` 형태로 런타임 전환
- 설정 파일의 `llm.model`로 기본값 변경
