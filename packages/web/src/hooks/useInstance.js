import { useState, useEffect, useCallback } from 'react'

const ORCHESTRATOR_URL = import.meta.env.VITE_ORCHESTRATOR_URL || null

/**
 * 인스턴스 연결 관리.
 * - 오케스트레이터 모드: 로그인 시 오케스트레이터가 인스턴스를 자동 결정
 * - 프로덕션 모드: window.location.origin이 인스턴스 URL
 */
const useInstance = () => {
  const [selectedInstance, setSelectedInstance] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // sessionStorage에서 복원
    const saved = sessionStorage.getItem('presence:instance')
    if (saved) {
      try { setSelectedInstance(JSON.parse(saved)) } catch {}
    }

    // 프로덕션 (오케스트레이터 없음) → 현재 origin이 인스턴스
    if (!ORCHESTRATOR_URL) {
      setSelectedInstance({ id: 'default', url: window.location.origin })
    }

    setLoading(false)
  }, [])

  // 오케스트레이터 경유 로그인 — 인스턴스 자동 결정
  const login = useCallback(async (username, password) => {
    if (!ORCHESTRATOR_URL) {
      // 프로덕션: 인스턴스에 직접 로그인
      return null
    }

    const res = await fetch(`${ORCHESTRATOR_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || 'Login failed')
    }
    const data = await res.json()
    const instance = { id: data.instanceId, url: data.instanceUrl }
    setSelectedInstance(instance)
    sessionStorage.setItem('presence:instance', JSON.stringify(instance))
    return data
  }, [])

  const clearInstance = useCallback(() => {
    setSelectedInstance(null)
    sessionStorage.removeItem('presence:instance')
  }, [])

  return {
    orchestratorUrl: ORCHESTRATOR_URL,
    selectedInstance,
    instanceUrl: selectedInstance?.url || null,
    loading,
    login,
    clearInstance,
  }
}

export { useInstance }
