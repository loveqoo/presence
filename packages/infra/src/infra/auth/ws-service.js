import fp from '@presence/core/lib/fun-fp.js'
import { AUTH_ERROR, AuthError, toPrincipal } from './policy.js'
import { AuthService } from './service.js'

const { Either } = fp

// =============================================================================
// WsAuthService: WebSocket 인증.
// AuthService 서브클래스 — header → query → cookie fallback 체인.
//
// fallback 규칙:
//   부재 (AUTH_ERROR.NO_TOKEN) → 다음 경로 시도
//   실패 (TOKEN_REVOKED, TOKEN_INVALIDATED 등) → 즉시 반환, fallback 중단
// =============================================================================

const ABSENCE_CODE = AUTH_ERROR.NO_TOKEN

// Cookie 파싱 (WS upgrade request는 cookie-parser 미적용)
const parseCookies = (cookieStr) => {
  const cookies = {}
  for (const pair of cookieStr.split(';')) {
    const [key, ...rest] = pair.trim().split('=')
    if (key) cookies[key] = rest.join('=')
  }
  return cookies
}

// 부재인지 실패인지 판별
const isAbsence = (authError) => authError.code === ABSENCE_CODE

class WsAuthService extends AuthService {
  // --- virtual 구현 ---

  extractPrincipal(req) {
    // 1. Authorization header (access token)
    const headerResult = this.#tryHeader(req)
    if (Either.isRight(headerResult)) return headerResult
    const headerError = Either.fold(e => e, () => null, headerResult)
    if (!isAbsence(headerError)) return headerResult

    // 2. Query param (access token)
    const queryResult = this.#tryQuery(req)
    if (Either.isRight(queryResult)) return queryResult
    const queryError = Either.fold(e => e, () => null, queryResult)
    if (!isAbsence(queryError)) return queryResult

    // 3. Cookie (refresh token)
    const cookieResult = this.#tryCookie(req)
    if (Either.isRight(cookieResult)) return cookieResult
    const cookieError = Either.fold(e => e, () => null, cookieResult)
    if (!isAbsence(cookieError)) return cookieResult

    // 모든 경로 부재
    return Either.Left(AuthError(AUTH_ERROR.NO_TOKEN, 'No valid authentication'))
  }

  extractRefreshToken(req) {
    const cookies = parseCookies(req.headers.cookie || '')
    return cookies.refreshToken || null
  }

  gate(principal, /* req */) {
    if (principal.mustChangePassword === true) {
      return Either.Left(AuthError(AUTH_ERROR.PASSWORD_CHANGE_REQUIRED, 'Password change required'))
    }
    return Either.Right(principal)
  }

  // --- WS 전용 ---

  // resolveAuth 래핑 → Either<AuthError, Principal>
  authenticateUpgrade(req) {
    return this.resolveAuth(req)
  }

  // --- private: fallback 전략 ---

  #tryHeader(req) {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return Either.Left(AuthError(AUTH_ERROR.NO_TOKEN, 'No auth header'))
    }
    return Either.fold(
      error => Either.Left(error),
      payload => toPrincipal(payload),
      this.verifyAccess(authHeader.slice(7)),
    )
  }

  #tryQuery(req) {
    const url = req.url || ''
    const idx = url.indexOf('?')
    if (idx === -1) return Either.Left(AuthError(AUTH_ERROR.NO_TOKEN, 'No token query param'))
    const params = new URLSearchParams(url.slice(idx + 1))
    const token = params.get('token')
    if (!token) return Either.Left(AuthError(AUTH_ERROR.NO_TOKEN, 'No token query param'))
    return Either.fold(
      error => Either.Left(error),
      payload => toPrincipal(payload),
      this.verifyAccess(token),
    )
  }

  #tryCookie(req) {
    const cookies = parseCookies(req.headers.cookie || '')
    if (!cookies.refreshToken) return Either.Left(AuthError(AUTH_ERROR.NO_TOKEN, 'No refresh cookie'))

    return Either.fold(
      error => Either.Left(error),
      validated => toPrincipal(validated.user),
      this.validateRefreshChain(cookies.refreshToken),
    )
  }
}

export { WsAuthService, parseCookies }
