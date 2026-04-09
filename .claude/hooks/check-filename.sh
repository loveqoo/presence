#!/bin/bash
# PreToolUse hook: git commit 전 파일명 컨벤션 검사
# 기본: kebab-case (소문자 + 하이픈)
# 예외: React 컴포넌트(PascalCase), React hooks(camelCase, useX)
# exit 0 = 통과, exit 2 = 차단

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# git commit 명령만 가로챔
if ! echo "$COMMAND" | grep -qE '^git commit'; then
  exit 0
fi

# 스테이징된 .js 파일 목록 (신규 + 수정)
STAGED=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.js$' | grep -v 'node_modules/' | grep -v 'fun-fp.js')

if [ -z "$STAGED" ]; then
  exit 0
fi

VIOLATIONS=""

# 정규식
KEBAB='^[a-z0-9]+(-[a-z0-9]+)*(\.test|\.spec|\.live)?\.js$'
PASCAL='^[A-Z][a-zA-Z0-9]*\.js$'
HOOK='^use[A-Z][a-zA-Z0-9]*\.js$'

for FILE in $STAGED; do
  BASENAME=$(basename "$FILE")
  DIRNAME=$(dirname "$FILE")

  # 예외 1: React 컴포넌트 (*/components/* 하위) → PascalCase
  if echo "$DIRNAME" | grep -qE '/components(/|$)'; then
    if [[ "$BASENAME" =~ $PASCAL ]] || [[ "$BASENAME" =~ $KEBAB ]]; then
      continue
    fi
    VIOLATIONS="${VIOLATIONS}\n  ${FILE}: React 컴포넌트는 PascalCase 또는 kebab-case 필요"
    continue
  fi

  # 예외 2: React hooks (*/hooks/* 하위, use로 시작) → camelCase
  if echo "$DIRNAME" | grep -qE '/hooks(/|$)'; then
    if [[ "$BASENAME" =~ $HOOK ]] || [[ "$BASENAME" =~ $KEBAB ]]; then
      continue
    fi
    VIOLATIONS="${VIOLATIONS}\n  ${FILE}: React hook은 useXxx (camelCase) 또는 kebab-case 필요"
    continue
  fi

  # 예외 3: ui/ 하위 React 파일 (App.js 등) → PascalCase 허용
  if echo "$DIRNAME" | grep -qE '/ui(/|$)'; then
    if [[ "$BASENAME" =~ $PASCAL ]] || [[ "$BASENAME" =~ $KEBAB ]]; then
      continue
    fi
    VIOLATIONS="${VIOLATIONS}\n  ${FILE}: ui/ 하위는 PascalCase 또는 kebab-case 필요"
    continue
  fi

  # 기본: kebab-case 또는 단일 단어 소문자
  if [[ ! "$BASENAME" =~ $KEBAB ]]; then
    VIOLATIONS="${VIOLATIONS}\n  ${FILE}: 기본은 kebab-case 필요 (소문자 + 하이픈)"
  fi
done

if [ -n "$VIOLATIONS" ]; then
  echo "❌ 파일명 컨벤션 위반." >&2
  echo "  규칙:" >&2
  echo "    - 기본: kebab-case (user-context.js)" >&2
  echo "    - React 컴포넌트(components/): PascalCase (StatusBar.js)" >&2
  echo "    - React hooks(hooks/): camelCase useXxx (useAgentState.js)" >&2
  echo -e "  위반:${VIOLATIONS}" >&2
  exit 2
fi

exit 0
