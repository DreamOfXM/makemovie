'use client'

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowRightIcon, FilmIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import {
  isLiveStoryboard,
  toProjectFormat,
  toWorkflowStatus,
  type Episode,
  type Project,
} from '@/lib/api'
import { translateEnum, useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { cn, formatDateTime, relativeTime } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
import { StatusBadge } from '@/components/ui/status-badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { TableSkeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/error-state'
import { GuardedButton, usePermission } from '@/components/permission'
import { EpisodeDialog, ProjectDialog, type ProjectDialogState } from '@/components/episode/production-dialogs'
import { BookSplitPanel } from '@/components/sources/book-split-panel'

/**
 * The project surface: everything that belongs to a season rather than to one episode.
 * Rows link out to the production surface instead of embedding it, so this screen stays a
 * list you read rather than a workbench you scroll.
 */
export default function ProjectPage() {
  const { t, locale } = useI18n()
  const { api, organizationId } = useSession()
  const { can } = usePermission()
  const params = useParams<{ projectId: string }>()
  const projectId = params.projectId

  const loadProjects = useCallback(() => api<Project[]>('/projects'), [api, organizationId])
  const projects = useAsync<Project[]>(loadProjects, [])
  const project = projects.data.find(item => item.id === projectId) ?? null

  const loadEpisodes = useCallback(() => api<Episode[]>(`/projects/${projectId}/episodes`), [api, projectId])
  const episodes = useAsync<Episode[]>(loadEpisodes, [])

  const [projectDialog, setProjectDialog] = useState<ProjectDialogState>(null)
  const [episodeDialogOpen, setEpisodeDialogOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)
  const [deleting, setDeleting] = useState(false)

  const nextEpisodeNumber = useMemo(
    () => episodes.data.reduce((highest, episode) => Math.max(highest, episode.number), 0) + 1,
    [episodes.data],
  )
  const completed = episodes.data.filter(episode => toWorkflowStatus(episode.status) === 'completed').length
  // A film is locked to its single auto-created episode, so the "new episode"
  // entries would only ever bounce off episodes:filmLockedToOne.
  const isFilm = project !== null && toProjectFormat(project.format) === 'film'

  async function removeProject(target: Project) {
    setDeleting(true)
    try {
      await api(`/projects/${target.id}`, { method: 'DELETE' })
      toast.success(t('projects.deleted', { name: target.name }))
      setDeleteTarget(null)
      window.location.assign('/projects')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      setDeleting(false)
    }
  }

  if (projects.error) return <ErrorState message={projects.error} onRetry={projects.reload} />

  return (
    <>
      <PageHeader
        title={project?.name ?? t('common.loading')}
        description={
          project
            ? t('projects.summary', {
                contentLanguage: translateEnum(t, 'projects.contentLocale', project.contentLocale),
              })
            : undefined
        }
        actions={
          <>
            <GuardedButton
              action="project:update"
              variant="outline"
              onClick={() => project && setProjectDialog({ mode: 'rename', project })}
            >
              <PencilIcon />
              {t('projects.renameTitle')}
            </GuardedButton>
            {!isFilm && (
              <GuardedButton action="episode:write" onClick={() => setEpisodeDialogOpen(true)}>
                <PlusIcon />
                {t('projects.newEpisode')}
              </GuardedButton>
            )}
            {project && (
              <GuardedButton
                action="project:delete"
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => setDeleteTarget(project)}
              >
                <Trash2Icon />
                {t('projects.deleteAction')}
              </GuardedButton>
            )}
          </>
        }
      />

      {/* Intake first, result below: uploading and allocating chapters is what
          populates the episode table underneath. */}
      <BookSplitPanel projectId={projectId} onEpisodesChanged={episodes.reload} />

      <Card>
        <CardHeader className="border-b [.border-b]:pb-4">
          <CardTitle className="flex items-center gap-2">
            <FilmIcon className="text-muted-foreground size-4" />
            {t('projects.episodes')}
          </CardTitle>
          <CardDescription>
            {episodes.loading ? t('common.loading') : t('projects.episodeProgress', { done: completed, total: episodes.data.length })}
          </CardDescription>
        </CardHeader>

        {episodes.error ? (
          <CardContent>
            <ErrorState message={episodes.error} onRetry={episodes.reload} />
          </CardContent>
        ) : episodes.loading && episodes.data.length === 0 ? (
          <TableSkeleton rows={3} columns={4} />
        ) : episodes.data.length === 0 ? (
          <CardContent>
            <EmptyState
              icon={<FilmIcon />}
              title={t('projects.noEpisodes')}
              description={t('projects.noEpisodesHint')}
              action={
                can('episode:write') && !isFilm ? (
                  <Button size="sm" onClick={() => setEpisodeDialogOpen(true)}>
                    <PlusIcon />
                    {t('projects.newEpisode')}
                  </Button>
                ) : undefined
              }
            />
          </CardContent>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-14">#</TableHead>
                <TableHead>{t('common.name')}</TableHead>
                <TableHead className="w-40">{t('common.status')}</TableHead>
                <TableHead className="w-28">{t('storyboards.title')}</TableHead>
                <TableHead className="w-40">{t('common.updatedAt')}</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...episodes.data]
                .sort((a, b) => a.number - b.number)
                .map(episode => {
                  const status = toWorkflowStatus(episode.status)
                  return (
                    <TableRow key={episode.id}>
                      <TableCell className="text-muted-foreground font-mono">{episode.number}</TableCell>
                      <TableCell>
                        <Link
                          href={`/projects/${projectId}/episodes/${episode.id}`}
                          className="hover:text-primary font-medium transition-colors"
                        >
                          {episode.title}
                        </Link>
                        <span className="text-subtle-foreground ml-2 text-xs">{relativeTime(episode.updatedAt, locale)}</span>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={status} label={t(`status.${status}`)} />
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          {t('projects.storyboardCount', { count: episode.storyboards?.filter(isLiveStoryboard).length ?? 0 })}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-subtle-foreground">{formatDateTime(episode.createdAt, locale)}</TableCell>
                      <TableCell className="text-right">
                        <Button asChild variant="ghost" size="sm">
                          <Link href={`/projects/${projectId}/episodes/${episode.id}`}>
                            <span className="sr-only">{t('projects.openEpisode')}</span>
                            <ArrowRightIcon className={cn('size-4')} />
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
            </TableBody>
          </Table>
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

      <EpisodeDialog
        open={episodeDialogOpen}
        projectId={projectId}
        nextNumber={nextEpisodeNumber}
        onOpenChange={setEpisodeDialogOpen}
        onDone={number => {
          setEpisodeDialogOpen(false)
          episodes.reload()
          toast.success(t('projects.episodeCreated', { number }))
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
