import { useState, useEffect, useCallback } from 'react'

const SERVER_URL = import.meta.env.VITE_SERVER_URL || null

/**
 * 서버 연결 관리.
 * 프로덕션: 현재 origin이 서버 (same-origin)
 * 개발: VITE_SERVER_URL 환경변수로 서버 URL 지정
 */
const useInstance = () => {
  const [selectedInstance, setSelectedInstance] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const serverUrl = SERVER_URL || window.location.origin
    const instance = { id: 'default', url: serverUrl }
    setSelectedInstance(instance)
    setLoading(false)
  }, [])

  const clearInstance = useCallback(() => {
    const serverUrl = SERVER_URL || window.location.origin
    setSelectedInstance({ id: 'default', url: serverUrl })
  }, [])

  return {
    instances: [],
    selectedInstance,
    instanceUrl: selectedInstance?.url || null,
    loading,
    selectInstance: () => {},
    clearInstance,
  }
}

export { useInstance }
