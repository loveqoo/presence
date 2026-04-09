#!/bin/bash
# PreToolUse hook: 언더바로 시작하는 함수/메서드명 금지 검사
# 규칙: 함수·메서드 이름에 _prefix 금지 (refactor.md: 함수/메서드 내부 일시 변수만 예외)
# exit 0 = 통과, exit 2 = 차단

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# git commit 명령만 가로챔
if ! echo "$COMMAND" | grep -qE '^git commit'; then
  exit 0
fi

STAGED=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.js$' | grep -v 'node_modules/' | grep -v 'fun-fp.js')

if [ -z "$STAGED" ]; then
  exit 0
fi

VIOLATIONS=""

for FILE in $STAGED; do
  if [ ! -f "$FILE" ]; then
    continue
  fi

  # 1. 모듈 레벨 함수 선언: `function _name(` 또는 `async function _name(`
  MATCHES=$(grep -nE '^(async[[:space:]]+)?function[[:space:]]+_[a-z]' "$FILE" 2>/dev/null || true)

  # 2. 모듈 레벨 arrow function const: `const _name = (args) =>` 또는 `= async (args) =>`
  MATCHES="${MATCHES}
$(grep -nE '^const[[:space:]]+_[a-z][a-zA-Z0-9]*[[:space:]]*=[[:space:]]*(async[[:space:]]*)?\([^)]*\)[[:space:]]*=>' "$FILE" 2>/dev/null || true)"

  # 3. 클래스/객체 메서드 정의: 들여쓰기 + `_name(args) {` (modifiers 포함)
  MATCHES="${MATCHES}
$(grep -nE '^[[:space:]]+(async[[:space:]]+)?(static[[:space:]]+)?(get[[:space:]]+|set[[:space:]]+)?_[a-z][a-zA-Z0-9]*[[:space:]]*\([^)]*\)[[:space:]]*\{' "$FILE" 2>/dev/null || true)"

  MATCHES=$(echo "$MATCHES" | grep -v '^$' || true)

  if [ -n "$MATCHES" ]; then
    while IFS= read -r LINE; do
      VIOLATIONS="${VIOLATIONS}\n  ${FILE}:${LINE}"
    done <<< "$MATCHES"
  fi
done

if [ -n "$VIOLATIONS" ]; then
  echo "❌ 함수/메서드명 언더바 접두사 금지." >&2
  echo "  규칙: 함수·메서드 이름에 _prefix 사용 금지 (refactor.md)" >&2
  echo "        함수·메서드 내부의 일시적 지역 변수는 예외" >&2
  echo -e "  위반:${VIOLATIONS}" >&2
  exit 2
fi

exit 0
