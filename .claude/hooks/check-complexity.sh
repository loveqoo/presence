#!/bin/bash
# PreToolUse hook: git commit 전 복잡도 검사
# exit 0 = 통과, exit 2 = 차단

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# git commit 명령만 가로챔
if ! echo "$COMMAND" | grep -qE '^git commit'; then
  exit 0
fi

# 스테이징된 .js 파일 목록 (packages/*/src/**/*.js만)
STAGED=$(git diff --cached --name-only --diff-filter=ACM | grep -E '^packages/.*/src/.*\.js$' | grep -v 'test/' | grep -v 'node_modules/' | grep -v 'fun-fp.js')

if [ -z "$STAGED" ]; then
  exit 0
fi

# ESLint 기반 복잡도 검사 (eslint.config.js 의 max-lines / max-params /
# max-depth / complexity / sonarjs/cognitive-complexity)
RESULT=$(npx --no-install eslint --max-warnings 0 $STAGED 2>&1)
EXIT_CODE=$?

if [ "$EXIT_CODE" -ne 0 ]; then
  echo "❌ 복잡도/품질 임계치 초과. 리팩토링 후 커밋하세요." >&2
  echo "$RESULT" >&2
  exit 2
fi

exit 0
