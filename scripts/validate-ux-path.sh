#!/bin/bash
# validate-ux-path.sh
# ux-guardian 에이전트의 Edit/Write 경로를 검증.
# docs/ux/ 하위 경로만 허용하고 그 외는 차단 (exit 2).

set -e

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

case "$TOOL_NAME" in
  Edit|Write)
    ;;
  *)
    exit 0
    ;;
esac

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

case "$FILE_PATH" in
  */docs/ux/*|docs/ux/*)
    exit 0
    ;;
  */.claude/agent-memory/ux-guardian/*|.claude/agent-memory/ux-guardian/*)
    exit 0
    ;;
  *)
    echo "Blocked: ux-guardian은 docs/ux/ 또는 .claude/agent-memory/ux-guardian/ 하위 파일만 수정할 수 있습니다. (시도: $FILE_PATH)" >&2
    exit 2
    ;;
esac
