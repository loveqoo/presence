#!/bin/bash
# PreToolUse hook: git commit 전 테스트 실행
# exit 0 = 통과, exit 2 = 차단

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# git commit 명령만 가로챔
if ! echo "$COMMAND" | grep -qE '^git commit'; then
  exit 0
fi

# core 테스트 실행
RESULT=$(npm run test -w @presence/core 2>&1)
if ! echo "$RESULT" | grep -q '0 failed'; then
  echo "❌ core 테스트 실패. 테스트 통과 후 커밋하세요." >&2
  echo "$RESULT" | tail -5 >&2
  exit 2
fi

# 전체 테스트 실행
RESULT=$(node test/run.js --no-network 2>&1)
if ! echo "$RESULT" | grep -q '0 failed'; then
  echo "❌ 전체 테스트 실패. 테스트 통과 후 커밋하세요." >&2
  echo "$RESULT" | tail -5 >&2
  exit 2
fi

exit 0
