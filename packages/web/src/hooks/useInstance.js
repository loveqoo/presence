import { useState, useEffect, useCallback } from 'react'

const ORCHESTRATOR_URL = import.meta.env.VITE_ORCHESTRATOR_URL || null

const useInstance = () => {
  const [instances, setInstances] = useState([])
  const [selectedInstance, setSelectedInstance] = useState(null)
  const [loading, setLoading] = useState(true)

  // Restore from sessionStorage
  useEffect(() => {
    const saved = sessionStorage.getItem('presence:instance')
    if (saved) {
      try { setSelectedInstance(JSON.parse(saved)) } catch {}
    }

    // No orchestrator (production) → use current origin as instance
    if (!ORCHESTRATOR_URL) {
      setSelectedInstance({ id: 'default', url: window.location.origin })
      setLoading(false)
      return
    }

    // Fetch instances from orchestrator
    fetch(`${ORCHESTRATOR_URL}/api/instances`)
      .then(r => r.json())
      .then(list => {
        const running = list.filter(i => i.status === 'running').map(i => ({
          id: i.id, host: i.host, port: i.port,
          url: `http://${i.host === '0.0.0.0' ? '127.0.0.1' : i.host}:${i.port}`,
        }))
        setInstances(running)
        // Auto-select if only 1 instance
        if (running.length === 1 && !saved) {
          selectInstance(running[0])
        }
      })
      .catch(() => {
        // Orchestrator unreachable → fallback to current origin
        setSelectedInstance({ id: 'default', url: window.location.origin })
      })
      .finally(() => setLoading(false))
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
    instances,
    selectedInstance,
    instanceUrl: selectedInstance?.url || null,
    loading,
    selectInstance,
    clearInstance,
  }
}

export { useInstance }
