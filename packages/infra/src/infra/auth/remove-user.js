import { existsSync, rmSync } from 'node:fs'

// =============================================================================
// removeUserCompletely: 유저 완전 삭제 (KG-04 해소 + data-scope-alignment)
//
// 3 단계:
//   1. Memory (mem0) 에서 각 agentId 기준 데이터 전량 삭제 — best effort
//   2. {presenceDir}/users/{username}/ 디렉토리 재귀 삭제
//   3. users.json 에서 레코드 제거
//
// memory 인스턴스가 null 또는 agentIds 가 빈 배열이면 1 단계는 건너뛴다.
// memory.clearAll 이 throw 해도 best effort 로 나머지 단계는 계속 진행.
//
// agentIds orphan 정책 (docs/design/data-scope-alignment.md §9):
//   - 호출처가 현재 config 에 등록된 agent 이름으로 agentIds 를 구성한다.
//   - 과거에 존재했다가 제거/rename 된 agent 의 mem0 orphan 은 삭제되지 않는다.
//   - 같은 agent name 재생성 시 동일 qualified key 로 재조회될 수 있다
//     ("영구 미조회" 가 아닌 "같은 이름 재사용 전까지 미조회").
// =============================================================================

const removeUserCompletely = async ({ store, memory, username, userDir, agentIds = [] }) => {
  if (!store.findUser(username)) {
    throw new Error(`User not found: ${username}`)
  }

  let memoryCount = 0
  if (memory && agentIds.length > 0) {
    for (const agentId of agentIds) {
      try { memoryCount += await memory.clearAll(agentId) }
      catch (_) { /* best effort — 개별 agent 실패는 나머지 agent 정리를 막지 않는다 */ }
    }
  }

  let dirRemoved = false
  if (userDir && existsSync(userDir)) {
    rmSync(userDir, { recursive: true, force: true })
    dirRemoved = true
  }

  store.removeUser(username)
  return { memoryCount, dirRemoved }
}

export { removeUserCompletely }
