import { useState, useCallback, useRef } from 'react'

// =============================================================================
// useAuth: 인증 상태 관리
// - accessToken: 메모리 (React state) + sessionStorage (페이지 새로고침 복원)
// - refreshToken: 메모리 (React state) + sessionStorage
// - instanceUrl: 인스턴스별로 토큰 분리
// - 401 시 단일 refreshPromise로 동시성 제어
// =============================================================================

/**
 * React hook that manages authentication state for a specific instance.
 * Tokens are stored in sessionStorage keyed by instance URL for page refresh survival.
 * @param {string|null} instanceUrl - The base URL of the target instance
 * @returns {{accessToken: string|null, user: object|null, authRequired: boolean|null, isAuthenticated: boolean, checkAuthRequired: Function, login: Function, logout: Function, refresh: Function, authFetch: Function}}
 */
const useAuth = (instanceUrl) => {
  const storageKey = instanceUrl ? `presence:auth:${instanceUrl}` : null

  const restoreTokens = () => {
    if (!storageKey) return { accessToken: null, refreshToken: null, user: null }
    try {
      const saved = sessionStorage.getItem(storageKey)
      if (saved) return JSON.parse(saved)
    } catch {}
    return { accessToken: null, refreshToken: null, user: null }
  }

  const saved = restoreTokens()
  const [accessToken, setAccessToken] = useState(saved.accessToken)
  const [refreshToken, setRefreshToken] = useState(saved.refreshToken)
  const [user, setUser] = useState(saved.user)
  const [authRequired, setAuthRequired] = useState(null) // null = 확인 중
  const refreshPromiseRef = useRef(null)

  const saveTokens = useCallback((at, rt, u) => {
    if (!storageKey) return
    sessionStorage.setItem(storageKey, JSON.stringify({ accessToken: at, refreshToken: rt, user: u }))
  }, [storageKey])

  const clearTokens = useCallback(() => {
    if (!storageKey) return
    sessionStorage.removeItem(storageKey)
  }, [storageKey])

  // 서버 인증 요구 여부 확인 + 저장된 refresh token으로 자동 복원 시도
  // authRequired를 설정하기 전에 refresh를 시도 → LoginPage 깜빡임 방지
  const checkAuthRequired = useCallback(async () => {
    if (!instanceUrl) return
    try {
      const res = await fetch(`${instanceUrl}/api/instance`)
      const data = await res.json()
      const required = !!data.authRequired

      if (!required) {
        setAuthRequired(false)
        return false
      }

      // 인증 필요 → 저장된 refresh token으로 자동 복원 시도 (authRequired 설정 전)
      const storedTokens = restoreTokens()
      if (storedTokens.refreshToken) {
        try {
          const refreshRes = await fetch(`${instanceUrl}/api/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: storedTokens.refreshToken }),
          })
          if (refreshRes.ok) {
            const refreshData = await refreshRes.json()
            const newUser = { username: refreshData.username, roles: refreshData.roles || [] }
            setAccessToken(refreshData.accessToken)
            setRefreshToken(refreshData.refreshToken || storedTokens.refreshToken)
            setUser(newUser)
            saveTokens(refreshData.accessToken, refreshData.refreshToken || storedTokens.refreshToken, newUser)
          }
        } catch {}
      }

      setAuthRequired(true)
      return true
    } catch {
      setAuthRequired(false)
      return false
    }
  }, [instanceUrl, saveTokens])

  // 로그인
  const login = useCallback(async (username, password) => {
    if (!instanceUrl) return
    const res = await fetch(`${instanceUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || 'Login failed')
    }
    const data = await res.json()
    const newUser = { username: data.username, roles: data.roles }
    setAccessToken(data.accessToken)
    setRefreshToken(data.refreshToken || null)
    setUser(newUser)
    saveTokens(data.accessToken, data.refreshToken || null, newUser)
    return data
  }, [instanceUrl, saveTokens])

  // 로그아웃
  const logout = useCallback(async () => {
    if (!instanceUrl) return
    try {
      await fetch(`${instanceUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      })
    } catch {}
    setAccessToken(null)
    setRefreshToken(null)
    setUser(null)
    clearTokens()
  }, [instanceUrl, refreshToken, clearTokens])

  // Refresh (단일 promise 동시성 제어)
  const refresh = useCallback(async () => {
    if (!instanceUrl) return null
    if (refreshPromiseRef.current) return refreshPromiseRef.current

    refreshPromiseRef.current = (async () => {
      try {
        const currentRefreshToken = refreshToken
        if (!currentRefreshToken) throw new Error('No refresh token')
        const res = await fetch(`${instanceUrl}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: currentRefreshToken }),
        })
        if (!res.ok) throw new Error('Refresh failed')
        const data = await res.json()
        const newRefreshToken = data.refreshToken || currentRefreshToken
        setAccessToken(data.accessToken)
        setRefreshToken(newRefreshToken)
        saveTokens(data.accessToken, newRefreshToken, user)
        return data.accessToken
      } catch {
        // refresh 실패 → auth state 전체 clear
        setAccessToken(null)
        setRefreshToken(null)
        setUser(null)
        clearTokens()
        return null
      } finally {
        refreshPromiseRef.current = null
      }
    })()

    return refreshPromiseRef.current
  }, [instanceUrl, refreshToken, user, saveTokens, clearTokens])

  // 인증된 fetch (401 시 자동 refresh)
  const authFetch = useCallback(async (url, options = {}) => {
    if (!instanceUrl) return
    const headers = {
      ...options.headers,
      ...(accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {}),
    }
    const res = await fetch(url, { ...options, headers })

    if (res.status === 401 && accessToken) {
      const newToken = await refresh()
      if (newToken) {
        return fetch(url, {
          ...options,
          headers: { ...options.headers, 'Authorization': `Bearer ${newToken}` },
        })
      }
    }

    return res
  }, [instanceUrl, accessToken, refresh])

  return {
    accessToken,
    user,
    authRequired,
    isAuthenticated: !!accessToken,
    checkAuthRequired,
    login,
    logout,
    refresh,
    authFetch,
  }
}

export { useAuth }
