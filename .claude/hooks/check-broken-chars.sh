#!/bin/bash
# PreToolUse hook: git commit 전 깨진 문자(UTF-8 replacement character) 검사
# exit 0 = 통과, exit 2 = 차단

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

if ! echo "$COMMAND" | grep -qE '^git commit'; then
  exit 0
fi

# staged 파일에서 U+FFFD (replacement character) 검사
VIOLATIONS=$(git diff --cached --diff-filter=ACM -- '*.js' '*.md' '*.json' \
  | grep -n $'\xef\xbf\xbd' \
  | head -20)

if [ -n "$VIOLATIONS" ]; then
  echo "❌ 깨진 문자(U+FFFD)가 포함되어 있습니다." >&2
  echo "$VIOLATIONS" >&2
  exit 2
fi

exit 0
