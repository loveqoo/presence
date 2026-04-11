#!/bin/bash
# PreToolUse hook: git commit 전에 티켓 레지스트리 정합성 검증
# docs/tickets/REGISTRY.md 또는 docs/ux/ 파일이 스테이징되었을 때만 실행
# exit 0 = 통과, exit 2 = 차단

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# git commit 명령만 가로챔
if ! echo "$COMMAND" | grep -qE '^git commit'; then
  exit 0
fi

# 레지스트리 또는 ux/spec 문서가 staged 되었을 때만 검증
STAGED_REL=$(git diff --cached --name-only --diff-filter=ACM)
if ! echo "$STAGED_REL" | grep -qE '^(docs/tickets/REGISTRY\.md|docs/ux/.*\.md|docs/specs/.*\.md)$'; then
  exit 0
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
SCRIPT="$REPO_ROOT/scripts/tickets.sh"

if [ ! -x "$SCRIPT" ]; then
  # 스크립트 없음 — 조용히 통과 (초기 부트스트랩 단계 대비)
  exit 0
fi

OUTPUT=$("$SCRIPT" check 2>&1)
STATUS=$?

if [ $STATUS -ne 0 ]; then
  echo "티켓 레지스트리 검증 실패:" >&2
  echo "$OUTPUT" >&2
  echo "" >&2
  echo "수정 방법: scripts/tickets.sh check 실행 후 안내 따름" >&2
  exit 2
fi

exit 0
