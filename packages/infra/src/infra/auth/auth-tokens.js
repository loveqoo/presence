import fp from '@presence/core/lib/fun-fp.js'

const { Either, Reader } = fp

// =============================================================================
// Auth token operations (Reader 기반).
// Env: { tokenService, userStore }
// - issueTokensR(user)              → { accessToken, refreshToken, user }
// - validateRefreshChainR(token)    → Either<error, { user, jti }>
// - rotateRefreshTokenR(validated)  → { accessToken, refreshToken, user }
// =============================================================================

const issueTokensR = (user) =>
  Reader.asks(({ tokenService, userStore }) => {
    const accessToken = tokenService.signAccessToken({ sub: user.username, roles: user.roles, mustChangePassword: user.mustChangePassword || false })
    const { token: refreshToken, jti } = tokenService.signRefreshToken({
      sub: user.username,
      tokenVersion: user.tokenVersion,
    })
    userStore.addRefreshSession(user.username, jti)
    return { accessToken, refreshToken, user }
  })

// Refresh token 검증 + 세션/tokenVersion 확인. 탈취 감지 시 모든 세션 폐기.
const validateRefreshChainR = (refreshToken) =>
  Reader.asks(({ tokenService, userStore }) => {
    if (!refreshToken) return Either.Left('Refresh token required')

    return Either.fold(
      () => Either.Left('Invalid refresh token'),
      payload => {
        const { sub, jti, tokenVersion } = payload

        if (!userStore.hasRefreshSession(sub, jti)) {
          userStore.revokeAllRefreshSessions(sub)
          return Either.Left('Refresh token revoked (possible theft detected)')
        }

        const user = userStore.findUser(sub)
        if (!user || user.tokenVersion !== tokenVersion) {
          userStore.revokeAllRefreshSessions(sub)
          return Either.Left('Token invalidated (password changed)')
        }

        return Either.Right({ user, jti })
      },
      tokenService.verifyRefreshToken(refreshToken),
    )
  })

// Refresh rotation: 이전 세션 제거 + 새 토큰 발행.
const rotateRefreshTokenR = (validated) =>
  Reader.asks(({ userStore }) => userStore.removeRefreshSession(validated.user.username, validated.jti))
    .chain(() => issueTokensR(validated.user))

export { issueTokensR, validateRefreshChainR, rotateRefreshTokenR }
