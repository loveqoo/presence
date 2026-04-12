#!/bin/bash
# PreToolUse hook: git commit 전 code-reviewer 에이전트 실행 여부 확인
# .claude/.review-hash 에 기록된 해시와 staged diff 해시가 일치해야 통과
# exit 0 = 통과, exit 2 = 차단

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# git commit 명령만 처리 (git commit -a 포함)
if ! echo "$COMMAND" | grep -qE '^git commit'; then
  exit 0
fi

# git commit -a/-am 이면 tracked 변경을 미리 stage
if echo "$COMMAND" | grep -qE '^git commit\s+.*-[a-zA-Z]*a'; then
  git add -u 2>/dev/null
fi

# staged 변경 없으면 스킵 (삭제/rename 포함)
STAGED=$(git diff --cached --name-only 2>/dev/null)
if [ -z "$STAGED" ]; then
  exit 0
fi

# staged diff 해시 계산
CURRENT_HASH=$(git diff --cached 2>/dev/null | shasum -a 256 | cut -d' ' -f1)

REVIEW_FILE="$CLAUDE_PROJECT_DIR/.claude/.review-hash"

if [ -f "$REVIEW_FILE" ]; then
  SAVED_HASH=$(cat "$REVIEW_FILE" 2>/dev/null)
  if [ "$CURRENT_HASH" = "$SAVED_HASH" ]; then
    exit 0
  fi
fi

echo "❌ code-reviewer 에이전트를 먼저 실행하세요." >&2
echo "  code-reviewer 통과 후 해시가 기록되어야 커밋할 수 있습니다." >&2
echo "  staged diff 해시: ${CURRENT_HASH:0:16}..." >&2
exit 2
