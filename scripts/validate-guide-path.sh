#!/bin/bash
# validate-guide-path.sh
# user-guide-writer 에이전트의 Edit/Write 경로를 검증.
# docs/guide/ 하위 경로만 허용하고 그 외는 차단 (exit 2).

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
  */docs/guide/*|docs/guide/*)
    exit 0
    ;;
  */.claude/agent-memory/user-guide-writer/*|.claude/agent-memory/user-guide-writer/*)
    exit 0
    ;;
  *)
    echo "Blocked: user-guide-writer는 docs/guide/ 또는 .claude/agent-memory/user-guide-writer/ 하위 파일만 수정할 수 있습니다. (시도: $FILE_PATH)" >&2
    exit 2
    ;;
esac
