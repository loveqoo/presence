# 티켓 레지스트리 규칙

presence 는 `docs/tickets/REGISTRY.md` 하나에 모든 FP (UX 마찰점) 와 KG (스펙 Known Gap) 를 전역 유일 ID 로 통합해서 관리한다. 이 규칙은 에이전트/개발자가 티켓을 다룰 때 지켜야 할 절차다.

## 핵심 원칙

- **ID 는 전역 유일**: `FP-14` 는 presence 전체에서 단 하나. 파일별 로컬 번호 금지.
- **한번 부여된 ID 는 재사용 금지**: resolved / wontfix 도 번호 유지. 삭제하지 않는다.
- **레지스트리는 인덱스**: 본문은 `Source` 컬럼의 문서에 산다. 레지스트리는 ID 할당과 라이프사이클만 담당.
- **양방향 링크**: 레지스트리 → 소스 (Source 컬럼), 소스 → 레지스트리 (ID 가 제목 또는 본문 어디든 언급되어 있으면 됨).
- **스펙 불변식(I 항목) 은 레지스트리에 포함하지 않음**. I 는 라이프사이클 없는 선언이므로 스펙 문서에만 산다.

## 새 티켓 추가

```bash
# 1. 다음 ID 확인
scripts/tickets.sh next-id fp   # → FP-46

# 2. 소스 문서에 새 항목 추가 + (REGISTRY: FP-46) 표기
# 3. REGISTRY.md 테이블에 한 줄 추가
# 4. 같은 커밋으로 묶음
```

커밋 메시지: `docs(tickets): FP-46 추가 — 제목 요약`

## 기존 티켓 상태 변경

**resolved 로 전환**:
- REGISTRY.md 에서 `status: open` → `resolved`
- 소스 문서에도 "해소됨" 또는 "resolved" 표기
- 통계 섹션의 카운트도 함께 업데이트

**wontfix**: 동일하게 양쪽 갱신.

## 검증

커밋 전 자동으로 `scripts/tickets.sh check` 가 실행된다 (`.claude/hooks/check-tickets.sh`). 실패 시:

- `중복 ID`: 같은 번호가 두 번 등장. 하나를 `next-id` 로 재부여.
- `source file missing`: 레지스트리의 Source 경로가 실존하지 않음. 경로 수정 또는 레지스트리 항목 제거.
- `ID 언급 없음`: 소스 문서에 해당 FP/KG ID 가 등장하지 않음. 제목 또는 본문에 ID 추가.

## 멀티 에이전트 충돌 대응

- **동시 추가**: 두 브랜치가 같은 `FP-46` 을 부여하면 머지 시 REGISTRY.md 에서 conflict 발생. 두 번째 머지하는 쪽이 `next-id` 를 다시 돌려 새 번호로 재부여 + 소스 문서 ID 도 갱신.
- **동시 상태 변경**: 드물지만 발생 시 REGISTRY.md 충돌로 노출되므로 수동 해결.

## 금지

- ❌ 로컬 번호 부여 (`docs/ux/foo.md` 안에서만 쓰는 FP-1 같은 것)
- ❌ 레지스트리 건너뛰고 소스 문서에만 항목 추가
- ❌ resolved 항목을 레지스트리에서 삭제 (이력 손실)
- ❌ 스펙 불변식(I 항목) 을 레지스트리에 추가
