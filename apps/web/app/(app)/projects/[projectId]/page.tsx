'use client'

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { FilmIcon, MoreHorizontalIcon, MoreVerticalIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { apiErrorMessage } from '@/lib/api-error'
import {
  ApiError,
  deleteEpisode,
  toProjectFormat,
  type Episode,
  type Project,
} from '@/lib/api'
import { episodeProgressToken, episodeVerdict, type EpisodeTone, type EpisodeVerdict } from '@/lib/episode-verdict'
import { translateEnum, useI18n, type TranslateFn } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { TableSkeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ErrorState } from '@/components/error-state'
import { GuardedButton, usePermission } from '@/components/permission'
import { EpisodeDialog, ProjectDeleteDialog, ProjectDialog, type ProjectDialogState } from '@/components/episode/production-dialogs'
import { BookSplitPanel } from '@/components/sources/book-split-panel'
import { ProjectSettingsDialog, SettingsButton } from '@/components/ProjectSettingsDialog'

/** The strip's four colours plus the pipeline's own, in the same tokens the
 *  projects board uses for its lifecycle bars. */
const toneFill: Record<EpisodeTone, string> = {
  blocked: 'bg-destructive',
  waiting: 'bg-warning',
  running: 'bg-info',
  done: 'bg-success',
  // Not `bg-border`: that is a hairline colour, and as a fill it vanishes into the
  // card behind it in the light skins — which is finding 12 all over again.
  idle: 'bg-muted-foreground/25',
}

const toneBadge: Record<EpisodeTone, 'destructive' | 'warning' | 'info' | 'success' | 'muted'> = {
  blocked: 'destructive',
  waiting: 'warning',
  running: 'info',
  done: 'success',
  idle: 'muted',
}

function stageLabel(t: TranslateFn, verdict: EpisodeVerdict, frames: number): string {
  switch (verdict.stage) {
    case 'blocked': return t('projects.stage.blocked', { count: verdict.count })
    case 'review': return t('projects.stage.review', { count: verdict.count })
    case 'source': return t('projects.stage.source', { count: verdict.count })
    case 'running': return t('projects.stage.running', { frames, shots: verdict.shots })
    case 'deliverable': return t('projects.stage.deliverable')
    case 'delivered': return t('projects.stage.delivered')
    case 'start': return t('projects.stage.start')
    case 'none': return t('projects.stage.none')
  }
}

function progressLabel(t: TranslateFn, episode: Episode, verdict: EpisodeVerdict): string {
  const { token, count } = episodeProgressToken(episode, verdict)
  if (token === 'delivered') return t('projects.progress.delivered')
  if (token === 'composed') return t('projects.progress.composed')
  if (token === 'nothing') return t('projects.progress.empty')
  return t(`projects.progress.${token}`, { count })
}

/**
 * One cell per episode, coloured by where that episode actually stopped. The cells are
 * links, because a strip that only decorates the table underneath it would be the same
 * information twice; with a 40-episode season the digits would collapse to ink, so they
 * only appear while there is room for them.
 */
/** One cell per episode, filled with the colour of where that episode actually
 *  stopped. No digits: they would sit on a saturated fill whose contrast flips
 *  between the dark and light skins, and the table underneath already numbers the
 *  episodes in the same order. The cells are links anyway, so the strip is a way to
 *  get to EP 14, not a caption for it. */
function LifecycleStrip({ rows, done }: { rows: Array<{ episode: Episode; verdict: EpisodeVerdict; label: string }>; done: number }) {
  const { t } = useI18n()
  return (
    <div className="flex items-center gap-3 border-b px-6 py-3">
      <span className="text-subtle-foreground shrink-0 text-xs">{t('projects.lifecycleLabel')}</span>
      <div className="flex min-w-0 flex-1 gap-px overflow-hidden rounded-sm">
        {rows.map(row => (
          <Tooltip key={row.episode.id}>
            <TooltipTrigger asChild>
              <Link
                href={`/projects/${row.episode.projectId}/episodes/${row.episode.id}`}
                aria-label={`${t('projects.episode')} ${row.episode.number}: ${row.label}`}
                className={cn(
                  'h-4 min-w-3 flex-1 transition-opacity hover:opacity-75',
                  toneFill[row.verdict.tone],
                )}
              />
            </TooltipTrigger>
            {/* 色块本身回答不了「这一集停在哪」，这句解释只活在这里，
                原先挂在原生 title 上等于没有提示。 */}
            <TooltipContent>
              {`${t('projects.episode')} ${row.episode.number} · ${row.episode.title} — ${row.label}`}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
      <span className="text-subtle-foreground shrink-0 text-xs font-medium tabular-nums">
        {t('projects.lifecycleDone', { done, total: rows.length })}
      </span>
    </div>
  )
}

/**
 * The project surface: everything that belongs to a season rather than to one episode.
 * Rows link out to the production surface instead of embedding it, so this screen stays a
 * list you read rather than a workbench you scroll.
 */
export default function ProjectPage() {
  const { t } = useI18n()
  const { api, organizationId } = useSession()
  const { can } = usePermission()
  const params = useParams<{ projectId: string }>()
  const projectId = params.projectId
  const router = useRouter()

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
  const [settingsOpen, setSettingsOpen] = useState(false)

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
        toast.error(apiErrorMessage(error, t))
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
  /** Every number this page reads, resolved once per load: the strip's colours, the
   *  「1/6 完成」 counter and the header subtitle all come out of the same verdicts, so
   *  they cannot drift apart the way the old `episode.status` column drifted from reality. */
  const board = useMemo(() => {
    const rows = [...episodes.data]
      .sort((a, b) => a.number - b.number)
      .map(episode => {
        const verdict = episodeVerdict(episode)
        const frames = episode.progress?.frames ?? 0
        return {
          episode,
          verdict,
          label: stageLabel(t, verdict, frames),
          detail: progressLabel(t, episode, verdict),
        }
      })
    return {
      rows,
      shots: rows.reduce((total, row) => total + row.verdict.shots, 0),
      done: rows.filter(row => row.verdict.done).length,
    }
  }, [episodes.data, t])
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
      toast.error(apiErrorMessage(error, t))
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
            ? t('projects.progressSummary', {
                episodes: board.rows.length,
                shots: board.shots,
                done: board.done,
                contentLanguage: translateEnum(t, 'projects.contentLocale', project.contentLocale),
              })
            : undefined
        }
        actions={
          <>
            {/* 新建剧集只住在剧集卡上:动作按钮归属其结果所在的模块,页头再放一份
                只会和它抢注意(用户实测两次提出)。 */}
            {project && (
              <SettingsButton onClick={() => setSettingsOpen(true)} />
            )}
            <GuardedButton
              action="project:update"
              variant="outline"
              onClick={() => project && setProjectDialog({ mode: 'rename', project })}
            >
              <PencilIcon />
              {t('projects.renameTitle')}
            </GuardedButton>
            {/* 删除项目从按钮排里拿掉了:它和「风格」长得一模一样，却是这个屏幕上
                唯一不可逆的动作。收进 ⋯ 之后它是红的一项，还要把项目名打出来才按得下去。 */}
            {project && can('project:delete') && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" aria-label={t('projects.moreActions')}>
                    <MoreVerticalIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setDeleteTarget(project)}
                  >
                    <Trash2Icon />
                    {t('projects.deleteAction')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
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
          {/* Creating episodes lives where episodes live: the split panel creates
              its own via grouping, this module owns the manual door. Films are
              locked to their single born episode. */}
          {!isFilm && (
            <CardAction>
              <div className="flex items-center gap-1">
                {episodes.data.length > 1 && (
                  <GuardedButton
                    action="episode:write"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive"
                    disabled={episodeDeleting}
                    onClick={() => setEpisodeDeleteAllOpen(true)}
                  >
                    {t('projects.deleteAllEpisodesAction')}
                  </GuardedButton>
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
          <>
            <LifecycleStrip rows={board.rows} done={board.done} />
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>{t('common.name')}</TableHead>
                  <TableHead className="w-44">{t('projects.stageColumn')}</TableHead>
                  {/* 390px 下这张表本来就要横向滚 72px，滚掉的正是要点的那枚按钮。
                      镜头进度是这行里唯一能少的一列：上面那根条已经按集分了色。 */}
                  <TableHead className="hidden w-36 md:table-cell">{t('projects.progressColumn')}</TableHead>
                  <TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {board.rows.map(({ episode, verdict, label, detail }) => {
                  const href = `/projects/${projectId}/episodes/${episode.id}`
                  // 「交付」不是装饰：这一集真的到门口了才换主按钮，点了就落到
                  // 该集的交付环节上。其余的行只给一个「打开」。
                  const ready = verdict.stage === 'deliverable' || verdict.stage === 'delivered'
                  const canDelete = can('episode:write')
                  return (
                    <TableRow key={episode.id}>
                      <TableCell className="text-subtle-foreground font-mono">{episode.number}</TableCell>
                      <TableCell>
                        <Link href={href} className="hover:text-primary inline-block max-w-md truncate font-medium transition-colors">
                          {episode.title}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant={toneBadge[verdict.tone]}>{label}</Badge>
                      </TableCell>
                      <TableCell className="hidden text-subtle-foreground text-xs tabular-nums md:table-cell">
                        {t('projects.shotProgress', { shots: verdict.shots, detail })}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {ready ? (
                            <Button asChild size="sm">
                              <Link href={`${href}#step-delivery`}>{t('projects.deliverAction')}</Link>
                            </Button>
                          ) : (
                            <Button asChild variant="outline" size="sm">
                              <Link href={href}>{t('projects.open')}</Link>
                            </Button>
                          )}
                          {/* 垃圾桶不再常驻:六行六个删除图标紧挨着跳转箭头，是这张表上
                              最容易误点的位置。收进 ⋯ 之后它只有两下 click 的距离，
                              而那两下都要看得见字。 */}
                          {(ready || canDelete) && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon-sm" aria-label={t('projects.moreActions')}>
                                  <MoreHorizontalIcon />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {ready && <DropdownMenuItem onClick={() => router.push(href)}>{t('projects.openEpisode')}</DropdownMenuItem>}
                                {canDelete && (
                                  <DropdownMenuItem variant="destructive" onClick={() => setEpisodeDeleteTarget(episode)}>
                                    {t('projects.deleteEpisodeAction')}
                                  </DropdownMenuItem>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </>
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

      <ProjectDeleteDialog
        project={deleteTarget}
        busy={deleting}
        onOpenChange={open => !open && setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) void removeProject(deleteTarget)
        }}
      />

      <ProjectSettingsDialog
        open={settingsOpen}
        projectId={projectId}
        currentStyleId={project?.stylePresetId ?? null}
        qcMaxAttempts={project?.qcMaxAttempts ?? null}
        onOpenChange={setSettingsOpen}
        onStyleChanged={projects.reload}
      />
    </>
  )
}
