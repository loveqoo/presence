#!/usr/bin/env bash
# presence 티켓 레지스트리 헬퍼
# 사용: scripts/tickets.sh <command> [args]
#
# commands:
#   list [--status STATUS] [--type TYPE] [--area AREA]
#       레지스트리의 항목을 필터링하여 출력
#   next-id <fp|kg>
#       다음 사용 가능한 FP / KG ID 를 출력 (예: FP-46)
#   check
#       레지스트리 정합성 검증 (중복, 고아, 소스 파일 존재, 역참조 동기화)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGISTRY="$REPO_ROOT/docs/tickets/REGISTRY.md"

die() { echo "ERROR: $*" >&2; exit 1; }

require_registry() {
  [[ -f "$REGISTRY" ]] || die "registry not found: $REGISTRY"
}

# 테이블 row 추출 (파이프로 시작하고 FP- 또는 KG- 포함, 헤더/구분선 제외)
extract_rows() {
  awk '
    /^\| *(FP|KG)-[0-9]+/ { print }
  ' "$REGISTRY"
}

# 특정 컬럼만 추출 (1=ID, 2=Status, 3=Severity, 4=Area, 5=Title, 6=Source)
col() {
  awk -F'|' -v col="$1" '{
    gsub(/^ +| +$/, "", $(col+1))
    print $(col+1)
  }'
}

cmd_list() {
  local filter_status="" filter_type="" filter_area=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --status) filter_status="$2"; shift 2 ;;
      --type)   filter_type="$2";   shift 2 ;;
      --area)   filter_area="$2";   shift 2 ;;
      *) die "unknown flag: $1" ;;
    esac
  done
  require_registry
  printf "%-7s %-9s %-7s %-7s %s\n" "ID" "STATUS" "SEV" "AREA" "TITLE"
  printf "%-7s %-9s %-7s %-7s %s\n" "------" "--------" "------" "------" "-----"
  extract_rows | while IFS= read -r row; do
    id=$(echo "$row"     | col 1)
    status=$(echo "$row" | col 2)
    sev=$(echo "$row"    | col 3)
    area=$(echo "$row"   | col 4)
    title=$(echo "$row"  | col 5)
    type_prefix="${id%%-*}"
    [[ -n "$filter_status" && "$status" != "$filter_status" ]] && continue
    [[ -n "$filter_area"   && "$area"   != "$filter_area"   ]] && continue
    if [[ -n "$filter_type" ]]; then
      case "$filter_type" in
        fp)        [[ "$type_prefix" == "FP" ]] || continue ;;
        known-gap|kg) [[ "$type_prefix" == "KG" ]] || continue ;;
        *) die "unknown --type: $filter_type" ;;
      esac
    fi
    printf "%-7s %-9s %-7s %-7s %s\n" "$id" "$status" "$sev" "$area" "$title"
  done
}

cmd_next_id() {
  local kind="${1:-}"
  [[ -z "$kind" ]] && die "usage: tickets.sh next-id <fp|kg>"
  require_registry
  local prefix
  case "$kind" in
    fp) prefix="FP" ;;
    kg|known-gap) prefix="KG" ;;
    *) die "unknown kind: $kind" ;;
  esac
  local max
  max=$(extract_rows | col 1 | awk -v p="$prefix" '
    $0 ~ "^" p "-[0-9]+$" {
      n = substr($0, length(p) + 2) + 0
      if (n > max) max = n
    }
    END { print max + 0 }
  ')
  printf "%s-%02d\n" "$prefix" $((max + 1))
}

cmd_check() {
  require_registry
  local tmp_errors
  tmp_errors=$(mktemp)

  # 1. 중복 ID
  local dupes
  dupes=$(extract_rows | col 1 | sort | uniq -d)
  if [[ -n "$dupes" ]]; then
    echo "✗ 중복 ID:" >&2
    echo "$dupes" | sed 's/^/  /' >&2
    echo "$dupes" | while read -r _; do echo x >> "$tmp_errors"; done
  fi

  # 2. 소스 파일 존재 + 3. ID 언급 확인 (한 루프로 처리, 서브셸 집계는 파일로)
  extract_rows | while IFS= read -r row; do
    id=$(echo "$row" | col 1)
    src_full=$(echo "$row" | col 6)
    src_path="${src_full%%#*}"
    if [[ ! -f "$REPO_ROOT/$src_path" ]]; then
      echo "✗ $id: source file missing — $src_path" >&2
      echo x >> "$tmp_errors"
      continue
    fi
    # spec 문서(#section anchor 있음)는 anchor 로 위치 특정되므로 ID 언급 불필요
    [[ "$src_full" == *"#"* ]] && continue
    if ! grep -qE "(^|[^A-Za-z0-9])${id}([^0-9]|$)" "$REPO_ROOT/$src_path" 2>/dev/null; then
      echo "✗ $id: 소스 문서에 ID 언급 없음 — $src_path" >&2
      echo x >> "$tmp_errors"
    fi
  done

  local err_count=0
  if [[ -s "$tmp_errors" ]]; then
    err_count=$(wc -l < "$tmp_errors" | tr -d ' ')
  fi

  rm -f "$tmp_errors"

  if [[ $err_count -eq 0 ]]; then
    local total
    total=$(extract_rows | wc -l | tr -d ' ')
    echo "✓ 정합성 OK ($total 개 티켓)"
    return 0
  else
    echo "" >&2
    echo "✗ 검증 실패: $err_count 건" >&2
    return 1
  fi
}

main() {
  local cmd="${1:-}"
  [[ -z "$cmd" ]] && die "usage: tickets.sh <list|next-id|check> [args]"
  shift
  case "$cmd" in
    list)    cmd_list "$@" ;;
    next-id) cmd_next_id "$@" ;;
    check)   cmd_check "$@" ;;
    *) die "unknown command: $cmd" ;;
  esac
}

main "$@"
