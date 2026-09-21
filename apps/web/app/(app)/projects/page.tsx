'use client'

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowRightIcon, ClapperboardIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import type { WorkflowStatus } from '@studio/domain'
import { toWorkflowStatus, type Project } from '@/lib/api'
import { translateEnum, useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { cn, relativeTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/ui/status-badge'
import { ErrorState } from '@/components/error-state'
import { GuardedButton, usePermission } from '@/components/permission'
import { ProjectDialog, type ProjectDialogState } from '@/components/episode/production-dialogs'

/** Statuses that mean a human owes this episode a decision, worst first. */
const decisionStatuses: WorkflowStatus[] = ['blocked', 'needs_review']

const lifecycleFill: Record<WorkflowStatus, string> = {
  draft: 'bg-border',
  ready: 'bg-info',
  running: 'bg-info',
  needs_review: 'bg-warning',
  approved: 'bg-success',
  blocked: 'bg-destructive',
  // Shipped episodes recede; the green that matters is the one awaiting review downstream.
  completed: 'bg-success/40',
  cancelled: 'bg-muted-foreground/40',
}

const lifecycleInk: Record<WorkflowStatus, string> = {
  draft: 'text-muted-foreground',
  ready: 'text-info-ink',
  running: 'text-info-ink',
  needs_review: 'text-warning-ink',
  approved: 'text-success-ink',
  blocked: 'text-destructive-ink',
  completed: 'text-success-ink',
  cancelled: 'text-muted-foreground',
}

const barStatuses: WorkflowStatus[] = ['draft', 'running', 'needs_review', 'approved', 'completed', 'blocked']

/**
 * The space surface: one row per project, each carrying the lifecycle of its season, so the
 * screen answers "what is waiting on me today" before anything is opened. Choosing a project
 * is navigation rather than local state — the project surface owns the episodes.
 */
export default function ProjectsPage() {
  const { t, locale } = useI18n()
  const { api, organizationId } = useSession()
  const { can } = usePermission()

  const loadProjects = useCallback(() => api<Project[]>('/projects'), [api, organizationId])
  const projects = useAsync<Project[]>(loadProjects, [])

  const [projectDialog, setProjectDialog] = useState<ProjectDialogState>(null)
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)
  const [deleting, setDeleting] = useState(false)

  // One pass over the episode summaries is enough to know what is stuck: the list endpoint
  // carries each episode's status, so this screen never drills into a project to draw itself.
  const queue = useMemo(() => {
    const waiting: { projectId: string; projectName: string; episodeId: string; label: string; status: WorkflowStatus }[] = []
    for (const project of projects.data) {
      for (const episode of project.episodes ?? []) {
        const status = toWorkflowStatus(episode.status)
        if (!decisionStatuses.includes(status)) continue
        waiting.push({
          projectId: project.id,
          projectName: project.name,
          episodeId: episode.id,
          label: `EP${episode.number} ${episode.title}`,
          status,
        })
      }
    }
    // A blocked episode has stopped the line; a review only waits on one click.
    return waiting.sort((a, b) => decisionStatuses.indexOf(b.status) - decisionStatuses.indexOf(a.status))
  }, [projects.data])

  async function removeProject(project: Project) {
    setDeleting(true)
    try {
      await api(`/projects/${project.id}`, { method: 'DELETE' })
      toast.success(t('projects.deleted', { name: project.name }))
      setDeleteTarget(null)
      projects.reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <PageHeader
        title={t('projects.title')}
        description={t('projects.subtitle')}
        actions={
          <GuardedButton action="project:create" onClick={() => setProjectDialog({ mode: 'create' })}>
            <PlusIcon />
            {t('projects.new')}
          </GuardedButton>
        }
      />

      {projects.error && <ErrorState message={projects.error} onRetry={projects.reload} />}

      {queue.length > 0 && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 py-4">
            <p className="text-sm font-medium">{t('projects.waitingCount', { count: queue.length })}</p>
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {queue.slice(0, 3).map(item => (
                <Link
                  key={item.episodeId}
                  href={`/projects/${item.projectId}/episodes/${item.episodeId}`}
                  className="hover:bg-accent rounded-md px-2 py-1 text-sm transition-colors"
                >
                  <span className="text-primary font-medium">{item.projectName}</span>
                  <span className="text-muted-foreground"> · {item.label}</span>
                </Link>
              ))}
            </div>
            <Button asChild size="sm" variant="outline" className="ml-auto">
              <Link href={`/projects/${queue[0].projectId}/episodes/${queue[0].episodeId}`}>
                {t('projects.handleFirst')}
                <ArrowRightIcon />
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="border-b [.border-b]:pb-4">
          <CardTitle>{t('projects.lifecycleTitle')}</CardTitle>
          <CardDescription>{t('projects.lifecycleHint')}</CardDescription>
          <CardAction>
            <LifecycleLegend />
          </CardAction>
        </CardHeader>

        {projects.loading && projects.data.length === 0 ? (
          <CardContent className="space-y-4">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </CardContent>
        ) : projects.data.length === 0 ? (
          <CardContent>
            <EmptyState
              icon={<ClapperboardIcon />}
              title={t('projects.emptyTitle')}
              description={t('projects.emptyHint')}
              action={
                can('project:create') ? (
                  <Button size="sm" onClick={() => setProjectDialog({ mode: 'create' })}>
                    <PlusIcon />
                    {t('projects.new')}
                  </Button>
                ) : undefined
              }
            />
          </CardContent>
        ) : (
          <CardContent className="p-0">
            <ul className="divide-border divide-y">
              {projects.data.map(project => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  locale={locale}
                  canUpdate={can('project:update')}
                  canDelete={can('project:delete')}
                  onRename={() => setProjectDialog({ mode: 'rename', project })}
                  onDelete={() => setDeleteTarget(project)}
                />
              ))}
            </ul>
          </CardContent>
        )}
      </Card>

      <ProjectDialog
        state={projectDialog}
        onOpenChange={open => !open && setProjectDialog(null)}
        onDone={(mode, name) => {
          setProjectDialog(null)
          projects.reload()
          toast.success(mode === 'rename' ? t('projects.renamed') : t('projects.created', { name }))
        }}
      />

      <AlertDialog open={deleteTarget !== null} onOpenChange={open => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('projects.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('projects.deleteBody', { name: deleteTarget?.name ?? '' })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleting}
              onClick={event => {
                event.preventDefault()
                if (deleteTarget) void removeProject(deleteTarget)
              }}
            >
              {deleting ? t('common.loading') : t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** The bar's colour vocabulary, stated once per screen instead of once per row. */
function LifecycleLegend() {
  const { t } = useI18n()
  return (
    <div className="text-muted-foreground hidden flex-wrap items-center gap-3 text-xs lg:flex">
      {barStatuses.map(status => (
        <span key={status} className="flex items-center gap-1.5">
          <span className={cn('size-2 rounded-full', lifecycleFill[status])} />
          {t(`status.${status}`)}
        </span>
      ))}
    </div>
  )
}

interface ProjectRowProps {
  project: Project
  locale: string
  canUpdate: boolean
  canDelete: boolean
  onRename(): void
  onDelete(): void
}

function ProjectRow({ project, locale, canUpdate, canDelete, onRename, onDelete }: ProjectRowProps) {
  const router = useRouter()
  const { t } = useI18n()
  const episodes = [...(project.episodes ?? [])].sort((a, b) => a.number - b.number)
  const statuses = episodes.map(episode => toWorkflowStatus(episode.status))
  const completed = statuses.filter(status => status === 'completed').length
  const waiting = statuses.filter(status => decisionStatuses.includes(status)).length
  // Where the season stands is its last episode that has not shipped. A project
  // with no episodes yet has shipped nothing, so it reads as draft — not done.
  const head = statuses.filter(status => status !== 'completed').at(-1) ?? (statuses.length === 0 ? 'draft' : 'completed')
  const projectStatus = toWorkflowStatus(project.status)

  return (
    // The whole row opens the project: users click the name, the band, the empty
    // space — aiming at a text-sized link inside a full-width row loses every time.
    <li
      className="group/project flex cursor-pointer flex-col gap-3 px-5 py-4 transition-colors hover:bg-accent/40 sm:flex-row sm:items-center sm:gap-6"
      onClick={() => router.push(`/projects/${project.id}`)}
    >
      <div className="min-w-0 sm:w-56 sm:shrink-0">
        <Link href={`/projects/${project.id}`} className="hover:text-primary block truncate text-[15px] font-semibold transition-colors">
          {project.name}
        </Link>
        <p className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
          <StatusBadge status={projectStatus} label={t(`status.${projectStatus}`)} className="h-5 shrink-0 px-1.5 text-[11px]" />
          <span className="truncate">
            {t('projects.episodeSummary', {
              total: episodes.length,
              done: completed,
              language: translateEnum(t, 'projects.contentLocale', project.contentLocale),
            })}
          </span>
        </p>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="bg-muted flex h-2 min-w-0 flex-1 items-center gap-px overflow-hidden rounded-full">
            {episodes.map((episode, index) => (
              <Link
                key={episode.id}
                href={`/projects/${project.id}/episodes/${episode.id}`}
                title={`EP${episode.number} ${episode.title}`}
                className={cn('h-full flex-1 opacity-90 transition-opacity hover:opacity-100', lifecycleFill[statuses[index]])}
              >
                <span className="sr-only">{`EP${episode.number} ${episode.title} · ${t(`status.${statuses[index]}`)}`}</span>
              </Link>
            ))}
            {episodes.length === 0 && <span className="bg-border/40 h-full flex-1 rounded-full" />}
          </div>
          <span className={cn('w-24 shrink-0 truncate text-xs font-medium', lifecycleInk[head])}>{t(`status.${head}`)}</span>
        </div>
        <p className="text-muted-foreground mt-1.5 text-xs">
          {waiting > 0
            ? t('projects.waitingInProject', { count: waiting })
            : t('projects.updatedAt', { when: relativeTime(project.updatedAt, locale) })}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/projects/${project.id}`}>
            {t('projects.open')}
            <ArrowRightIcon />
          </Link>
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={t('projects.renameTitle')} disabled={!canUpdate} onClick={event => { event.stopPropagation(); onRename() }}>
          <PencilIcon />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={t('common.delete')} disabled={!canDelete} onClick={event => { event.stopPropagation(); onDelete() }}>
          <Trash2Icon className="text-muted-foreground group-hover/project:text-destructive" />
        </Button>
      </div>
    </li>
  )
}
