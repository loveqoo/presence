#!/bin/bash
# PreToolUse hook: FP 규칙 위반 검사
# exit 0 = 통과, exit 2 = 차단 (Claude에 피드백)

INPUT=$(cat)

# Edit/Write tool에서 file_path와 new_string 추출
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
NEW_STRING=$(echo "$INPUT" | jq -r '.tool_input.new_string // .tool_input.content // empty' 2>/dev/null)

# 대상이 아닌 파일은 통과
if [ -z "$FILE_PATH" ] || [ -z "$NEW_STRING" ]; then
  exit 0
fi

# packages/*/src/**/*.js 파일만 검사
if [[ ! "$FILE_PATH" =~ packages/.*/src/.*\.js$ ]]; then
  exit 0
fi

# 테스트 파일, node_modules 제외
if [[ "$FILE_PATH" =~ test/ ]] || [[ "$FILE_PATH" =~ node_modules/ ]]; then
  exit 0
fi

# --- 규칙 1: 신규 클로저 DI 패턴 감지 ---
# const createXxx = ({ dep1, dep2 }) => { ... } 또는 (dep1, dep2) => { ... } 패턴
# 레거시 브릿지(단일 라인 xR.run)는 허용
if echo "$NEW_STRING" | grep -qE 'const create[A-Z]\w+\s*=\s*\(' ; then
  # 레거시 브릿지 패턴인지 확인 (xR.run 위임)
  if ! echo "$NEW_STRING" | grep -qE '\.run\(' ; then
    echo "❌ 클로저 DI 신규 작성 금지. Reader.asks를 사용하세요." >&2
    echo "   패턴: const createX = (deps) => { ... }" >&2
    echo "   대안: const xR = Reader.asks(({ dep1, dep2 }) => ...)" >&2
    echo "         const createX = (deps) => xR.run(deps)  // 레거시 브릿지만 허용" >&2
    exit 2
  fi
fi

# --- 규칙 2: 가변 배열 push로 trace 축적 감지 ---
# interpreter, traced 관련 파일에서 trace.push 금지
if [[ "$FILE_PATH" =~ interpreter/ ]] || [[ "$FILE_PATH" =~ traced ]]; then
  if echo "$NEW_STRING" | grep -qE 'trace\.(push|length\s*=)' ; then
    echo "❌ 가변 trace 배열 직접 조작 금지. Writer.tell을 사용하세요." >&2
    echo "   패턴: trace.push(entry) / trace.length = 0" >&2
    echo "   대안: traceWriter = traceWriter.chain(() => Writer.tell([entry]))" >&2
    exit 2
  fi
fi

# --- 규칙 3: mergeConfig 중첩 호출 감지 ---
if echo "$NEW_STRING" | grep -qE 'mergeConfig\(mergeConfig\(' ; then
  echo "❌ mergeConfig 중첩 호출 금지. State.modify chain을 사용하세요." >&2
  echo "   패턴: mergeConfig(mergeConfig(base, a), b)" >&2
  echo "   대안: buildConfig([a, b]).run(base)[0]" >&2
  exit 2
fi

exit 0
