import { useState, useCallback, useRef } from 'react'

// =============================================================================
// useAuth: 인증 상태 관리
// - accessToken: 메모리 (React state)
// - refreshToken: HttpOnly 쿠키 (서버가 설정, JS 접근 불가)
// - 401 시 단일 refreshPromise로 동시성 제어
// =============================================================================

const useAuth = () => {
  const [accessToken, setAccessToken] = useState(null)
  const [user, setUser] = useState(null)
  const [authRequired, setAuthRequired] = useState(null) // null = 확인 중
  const refreshPromiseRef = useRef(null)

  // 서버 인증 요구 여부 확인 + 쿠키의 refresh token으로 자동 복원 시도
  // authRequired를 설정하기 전에 refresh를 시도 → LoginPage 깜빡임 방지
  const checkAuthRequired = useCallback(async () => {
    try {
      const res = await fetch('/api/instance')
      const data = await res.json()
      const required = !!data.authRequired

      if (!required) {
        setAuthRequired(false)
        return false
      }

      // 인증 필요 → refresh 쿠키로 자동 복원 시도 (authRequired 설정 전)
      try {
        const refreshRes = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
        })
        if (refreshRes.ok) {
          const refreshData = await refreshRes.json()
          setAccessToken(refreshData.accessToken)
          setUser({ username: refreshData.username, roles: refreshData.roles || [] })
        }
      } catch {}

      setAuthRequired(true)
      return true
    } catch {
      setAuthRequired(false)
      return false
    }
  }, [])

  // 로그인
  const login = useCallback(async (username, password) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      credentials: 'include', // 쿠키 수신
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || 'Login failed')
    }
    const data = await res.json()
    setAccessToken(data.accessToken)
    setUser({ username: data.username, roles: data.roles })
    return data
  }, [])

  // 로그아웃
  // logout은 public 경로 — access token 불필요, refresh 쿠키만으로 서버 정리
  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include', // refresh 쿠키 전송
      })
    } catch {}
    setAccessToken(null)
    setUser(null)
  }, [])

  // Refresh (단일 promise 동시성 제어)
  const refresh = useCallback(async () => {
    if (refreshPromiseRef.current) return refreshPromiseRef.current

    refreshPromiseRef.current = (async () => {
      try {
        const res = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include', // HttpOnly 쿠키 전송
        })
        if (!res.ok) throw new Error('Refresh failed')
        const data = await res.json()
        setAccessToken(data.accessToken)
        return data.accessToken
      } catch {
        // refresh 실패 → auth state 전체 clear
        setAccessToken(null)
        setUser(null)
        return null
      } finally {
        refreshPromiseRef.current = null
      }
    })()

    return refreshPromiseRef.current
  }, [])

  // 인증된 fetch (401 시 자동 refresh)
  const authFetch = useCallback(async (url, options = {}) => {
    const headers = {
      ...options.headers,
      ...(accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {}),
    }
    const res = await fetch(url, { ...options, headers, credentials: 'include' })

    if (res.status === 401 && accessToken) {
      const newToken = await refresh()
      if (newToken) {
        return fetch(url, {
          ...options,
          headers: { ...options.headers, 'Authorization': `Bearer ${newToken}` },
          credentials: 'include',
        })
      }
    }

    return res
  }, [accessToken, refresh])

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
