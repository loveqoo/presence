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

# 임계치 (core 리팩토링 기준선)
MAX_BRANCH=50
MAX_DEPTH=6
MAX_LOC=300

VIOLATIONS=""

for FILE in $STAGED; do
  if [ ! -f "$FILE" ]; then
    continue
  fi

  LOC=$(wc -l < "$FILE" | tr -d ' ')

  BRANCH=$(grep -cE '\bif\s*\(|\belse\s+if\s*\(|&&|\|\||\?\?|\bcase\s+|\bcatch\s*\(|\bfor\s*\(|\bwhile\s*\(' "$FILE" 2>/dev/null || echo 0)

  DEPTH=$(node -e "
    const fs = require('fs');
    const code = fs.readFileSync('$FILE', 'utf8');
    let max = 0, d = 0;
    for (const ch of code) {
      if (ch === '{') { d++; if (d > max) max = d; }
      else if (ch === '}') d--;
    }
    console.log(max);
  " 2>/dev/null || echo 0)

  FAIL=""
  if [ "$BRANCH" -gt "$MAX_BRANCH" ]; then
    FAIL="${FAIL} Branch=${BRANCH}(>${MAX_BRANCH})"
  fi
  if [ "$DEPTH" -gt "$MAX_DEPTH" ]; then
    FAIL="${FAIL} Depth=${DEPTH}(>${MAX_DEPTH})"
  fi
  if [ "$LOC" -gt "$MAX_LOC" ]; then
    FAIL="${FAIL} LOC=${LOC}(>${MAX_LOC})"
  fi

  if [ -n "$FAIL" ]; then
    VIOLATIONS="${VIOLATIONS}\n  ${FILE}:${FAIL}"
  fi
done

if [ -n "$VIOLATIONS" ]; then
  echo "❌ 복잡도 임계치 초과. 리팩토링 후 커밋하세요." >&2
  echo -e "  기준: Branch≤${MAX_BRANCH}, Depth≤${MAX_DEPTH}, LOC≤${MAX_LOC}${VIOLATIONS}" >&2
  exit 2
fi

exit 0
