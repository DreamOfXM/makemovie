'use client'

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'

export interface AsyncState<T> {
  data: T
  error: string | null
  loading: boolean
  reload(): void
  mutate: Dispatch<SetStateAction<T>>
}

/**
 * Runs `loader` whenever its identity changes and keeps the previous payload
 * while a refresh is in flight, so tables never flash back to their empty state.
 * Pass `null` to skip the request until a prerequisite (such as a selected row)
 * exists.
 */
export function useAsync<T>(loader: (() => Promise<T>) | null, fallback: T): AsyncState<T> {
  const [data, setData] = useState<T>(fallback)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(loader !== null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!loader) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    loader()
      .then(result => {
        if (cancelled) return
        setData(result)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : 'Unexpected error')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [loader, nonce])

  const reload = useCallback(() => setNonce(value => value + 1), [])

  return { data, error, loading, reload, mutate: setData }
}
