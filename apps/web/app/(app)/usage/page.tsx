'use client'

import { Suspense, useCallback } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ArrowLeftIcon } from 'lucide-react'
import type { Project } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { UsagePanel } from '@/components/shotboard/usage-panel'

/**
 * The ledger at space scope, or at one project's scope when the URL names a project. Which
 * projects a space spent its units on is the question this screen exists to answer, so the
 * breakdown table is rendered by UsagePanel instead of being repeated here.
 */
function UsagePageInner() {
  const { t } = useI18n()
  const { api, organizationId } = useSession()
  const projectId = useSearchParams().get('project')

  const loadProjects = useCallback(() => api<Project[]>('/projects'), [api, organizationId])
  const projects = useAsync<Project[]>(projectId ? loadProjects : null, [])
  const project = projects.data.find(item => item.id === projectId) ?? null

  return (
    <>
      <PageHeader title={t('usage.title')} />

      {projectId && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-medium">
            {project ? t('usage.projectScope', { name: project.name }) : t('common.loading')}
          </p>
          <Link
            href="/usage"
            className="text-muted-foreground hover:text-foreground -ml-1 inline-flex items-center gap-1.5 px-1 text-sm transition-colors"
          >
            <ArrowLeftIcon className="size-4" />
            {t('usage.allProjects')}
          </Link>
        </div>
      )}

      <UsagePanel projectId={projectId} showTitle={false} />
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
