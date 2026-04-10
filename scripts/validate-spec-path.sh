#!/bin/bash
# validate-spec-path.sh
# spec-guardian 에이전트의 Edit/Write 경로를 검증.
# docs/specs/ 하위 경로만 허용하고 그 외는 차단 (exit 2).

set -e

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Edit/Write가 아니면 통과
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

# docs/specs/ 하위 경로만 허용
case "$FILE_PATH" in
  */docs/specs/*|docs/specs/*)
    exit 0
    ;;
  */.claude/agent-memory/spec-guardian/*|.claude/agent-memory/spec-guardian/*)
    exit 0
    ;;
  *)
    echo "Blocked: spec-guardian은 docs/specs/ 또는 .claude/agent-memory/spec-guardian/ 하위 파일만 수정할 수 있습니다. (시도: $FILE_PATH)" >&2
    exit 2
    ;;
esac
