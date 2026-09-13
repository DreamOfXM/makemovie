'use client'

import { useEffect, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from '@/lib/session'
import { AppShell } from '@/components/app-shell'
import { BootScreen } from '@/components/boot-screen'

export default function AppLayout({ children }: { children: ReactNode }) {
  const { status } = useSession()
  const router = useRouter()

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login')
  }, [status, router])

  if (status !== 'authenticated') return <BootScreen />

  return <AppShell>{children}</AppShell>
}
