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
| `embed.provider` | `openai` | 임베딩 프로바이더 (`openai` / `cohere` / `custom`) |
| `embed.apiKey` | `null` | 임베딩 전용 API 키 (없으면 llm.apiKey 사용) |
| `embed.dimensions` | `256` | 임베딩 벡터 차원 |
| `strategy` | `plan` | 에이전트 전략 (`plan` / `react`) |
| `memory.path` | `~/.presence/memory/graph.json` | 메모리 저장 경로 |
| `mcp` | `[]` | MCP 서버 목록 |
| `heartbeat.enabled` | `true` | 주기적 점검 활성화 |
| `heartbeat.intervalMs` | `300000` | 점검 주기 (ms) |
| `tools.allowedDirs` | `[process.cwd()]` | 파일 도구 허용 디렉토리 |
| `delegatePolling.intervalMs` | `10000` | 원격 delegate 폴링 주기 (ms) |

### 환경변수 오버라이드

설정 파일보다 환경변수가 우선합니다.

```bash
OPENAI_API_KEY=sk-...           # llm.apiKey
OPENAI_MODEL=gpt-4o-mini        # llm.model
OPENAI_BASE_URL=http://...      # llm.baseUrl
PRESENCE_RESPONSE_FORMAT=json_object
PRESENCE_STRATEGY=react
PRESENCE_MEMORY_PATH=/custom/path
PRESENCE_EMBED_PROVIDER=cohere
PRESENCE_EMBED_API_KEY=...
PRESENCE_EMBED_DIMENSIONS=512
PRESENCE_HEARTBEAT=false
PRESENCE_HEARTBEAT_MS=60000
```

## 사용법

### REPL 명령어

실행 후 `>` 프롬프트에서 입력합니다.

| 명령 | 설명 |
|------|------|
| `/help` | 명령어 목록 |
| `/status` | 에이전트 상태 (turnState, turn, lastTurn, 큐 현황) |
| `/tools` | 등록된 도구 목록 |
| `/agents` | 등록된 에이전트 목록 |
| `/memory` | 최근 메모리 노드 (벡터 여부 표시) |
| `/todos` | TODO 목록 |
| `/events` | 이벤트 큐 + dead letter 현황 |
| `/quit` | 종료 |

슬래시 없이 입력하면 에이전트 턴이 실행됩니다.

### 에이전트 전략

**Plan-then-Execute** (기본, `strategy: "plan"`):
1. LLM이 전체 실행 계획을 JSON으로 생성
2. 계획을 파싱하여 Free Monad 프로그램으로 변환
3. 인터프리터가 순차 실행
4. LLM이 결과를 사용자 언어로 가공

**ReAct** (`strategy: "react"`):
1. LLM이 한 단계씩 판단 (Reason → Act → Observe 반복)
2. 도구 호출 또는 최종 답변 결정
3. 최대 `maxSteps`번 반복

### 내장 도구

| 도구 | 설명 | APPROVE |
|------|------|---------|
| `file_read` | 파일 읽기 | 불필요 |
| `file_write` | 파일 쓰기 | **필수** |
| `file_list` | 디렉토리 목록 | 불필요 |
| `web_fetch` | URL 내용 가져오기 | 불필요 |
| `shell_exec` | 셸 명령 실행 | **필수** |

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
- **임베딩**: API 키가 있으면 자동 벡터 생성 (없으면 키워드만)
- **계층**: working (임시) → episodic (대화) → semantic (일반화)

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

## 테스트

```bash
npm test              # 전체 (994 tests)
node test/core/agent.test.js    # 개별 파일
```

모든 테스트는 외부 의존성 없이 실행됩니다.
