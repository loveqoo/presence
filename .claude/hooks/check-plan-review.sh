#!/bin/bash
# PreToolUse hook: ExitPlanMode 전 adversarial review 실행 여부 확인
# .claude/.plan-review-hash 에 기록된 해시와 플랜 파일 해시가 일치해야 통과
# Codex 미설치 시 graceful skip
# exit 0 = 통과, exit 2 = 차단

INPUT=$(cat)

# Codex companion이 없으면 스킵 (플러그인 미설치 환경)
CODEX_COMPANION=$(find "$HOME/.claude/plugins/cache/openai-codex/codex" \
  -name "codex-companion.mjs" -maxdepth 4 2>/dev/null | sort | tail -1)

if [ -z "$CODEX_COMPANION" ]; then
  exit 0
fi

# 플랜 파일 찾기
PLAN_DIR="$HOME/.claude/plans"
if [ ! -d "$PLAN_DIR" ]; then
  exit 0
fi

# 가장 최근 수정된 플랜 파일
PLAN_FILE=$(find "$PLAN_DIR" -name "*.md" -maxdepth 1 2>/dev/null | xargs ls -t 2>/dev/null | head -1)
if [ -z "$PLAN_FILE" ]; then
  exit 0
fi

# 플랜 파일 해시 계산
CURRENT_HASH=$(shasum -a 256 "$PLAN_FILE" 2>/dev/null | cut -d' ' -f1)

REVIEW_FILE="$CLAUDE_PROJECT_DIR/.claude/.plan-review-hash"

if [ -f "$REVIEW_FILE" ]; then
  SAVED_HASH=$(cat "$REVIEW_FILE" 2>/dev/null)
  if [ "$CURRENT_HASH" = "$SAVED_HASH" ]; then
    exit 0
  fi
fi

echo "❌ /codex:adversarial-review 를 먼저 실행하세요." >&2
echo "  ExitPlanMode 전에 플랜 리뷰가 필요합니다." >&2
echo "  리뷰 후 해시를 기록하세요:" >&2
echo "  shasum -a 256 \"$PLAN_FILE\" | cut -d' ' -f1 > .claude/.plan-review-hash" >&2
exit 2
