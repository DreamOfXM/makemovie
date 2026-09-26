'use client'

import { Suspense, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import type { Project } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { UsagePanel } from '@/components/shotboard/usage-panel'

/**
 * The ledger at whichever scope the URL names: one episode, one project, or the whole space.
 * Which projects a space spent its units on is the question the space view answers, so the
 * breakdown table is rendered by UsagePanel instead of being repeated here.
 */
function UsagePageInner() {
  const { t } = useI18n()
  const { api, organizationId } = useSession()
  const params = useSearchParams()
  const projectId = params.get('project')
  const episodeId = params.get('episode')

  const loadProjects = useCallback(() => api<Project[]>('/projects'), [api, organizationId])
  const projects = useAsync<Project[]>(projectId ? loadProjects : null, [])
  const project = projects.data.find(item => item.id === projectId) ?? null

  return (
    <>
      <PageHeader
        title={t('usage.title')}
        description={t('usage.unitsHint')}
        actions={project ? <span className="text-muted-foreground text-sm">{t('usage.projectScope', { name: project.name })}</span> : undefined}
      />

      <UsagePanel episodeId={episodeId} projectId={projectId} scopeFromUrl showTitle={false} />
    </>
  )
}

export default function UsagePage() {
  return (
    <Suspense fallback={<Skeleton className="h-64" />}>
      <UsagePageInner />
    </Suspense>
  )
}
