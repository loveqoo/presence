#!/bin/bash
# PreToolUse hook: 메인 에이전트의 .review-hash 직접 쓰기 차단
# code-review-orchestrator만 해시를 기록할 수 있다.
# exit 0 = 통과, exit 2 = 차단

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Bash 명령이 아니면 스킵
if [ -z "$COMMAND" ]; then
  exit 0
fi

# .review-hash 에 쓰기(리다이렉트) 명령 감지
# > .review-hash 또는 >> .review-hash 패턴만 차단 (cat/읽기는 허용)
# 허용된 에이전트는 명령에 AGENT_TYPE=... 를 명시적으로 포함한다.
# Claude Code 런타임이 AGENT_TYPE을 자동 주입하지 않으므로, 명령 문자열에서 추출한다.
ALLOWED_AGENTS="code-review-orchestrator"

if echo "$COMMAND" | grep -qE '>\s*.*\.review-hash'; then
  caller="${AGENT_TYPE:-main}"
  # 명령 문자열에서 AGENT_TYPE 추출
  for agent in $ALLOWED_AGENTS; do
    if echo "$COMMAND" | grep -qE "AGENT_TYPE=${agent}"; then
      caller="$agent"
      break
    fi
  done
  allowed=false
  for agent in $ALLOWED_AGENTS; do
    if [ "$caller" = "$agent" ]; then
      allowed=true
      break
    fi
  done
  if [ "$allowed" = false ]; then
    echo "❌ .review-hash는 code-review-orchestrator만 기록할 수 있습니다." >&2
    echo "  code-review-orchestrator를 실행하면 자동으로 기록됩니다." >&2
    exit 2
  fi
fi

exit 0
