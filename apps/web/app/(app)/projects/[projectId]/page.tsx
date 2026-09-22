'use client'

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowRightIcon, FilmIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import {
  ApiError,
  deleteEpisode,
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
  // 页面侧的建集/删集要同时反哺拆分矩阵（下拉的集列表、分配行）——面板自己
  // 轮不到这些动作，靠这个令牌通知它重读。
  const [splitRefreshToken, setSplitRefreshToken] = useState(0)
  const [episodeDeleteTarget, setEpisodeDeleteTarget] = useState<Episode | null>(null)
  const [episodeDeleteAllOpen, setEpisodeDeleteAllOpen] = useState(false)
  const [episodeDeleting, setEpisodeDeleting] = useState(false)

  async function removeEpisode(target: Episode) {
    setEpisodeDeleting(true)
    try {
      await deleteEpisode(api, projectId, target.id)
      toast.success(t('projects.episodeDeleted', { number: target.number }))
      setEpisodeDeleteTarget(null)
      episodes.reload()
      setSplitRefreshToken(token => token + 1)
    } catch (error) {
      if (error instanceof ApiError && error.message === 'episodes:notDeletable') {
        toast.error(t('projects.episodeNotDeletable'))
      } else {
        toast.error(error instanceof Error ? error.message : t('error.generic'))
      }
    } finally {
      setEpisodeDeleting(false)
    }
  }

  /** 批量清理空壳集:有分镜/生成产物/交付的集会被服务端拒绝——逐集尝试,
   *  结束后如实报「删了几集、几集因有产物保留」。 */
  async function removeAllEpisodes() {
    setEpisodeDeleting(true)
    let deleted = 0
    let kept = 0
    try {
      for (const episode of episodes.data) {
        try {
          await deleteEpisode(api, projectId, episode.id)
          deleted += 1
        } catch {
          kept += 1
        }
      }
      toast.success(kept > 0
        ? t('projects.deleteAllEpisodesKept', { deleted, kept })
        : t('projects.deleteAllEpisodesDone', { deleted }))
      setEpisodeDeleteAllOpen(false)
      episodes.reload()
      setSplitRefreshToken(token => token + 1)
    } finally {
      setEpisodeDeleting(false)
    }
  }

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
            {/* 新建剧集只住在剧集卡上:动作按钮归属其结果所在的模块,页头再放一份
                只会和它抢注意(用户实测两次提出)。 */}
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
      <BookSplitPanel projectId={projectId} refreshToken={splitRefreshToken} onEpisodesChanged={episodes.reload} />

      <Card>
        <CardHeader className="border-b [.border-b]:pb-4">
          <CardTitle className="flex items-center gap-2">
            <FilmIcon className="text-muted-foreground size-4" />
            {t('projects.episodes')}
          </CardTitle>
          <CardDescription>
            {episodes.loading ? t('common.loading') : t('projects.episodeProgress', { done: completed, total: episodes.data.length })}
          </CardDescription>
          {/* Creating episodes lives where episodes live: the split panel creates
              its own via grouping, this module owns the manual door. Films are
              locked to their single born episode. */}
          {!isFilm && (
            <CardAction>
              <div className="flex items-center gap-1">
                {episodes.data.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive"
                    disabled={episodeDeleting}
                    onClick={() => setEpisodeDeleteAllOpen(true)}
                  >
                    {t('projects.deleteAllEpisodesAction')}
                  </Button>
                )}
                <GuardedButton action="episode:write" variant="outline" size="sm" onClick={() => setEpisodeDialogOpen(true)}>
                  <PlusIcon />
                  {t('projects.newEpisode')}
                </GuardedButton>
              </div>
            </CardAction>
          )}
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
                  // 拆分生成的原文先以草稿落在集内,等人审批——列表行必须把这
                  // 件待办亮出来,否则"生成分集原文"的结果要靠用户自己猜在哪。
                  const pendingSources = episode.sourceVersions?.filter(version => version.status === 'DRAFT').length ?? 0
                  return (
                    <TableRow key={episode.id}>
                      <TableCell className="text-muted-foreground font-mono">{episode.number}</TableCell>
                      <TableCell>
                        <Link
                          href={`/projects/${projectId}/episodes/${episode.id}`}
                          className="hover:text-primary inline-block max-w-md truncate font-medium transition-colors"
                        >
                          {episode.title}
                        </Link>
                        {pendingSources > 0 && (
                          <Badge variant="warning" className="ml-2 font-normal">
                            {t('projects.pendingSource', { count: pendingSources })}
                          </Badge>
                        )}
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
                        <div className="flex justify-end gap-1">
                          <Button asChild variant="ghost" size="sm">
                            <Link href={`/projects/${projectId}/episodes/${episode.id}`}>
                              <span className="sr-only">{t('projects.openEpisode')}</span>
                              <ArrowRightIcon className={cn('size-4')} />
                            </Link>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() => setEpisodeDeleteTarget(episode)}
                          >
                            <span className="sr-only">{t('projects.deleteEpisodeAction')}</span>
                            <Trash2Icon />
                          </Button>
                        </div>
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
          // 新集也要进拆分矩阵的下拉——面板自己轮不到这个动作。
          setSplitRefreshToken(token => token + 1)
          toast.success(t('projects.episodeCreated', { number }))
        }}
      />

      <AlertDialog open={episodeDeleteAllOpen} onOpenChange={open => !open && setEpisodeDeleteAllOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('projects.deleteAllEpisodesTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('projects.deleteAllEpisodesBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={episodeDeleting}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={episodeDeleting}
              onClick={event => {
                event.preventDefault()
                void removeAllEpisodes()
              }}
            >
              {episodeDeleting ? t('common.loading') : t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={episodeDeleteTarget !== null} onOpenChange={open => !open && setEpisodeDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('projects.deleteEpisodeTitle', { number: episodeDeleteTarget?.number ?? 0 })}</AlertDialogTitle>
            <AlertDialogDescription>{t('projects.deleteEpisodeBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={episodeDeleting}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={episodeDeleting}
              onClick={event => {
                event.preventDefault()
                if (episodeDeleteTarget) void removeEpisode(episodeDeleteTarget)
              }}
            >
              {episodeDeleting ? t('common.loading') : t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
