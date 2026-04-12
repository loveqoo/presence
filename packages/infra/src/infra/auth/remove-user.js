import { existsSync, rmSync } from 'node:fs'

// =============================================================================
// removeUserCompletely: 유저 완전 삭제 (KG-04 해소)
//
// 3 단계:
//   1. Memory (mem0) 에서 userId 기준 데이터 전량 삭제 — best effort
//   2. {presenceDir}/users/{username}/ 디렉토리 재귀 삭제
//   3. users.json 에서 레코드 제거
//
// memory 인스턴스가 null 이면 1 단계는 건너뛴다 (embed credentials 없는 환경).
// memory.clearAll 이 throw 해도 best effort 로 나머지 단계는 계속 진행.
// =============================================================================

const removeUserCompletely = async ({ store, memory, username, userDir }) => {
  if (!store.findUser(username)) {
    throw new Error(`User not found: ${username}`)
  }

  let memoryCount = 0
  if (memory) {
    try { memoryCount = await memory.clearAll(username) }
    catch (_) { /* best effort — memory backend 장애로 store 정리를 막지 않는다 */ }
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
