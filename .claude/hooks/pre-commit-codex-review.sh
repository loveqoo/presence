#!/bin/bash
# PreToolUse hook: git commit 전 Codex 코드 리뷰 (경고만, 차단 안 함)
# exit 0 = 항상 통과 (결과는 stderr 경고로 출력)

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# git commit 명령만 처리 (git commit -a 포함)
if ! echo "$COMMAND" | grep -qE '^git commit'; then
  exit 0
fi

# codex-companion.mjs 동적 탐색 (버전 무관, macOS 호환)
CODEX_COMPANION=$(find "$HOME/.claude/plugins/cache/openai-codex/codex" \
  -name "codex-companion.mjs" -maxdepth 4 2>/dev/null | sort | tail -1)

if [ -z "$CODEX_COMPANION" ]; then
  echo "⚠️  Codex companion not found — 리뷰 건너뜀" >&2
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "⚠️  node not found — Codex 리뷰 건너뜀" >&2
  exit 0
fi

# staged 변경 없으면 스킵 (삭제/rename 포함)
STAGED=$(git diff --cached --name-only 2>/dev/null)
if [ -z "$STAGED" ]; then
  exit 0
fi

echo "🔍 Codex 코드 리뷰 실행 중..." >&2

# 90초 타임아웃으로 실행 (macOS 호환: perl fallback)
run_with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 90 "$@"
  else
    perl -e 'alarm 90; exec @ARGV' -- "$@"
  fi
}

RESULT=$(run_with_timeout node "$CODEX_COMPANION" review --json 2>/dev/null)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 124 ]; then
  echo "⚠️  Codex 리뷰 타임아웃 (90초) — 계속 진행" >&2
  exit 0
fi

if [ -z "$RESULT" ] || ! echo "$RESULT" | jq . >/dev/null 2>&1; then
  echo "⚠️  Codex 리뷰 결과 파싱 실패 — 계속 진행" >&2
  exit 0
fi

# verdict 추출
VERDICT=$(echo "$RESULT" | jq -r '.result.verdict // "unknown"' 2>/dev/null)
REVIEW_TEXT=$(echo "$RESULT" | jq -r '.codex.stdout // ""' 2>/dev/null)

if [ "$VERDICT" = "approve" ]; then
  echo "✓ Codex 리뷰 — approve (이슈 없음)" >&2
elif [ "$VERDICT" = "needs-attention" ]; then
  FINDINGS_COUNT=$(echo "$RESULT" | jq '.result.findings | length' 2>/dev/null || echo "?")
  echo "⚠️  Codex 리뷰 — needs-attention (${FINDINGS_COUNT}건 발견)" >&2
  echo "" >&2
  echo "$RESULT" | jq -r '
    .result.findings[]?
    | select(.severity == "critical" or .severity == "high")
    | "  [\(.severity)] \(.title) — \(.file):\(.line_start)"
  ' >&2 2>/dev/null || true
  echo "" >&2
  echo "  전체 결과: /codex:review 로 확인" >&2
else
  if [ -n "$REVIEW_TEXT" ]; then
    echo "── Codex 리뷰 ──" >&2
    echo "$REVIEW_TEXT" | head -20 >&2
    echo "" >&2
  fi
fi

exit 0
