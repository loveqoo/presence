#!/bin/bash
# PreToolUse hook: git commit 전 null 리턴 검사 (신규 추가 라인만)
# exit 0 = 통과, exit 2 = 차단

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

if ! echo "$COMMAND" | grep -qE '^git commit'; then
  exit 0
fi

# staged diff에서 추가된 라인(+)만 검사
VIOLATIONS=$(git diff --cached --diff-filter=ACM -U0 -- 'packages/*/src/**/*.js' \
  ':!**/test/**' ':!**/node_modules/**' ':!**/fun-fp.js' \
  | awk '
    /^---/  { next }
    /^\+\+\+/ { file = substr($0, 7); next }
    /^@@/   { match($0, /\+([0-9]+)/, a); line = a[1]; next }
    /^\+/   { if ($0 ~ /return null/) print "  " file ":" line ": " substr($0, 2); line++ }
  ')

if [ -n "$VIOLATIONS" ]; then
  echo "❌ null 리턴 금지. Maybe를 사용하세요." >&2
  echo "$VIOLATIONS" >&2
  exit 2
fi

exit 0
