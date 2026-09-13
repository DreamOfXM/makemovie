'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { can, type Action, type Role } from '@studio/domain'
import { ApiError, getToken, request, setToken as persistToken, type MeResponse } from '@/lib/api'

export type SessionStatus = 'loading' | 'anonymous' | 'authenticated'

interface SessionContextValue {
  status: SessionStatus
  token: string | null
  me: MeResponse | null
  role: Role | null
  organizationId: string | null
  organizationName: string | null
  /** Shared RBAC policy from @studio/domain — the same predicate the API enforces. */
  can(action: Action): boolean
  /** Injects the bearer token and drops the session on a 401. */
  api<T>(path: string, init?: RequestInit): Promise<T>
  signIn(token: string): Promise<MeResponse>
  signOut(): Promise<void>
  switchOrganization(organizationId: string): Promise<void>
  refresh(): Promise<void>
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(null)
  const [me, setMe] = useState<MeResponse | null>(null)
  const [status, setStatus] = useState<SessionStatus>('loading')

  const clear = useCallback(() => {
    persistToken(null)
    setTokenState(null)
    setMe(null)
    setStatus('anonymous')
  }, [])

  const loadMe = useCallback(async (current: string): Promise<MeResponse> => {
    const profile = await request<MeResponse>('/auth/me', { token: current })
    setMe(profile)
    setTokenState(current)
    setStatus('authenticated')
    return profile
  }, [])

  useEffect(() => {
    const saved = getToken()
    if (!saved) {
      setStatus('anonymous')
      return
    }
    loadMe(saved).catch(clear)
  }, [loadMe, clear])

  const signIn = useCallback(
    async (nextToken: string) => {
      persistToken(nextToken)
      return loadMe(nextToken)
    },
    [loadMe],
  )

  const signOut = useCallback(async () => {
    if (token) {
      try {
        await request('/auth/logout', { method: 'POST', token })
      } catch {
        // The session may already be revoked server-side; signing out locally is enough.
      }
    }
    clear()
  }, [token, clear])

  const switchOrganization = useCallback(
    async (organizationId: string) => {
      const result = await request<{ token: string }>('/auth/switch-organization', {
        method: 'POST',
        body: JSON.stringify({ organizationId }),
        token,
      })
      persistToken(result.token)
      await loadMe(result.token)
    },
    [token, loadMe],
  )

  const refresh = useCallback(async () => {
    const current = token ?? getToken()
    if (!current) {
      clear()
      return
    }
    await loadMe(current).catch(clear)
  }, [token, loadMe, clear])

  const api = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      try {
        return await request<T>(path, { ...init, token })
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) clear()
        throw error
      }
    },
    [token, clear],
  )

  const organizationId = me?.organization.id ?? null
  const organizationName = useMemo(
    () => me?.memberships.find(item => item.organizationId === me.organization.id)?.organizationName ?? null,
    [me],
  )
  const role = (me?.organization.role ?? null) as Role | null

  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      token,
      me,
      role,
      organizationId,
      organizationName,
      can: action => (role ? can(role, action) : false),
      api,
      signIn,
      signOut,
      switchOrganization,
      refresh,
    }),
    [status, token, me, role, organizationId, organizationName, api, signIn, signOut, switchOrganization, refresh],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext)
  if (!context) throw new Error('useSession must be used inside SessionProvider')
  return context
}
