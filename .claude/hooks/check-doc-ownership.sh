#!/bin/bash
# 문서 소유권 가드 — docs/specs, docs/ux, docs/guide 는 지정된 가디언만 수정 가능.
# 메인 클로드가 직접 Edit/Write 하면 차단하고 가디언 호출을 안내한다.
#
# 판단 기준: PreToolUse 입력 JSON 의 agent_type 필드.
# - 부재 (메인 클로드) → 차단
# - 일치하는 가디언 → 통과
# - 다른 서브에이전트 → 차단

set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // ""')

required=""
case "$FILE_PATH" in
  */docs/specs/*) required="spec-guardian" ;;
  */docs/ux/*)    required="ux-guardian" ;;
  */docs/guide/*) required="user-guide-writer" ;;
  *) exit 0 ;;
esac

if [[ "$AGENT_TYPE" == "$required" ]]; then
  exit 0
fi

caller="${AGENT_TYPE:-main}"
jq -n \
  --arg req "$required" \
  --arg path "$FILE_PATH" \
  --arg caller "$caller" \
  '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ("이 경로(" + $path + ")는 " + $req + " 의 소유 영역입니다. 현재 호출자: " + $caller + ". Agent 도구로 " + $req + " 를 호출해 위임하세요.")
    }
  }'
exit 0
