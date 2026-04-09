import bcrypt from 'bcryptjs'
import fp from '@presence/core/lib/fun-fp.js'
import { AUTH, AUTH_ERROR, AuthError } from './policy.js'

const { Either, Task } = fp

// 타이밍 공격 방지: 사용자 미존재 시에도 bcrypt.compare 수행
const DUMMY_HASH = '$2b$12$invalidhashpaddingtopreventsideeffects'

// =============================================================================
// AuthService: 인증 코어 + Template Method.
//
// 코어 메서드: 전송 계층 무관. 토큰 발행/검증/갱신/폐기, 패스워드 변경.
// 템플릿 메서드: resolveAuth, refreshFlow — virtual 단계를 호출.
// virtual 메서드: 서브클래스(HTTP, WS)가 구현.
// =============================================================================

class AuthService {
  #tokenService
  #userStore

  constructor(tokenService, userStore) {
    this.#tokenService = tokenService
    this.#userStore = userStore
  }

  // --- 접근자 (서브클래스용) ---
  get tokenService() { return this.#tokenService }
  get userStore() { return this.#userStore }

  // --- 코어: 인증 ---

  // username/password → Task(Either<AuthError, user>)
  authenticate(username, password) {
    const INVALID = Either.Left(AuthError(AUTH_ERROR.INVALID_CREDENTIALS, 'Invalid credentials'))
    return Task.fromPromise(() => {
      if (!username || !password) return Promise.resolve(INVALID)

      const user = this.#userStore.findUser(username)
      if (!user) {
        // 타이밍 공격 방지: 사용자가 없어도 bcrypt.compare 수행
        return bcrypt.compare(password, DUMMY_HASH).then(() => INVALID)
      }

      return bcrypt.compare(password, user.passwordHash).then(match =>
        match
          ? Either.Right({ username: user.username, roles: user.roles, tokenVersion: user.tokenVersion, mustChangePassword: user.mustChangePassword || false })
          : INVALID,
      )
    })()
  }

  // --- 코어: 토큰 발행 ---

  // user → { accessToken, refreshToken, user }
  issueTokens(user) {
    const accessToken = this.#tokenService.signAccessToken({
      sub: user.username, roles: user.roles,
      mustChangePassword: user.mustChangePassword || false,
    })
    const { token: refreshToken, jti } = this.#tokenService.signRefreshToken({
      sub: user.username, tokenVersion: user.tokenVersion,
    })
    this.#userStore.addRefreshSession(user.username, jti)
    return { accessToken, refreshToken, user }
  }

  // --- 코어: 토큰 검증 ---

  // token → Either<AuthError, payload>
  verifyAccess(token) {
    if (!token) return Either.Left(AuthError(AUTH_ERROR.NO_TOKEN, 'No access token provided'))
    return Either.fold(
      err => Either.Left(this.#mapTokenError(err)),
      payload => Either.Right(payload),
      this.#tokenService.verifyAccessToken(token),
    )
  }

  // refreshToken → Either<AuthError, { user, jti }>
  validateRefreshChain(refreshToken) {
    if (!refreshToken) return Either.Left(AuthError(AUTH_ERROR.NO_TOKEN, 'Refresh token required'))

    return Either.fold(
      () => Either.Left(AuthError(AUTH_ERROR.INVALID_TOKEN, 'Invalid refresh token')),
      payload => {
        const { sub, jti, tokenVersion } = payload

        // 탈취 감지: 폐기된 jti → 모든 세션 삭제
        if (!this.#userStore.hasRefreshSession(sub, jti)) {
          this.#userStore.revokeAllRefreshSessions(sub)
          return Either.Left(AuthError(AUTH_ERROR.TOKEN_REVOKED, 'Refresh token revoked (possible theft detected)'))
        }

        const user = this.#userStore.findUser(sub)
        if (!user || user.tokenVersion !== tokenVersion) {
          this.#userStore.revokeAllRefreshSessions(sub)
          return Either.Left(AuthError(AUTH_ERROR.TOKEN_INVALIDATED, 'Token invalidated (password changed)'))
        }

        return Either.Right({ user, jti })
      },
      this.#tokenService.verifyRefreshToken(refreshToken),
    )
  }

  // --- 코어: 토큰 갱신 ---

  // validated({ user, jti }) → { accessToken, refreshToken, user }
  rotateRefresh(validated) {
    this.#userStore.removeRefreshSession(validated.user.username, validated.jti)
    return this.issueTokens(validated.user)
  }

  // --- 코어: 토큰 폐기 ---

  revokeRefresh(refreshToken) {
    if (!refreshToken) return
    Either.fold(
      () => {},
      payload => this.#userStore.removeRefreshSession(payload.sub, payload.jti),
      this.#tokenService.verifyRefreshToken(refreshToken),
    )
  }

  // --- 코어: 패스워드 변경 ---

  // 현재 비밀번호 검증 → 변경 → 토큰 재발급
  changePassword(username, currentPassword, newPassword) {
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < AUTH.MIN_PASSWORD_LENGTH) {
      return Task.of(Either.Left(AuthError(AUTH_ERROR.MISSING_FIELDS, `Password must be at least ${AUTH.MIN_PASSWORD_LENGTH} characters`)))
    }

    return this.authenticate(username, currentPassword)
      .chain(authResult => Either.fold(
        () => Task.of(Either.Left(AuthError(AUTH_ERROR.INVALID_CREDENTIALS, 'Invalid credentials'))),
        () => Task.fromPromise(() => this.#userStore.changePassword(username, newPassword))()
          .map(() => {
            const updatedUser = this.#userStore.findUser(username)
            return Either.Right(this.issueTokens(updatedUser))
          }),
        authResult,
      ))
  }

  // --- 템플릿: 요청 인증 ---

  resolveAuth(context) {
    const result = this.extractPrincipal(context)
    return Either.fold(
      error => Either.Left(error),
      principal => this.gate(principal, context),
      result,
    )
  }

  // --- 템플릿: 토큰 갱신 ---

  refreshFlow(context) {
    const refreshToken = this.extractRefreshToken(context)
    return Either.fold(
      error => Either.Left(error),
      validated => Either.Right(this.rotateRefresh(validated)),
      this.validateRefreshChain(refreshToken),
    )
  }

  // --- virtual (서브클래스 구현) ---

  extractPrincipal(/* context */) {
    throw new Error('AuthService.extractPrincipal: not implemented')
  }

  extractRefreshToken(/* context */) {
    throw new Error('AuthService.extractRefreshToken: not implemented')
  }

  extractCredentials(/* context */) {
    throw new Error('AuthService.extractCredentials: not implemented')
  }

  // 기본: pass-through
  gate(principal, /* context */) {
    return Either.Right(principal)
  }

  // --- private ---

  #mapTokenError(errorMessage) {
    if (errorMessage === 'token expired') return AuthError(AUTH_ERROR.TOKEN_EXPIRED, errorMessage)
    if (errorMessage === 'invalid signature') return AuthError(AUTH_ERROR.INVALID_TOKEN, errorMessage)
    return AuthError(AUTH_ERROR.INVALID_TOKEN, errorMessage)
  }
}

export { AuthService }
