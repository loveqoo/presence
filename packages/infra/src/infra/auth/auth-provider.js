import bcrypt from 'bcryptjs'
import fp from '@presence/core/lib/fun-fp.js'

const { Either, Task } = fp

// =============================================================================
// AuthProvider: 인증 제공자 인터페이스 + Local 구현
// LDAP 확장 시 동일 인터페이스로 createLdapAuthProvider 추가
//
// authenticate(username, password) → Task(Either)
//   fork(onError, onResult) where onResult = Either.Right(user) | Either.Left('Invalid credentials')
// =============================================================================

/**
 * Creates a local (bcrypt) authentication provider backed by a UserStore.
 * @param {object} userStore - UserStore instance with findUser()
 * @returns {{ type: 'local', authenticate: (username, password) => Task<Either> }}
 */
const INVALID = Either.Left('Invalid credentials')
const DUMMY_HASH = '$2b$12$invalidhashpaddingtopreventsideeffects'

/**
 * Creates a local (bcrypt) authentication provider backed by a UserStore.
 * @param {object} userStore - UserStore instance with findUser()
 * @returns {{ type: 'local', authenticate: (username, password) => Task<Either> }}
 */

const createLocalAuthProvider = (userStore) => ({
  type: 'local',

  // () → Task(Either.Right(user) | Either.Left(error))
  authenticate: (username, password) =>
    Task.fromPromise(() => {
      if (!username || !password) return Promise.resolve(INVALID)

      const user = userStore.findUser(username)
      if (!user) {
        // 타이밍 공격 방지: 사용자가 없어도 bcrypt.compare 수행
        return bcrypt.compare(password, DUMMY_HASH).then(() => INVALID)
      }

      return bcrypt.compare(password, user.passwordHash).then(match =>
        match
          ? Either.Right({ username: user.username, roles: user.roles, tokenVersion: user.tokenVersion })
          : INVALID
      )
    })(),
})

export { createLocalAuthProvider }
