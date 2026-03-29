import { useState, useEffect, useCallback } from 'react'

const ORCHESTRATOR_URL = import.meta.env.VITE_ORCHESTRATOR_URL || null

/**
 * 인스턴스 연결 관리.
 * - 오케스트레이터 모드: GET /api/instances로 인스턴스 목록 조회, username 포함
 *   - 1개 → 자동 선택
 *   - N개 → 선택 필요
 * - 프로덕션 모드: GET /api/auth/status로 username 조회
 */
const useInstance = () => {
  const [instances, setInstances] = useState([])
  const [selectedInstance, setSelectedInstance] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const init = async () => {
      // sessionStorage에서 복원
      const saved = sessionStorage.getItem('presence:instance')
      if (saved) {
        try {
          const parsed = JSON.parse(saved)
          setSelectedInstance(parsed)
          setLoading(false)
          return
        } catch {}
      }

      if (!ORCHESTRATOR_URL) {
        // 프로덕션: 현재 origin이 인스턴스, /api/auth/status로 username 조회
        let username = null
        try {
          const res = await fetch(`${window.location.origin}/api/auth/status`)
          if (res.ok) {
            const data = await res.json()
            username = data.username || null
          }
        } catch {}
        const instance = { id: 'default', url: window.location.origin, username }
        setSelectedInstance(instance)
        setLoading(false)
        return
      }

      // 오케스트레이터 모드: 인스턴스 목록 조회
      try {
        const res = await fetch(`${ORCHESTRATOR_URL}/api/instances`)
        if (res.ok) {
          const data = await res.json()
          const list = (data.instances || data || []).map(inst => ({
            id: inst.id,
            host: inst.host || '127.0.0.1',
            port: inst.port,
            url: inst.url || `http://${inst.host || '127.0.0.1'}:${inst.port}`,
            username: inst.username || null,
          }))
          setInstances(list)
          if (list.length === 1) {
            // 단일 인스턴스 → 자동 선택
            setSelectedInstance(list[0])
            sessionStorage.setItem('presence:instance', JSON.stringify(list[0]))
          }
          // N개 → 선택 대기 (selectedInstance = null)
        }
      } catch {}

      setLoading(false)
    }

    init()
  }, [])

  const selectInstance = useCallback((instance) => {
    setSelectedInstance(instance)
    sessionStorage.setItem('presence:instance', JSON.stringify(instance))
  }, [])

  const clearInstance = useCallback(() => {
    setSelectedInstance(null)
    sessionStorage.removeItem('presence:instance')
  }, [])

  return {
    orchestratorUrl: ORCHESTRATOR_URL,
    instances,
    selectedInstance,
    instanceUrl: selectedInstance?.url || null,
    loading,
    selectInstance,
    clearInstance,
  }
}

export { useInstance }
