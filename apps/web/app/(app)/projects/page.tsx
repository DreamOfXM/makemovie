'use client'

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import {
  ArrowRightIcon,
  ClapperboardIcon,
  FilmIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  WorkflowIcon,
} from 'lucide-react'
import { canTransition, minRoleFor, workflowStatuses, type WorkflowStatus } from '@studio/domain'
import {
  isLiveStoryboard,
  storyboardsPath,
  toWorkflowStatus,
  type AssetsResponse,
  type Episode,
  type Project,
  type Storyboard,
} from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { cn, formatDateTime, formatDuration, relativeTime } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TableSkeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/ui/status-badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { ErrorState } from '@/components/error-state'
import { GuardedButton, usePermission } from '@/components/permission'
import { GenerationsPanel } from '@/components/generations/generations-panel'
import { SourcesPanel } from '@/components/sources/sources-panel'
import { AssetsPanel } from '@/components/assets/assets-panel'
import { DeliveryPanel } from '@/components/deliveries/delivery-panel'
import { StoryboardCard } from '@/components/storyboards/storyboard-card'
import { StoryboardHistory } from '@/components/storyboards/storyboard-history'
import { EpisodeStepper } from '@/components/episode/episode-stepper'

type ProjectDialogState = { mode: 'create' } | { mode: 'rename'; project: Project } | null
type StoryboardDialogState = { mode: 'create'; nextNumber: number } | { mode: 'edit'; storyboard: Storyboard } | null

/** Mirrors the API rule: approving or blocking is a review decision, everything else is an edit. */
function statusAction(target: WorkflowStatus): 'review:decide' | 'storyboard:write' {
  return target === 'approved' || target === 'blocked' ? 'review:decide' : 'storyboard:write'
}

export default function ProjectsPage() {
  const { t, locale } = useI18n()
  const { api, organizationId } = useSession()
  const { can } = usePermission()

  const loadProjects = useCallback(() => api<Project[]>('/projects'), [api, organizationId])
  const projects = useAsync<Project[]>(loadProjects, [])

  const [projectId, setProjectId] = useState<string | null>(null)
  const [episodeId, setEpisodeId] = useState<string | null>(null)
  const [projectDialog, setProjectDialog] = useState<ProjectDialogState>(null)
  const [episodeDialogOpen, setEpisodeDialogOpen] = useState(false)
  const [storyboardDialog, setStoryboardDialog] = useState<StoryboardDialogState>(null)
  const [statusTarget, setStatusTarget] = useState<Storyboard | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)
  const [deleting, setDeleting] = useState(false)

  const loadEpisodes = useCallback(
    () => (projectId ? api<Episode[]>(`/projects/${projectId}/episodes`) : Promise.resolve<Episode[]>([])),
    [api, projectId],
  )
  const episodes = useAsync<Episode[]>(projectId ? loadEpisodes : null, [])

  const selectedProject = projects.data.find(item => item.id === projectId) ?? null
  const selectedEpisode = episodes.data.find(item => item.id === episodeId) ?? null

  // The enriched endpoint carries each storyboard's generated first frame / video, which
  // the episode embed does not. Refresh it while an episode is open so media shows up
  // as generations complete. Superseded revisions ride along so history is one click
  // away instead of a hand-edited URL.
  const loadStoryboards = useCallback(
    () => (episodeId ? api<Storyboard[]>(storyboardsPath(episodeId, true)) : Promise.resolve<Storyboard[]>([])),
    [api, episodeId],
  )
  const storyboardsMedia = useAsync<Storyboard[]>(episodeId ? loadStoryboards : null, [])
  useEffect(() => {
    if (!episodeId) return
    const timer = setInterval(storyboardsMedia.reload, 3000)
    return () => clearInterval(timer)
  }, [episodeId, storyboardsMedia.reload])

  // One list for the count, the empty state, and the cards. The episode embed is only
  // reloaded on an explicit refresh, so consulting it alone would hide shots the worker
  // wrote after an advance — the polled endpoint wins as soon as it has anything.
  const allStoryboards = useMemo(
    () => (storyboardsMedia.data.length > 0 ? storyboardsMedia.data : (selectedEpisode?.storyboards ?? [])),
    [storyboardsMedia.data, selectedEpisode],
  )
  // The same list split by revision: a regenerate supersedes the previous breakdown instead
  // of appending to it, so only live shots may feed the count, the badge, and the stepper.
  const storyboards = useMemo(() => allStoryboards.filter(isLiveStoryboard), [allStoryboards])
  const supersededStoryboards = useMemo(
    () => allStoryboards.filter(storyboard => !isLiveStoryboard(storyboard)),
    [allStoryboards],
  )
  const storyboardRevision = useMemo(
    () => storyboards.reduce((highest, storyboard) => Math.max(highest, storyboard.revision ?? 1), 0),
    [storyboards],
  )
  // Shot numbers are unique per revision, so a hand-added shot continues after every number
  // the episode has ever used rather than colliding with a superseded one.
  const nextStoryboardNumber = useMemo(
    () => allStoryboards.reduce((highest, storyboard) => Math.max(highest, storyboard.number), 0) + 1,
    [allStoryboards],
  )
  const nextEpisodeNumber = useMemo(
    () => episodes.data.reduce((highest, episode) => Math.max(highest, episode.number), 0) + 1,
    [episodes.data],
  )

  const loadEpisodeAssets = useCallback(
    () =>
      episodeId
        ? api<AssetsResponse>(`/episodes/${episodeId}/assets`)
        : Promise.resolve<AssetsResponse>({ assets: [] }),
    [api, episodeId],
  )
  const episodeAssets = useAsync<AssetsResponse>(episodeId ? loadEpisodeAssets : null, { assets: [] })

  // GenerationsPanel owns its own fetch, so a token bump is the page's handle on it.
  const [generationsToken, setGenerationsToken] = useState(0)
  const refreshAfterAdvance = useCallback(() => {
    episodes.reload()
    storyboardsMedia.reload()
    episodeAssets.reload()
    setGenerationsToken(token => token + 1)
  }, [episodes.reload, storyboardsMedia.reload, episodeAssets.reload])

  async function bindStoryboardAssets(storyboardId: string, assets: { assetId: string; role: string }[]) {
    try {
      await api(`/storyboards/${storyboardId}/assets`, { method: 'PUT', body: JSON.stringify({ assets }) })
      toast.success(t('storyboards.assetsUpdated'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      episodes.reload()
      storyboardsMedia.reload()
      episodeAssets.reload()
    }
  }

  useEffect(() => {
    if (!projectId && projects.data.length > 0) setProjectId(projects.data[0].id)
  }, [projectId, projects.data])

  function selectProject(id: string) {
    setProjectId(id)
    setEpisodeId(null)
  }

  async function removeProject(project: Project) {
    setDeleting(true)
    try {
      await api(`/projects/${project.id}`, { method: 'DELETE' })
      toast.success(t('projects.deleted', { name: project.name }))
      setDeleteTarget(null)
      if (projectId === project.id) selectProject('')
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

      <div className="grid gap-6 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <Card className="self-start">
          <CardHeader className="border-b [.border-b]:pb-4">
            <CardTitle>{t('projects.title')}</CardTitle>
            <CardDescription>
              {projects.loading ? t('common.loading') : t('common.count', { count: projects.data.length })}
            </CardDescription>
          </CardHeader>

          {projects.loading && projects.data.length === 0 ? (
            <TableSkeleton rows={3} columns={1} />
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
            <ul className="space-y-1 px-3">
              {projects.data.map(project => {
                const status = toWorkflowStatus(project.status)
                const active = project.id === projectId
                return (
                  <li
                    key={project.id}
                    className={cn(
                      'flex items-center gap-1 rounded-md pr-1 transition-colors',
                      active ? 'bg-primary/10 ring-primary/20 ring-1' : 'hover:bg-accent',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => selectProject(project.id)}
                      aria-current={active}
                      className="min-w-0 flex-1 px-3 py-2.5 text-left"
                    >
                      <span className={cn('block truncate text-sm font-medium', active && 'text-primary')}>
                        {project.name}
                      </span>
                      <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                        <StatusBadge status={status} label={t(`status.${status}`)} className="h-5 px-1.5 text-[11px]" />
                        {relativeTime(project.updatedAt, locale)}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('projects.renameTitle')}
                      disabled={!can('project:update')}
                      onClick={() => setProjectDialog({ mode: 'rename', project })}
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('common.delete')}
                      disabled={!can('project:delete')}
                      onClick={() => setDeleteTarget(project)}
                    >
                      <Trash2Icon className="text-destructive" />
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FilmIcon className="text-muted-foreground size-4" />
                {t('projects.episodes')}
              </CardTitle>
              <CardDescription>{selectedProject ? selectedProject.name : t('projects.selectHint')}</CardDescription>
              {selectedProject && (
                <CardAction>
                  <GuardedButton action="episode:write" size="sm" variant="outline" onClick={() => setEpisodeDialogOpen(true)}>
                    <PlusIcon />
                    {t('projects.newEpisode')}
                  </GuardedButton>
                </CardAction>
              )}
            </CardHeader>

            {!selectedProject ? (
              <CardContent>
                <EmptyState icon={<FilmIcon />} title={t('projects.selectHint')} />
              </CardContent>
            ) : episodes.error ? (
              <CardContent>
                <ErrorState message={episodes.error} onRetry={episodes.reload} />
              </CardContent>
            ) : episodes.loading ? (
              <TableSkeleton rows={3} columns={4} />
            ) : episodes.data.length === 0 ? (
              <CardContent>
                <EmptyState
                  icon={<FilmIcon />}
                  title={t('projects.noEpisodes')}
                  description={t('projects.noEpisodesHint')}
                  action={
                    can('episode:write') ? (
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
                    <TableHead className="w-44">{t('common.createdAt')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {episodes.data.map(episode => {
                    const status = toWorkflowStatus(episode.status)
                    const active = episode.id === episodeId
                    return (
                      <TableRow
                        key={episode.id}
                        data-state={active ? 'selected' : undefined}
                        tabIndex={0}
                        className="cursor-pointer"
                        onClick={() => setEpisodeId(episode.id)}
                        onKeyDown={event => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            setEpisodeId(episode.id)
                          }
                        }}
                      >
                        <TableCell className="text-muted-foreground font-mono">{episode.number}</TableCell>
                        <TableCell className="font-medium">{episode.title}</TableCell>
                        <TableCell>
                          <StatusBadge status={status} label={t(`status.${status}`)} />
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">
                            {t('projects.storyboardCount', {
                              count:
                                episode.id === episodeId
                                  ? storyboards.length
                                  : (episode.storyboards?.filter(isLiveStoryboard).length ?? 0),
                            })}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{formatDateTime(episode.createdAt, locale)}</TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </Card>

          {selectedEpisode ? (
            <div className="grid gap-6 2xl:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] 2xl:items-start">
              <div className="2xl:sticky 2xl:top-20">
                <EpisodeStepper
                  episodeId={selectedEpisode.id}
                  storyboardCount={storyboards.length}
                  speakingShots={storyboards.filter(storyboard => storyboard.dialogue !== '').length}
                  voicedShots={storyboards.filter(storyboard => storyboard.dialogue !== '' && storyboard.voice).length}
                  onAdvanced={refreshAfterAdvance}
                />
              </div>
              <div className="min-w-0 space-y-6">
                <div id="step-source" className="scroll-mt-4">
                  <SourcesPanel episodeId={selectedEpisode.id} onScriptApproved={refreshAfterAdvance} />
                </div>
                <div id="step-assets" className="scroll-mt-4">
                  <AssetsPanel episodeId={selectedEpisode.id} />
                </div>
                <div id="step-storyboards" className="scroll-mt-4">
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex flex-wrap items-center gap-2">
                        <ClapperboardIcon className="text-muted-foreground size-4" />
                        {t('storyboards.title')}
                        {storyboards.length > 0 && (
                          <Badge variant="tinted" className="font-normal">
                            {t('storyboards.revision', { revision: storyboardRevision })}
                          </Badge>
                        )}
                      </CardTitle>
                      <CardDescription>
                        {selectedEpisode
                          ? `${t('projects.episode')} ${selectedEpisode.number} · ${selectedEpisode.title} · ${t(
                              'projects.storyboardCount',
                              { count: storyboards.length },
                            )}`
                          : t('projects.detailHint')}
                      </CardDescription>
                      {selectedEpisode && (
                        <CardAction>
                          <GuardedButton
                            action="storyboard:write"
                            size="sm"
                            variant="outline"
                            onClick={() => setStoryboardDialog({ mode: 'create', nextNumber: nextStoryboardNumber })}
                          >
                            <PlusIcon />
                            {t('storyboards.new')}
                          </GuardedButton>
                        </CardAction>
                      )}
                    </CardHeader>

                    {!selectedEpisode ? (
                      <CardContent>
                        <EmptyState icon={<ClapperboardIcon />} title={t('storyboards.selectEpisode')} />
                      </CardContent>
                    ) : allStoryboards.length === 0 ? (
                      <CardContent>
                        <EmptyState
                          icon={<ClapperboardIcon />}
                          title={t('storyboards.none')}
                          description={t('storyboards.noneHint')}
                          action={
                            can('storyboard:write') ? (
                              <Button size="sm" onClick={() => setStoryboardDialog({ mode: 'create', nextNumber: 1 })}>
                                <PlusIcon />
                                {t('storyboards.new')}
                              </Button>
                            ) : undefined
                          }
                        />
                      </CardContent>
                    ) : (
                      <CardContent className="space-y-4">
                        {storyboards.length === 0 ? (
                          <p className="text-muted-foreground text-sm">{t('storyboards.noLiveShots')}</p>
                        ) : (
                          storyboards.map(storyboard => (
                            <StoryboardCard
                              key={storyboard.id}
                              storyboard={storyboard}
                              canWrite={can('storyboard:write')}
                              episodeAssets={episodeAssets.data.assets}
                              onBindAssets={bindStoryboardAssets}
                              onEdit={() => setStoryboardDialog({ mode: 'edit', storyboard })}
                              onChangeStatus={() => setStatusTarget(storyboard)}
                            />
                          ))
                        )}
                        <StoryboardHistory
                          shots={supersededStoryboards}
                          canWrite={can('storyboard:write')}
                          episodeAssets={episodeAssets.data.assets}
                          onBindAssets={bindStoryboardAssets}
                          onEdit={storyboard => setStoryboardDialog({ mode: 'edit', storyboard })}
                          onChangeStatus={storyboard => setStatusTarget(storyboard)}
                        />
                      </CardContent>
                    )}
                  </Card>
                </div>

                <div id="step-generation" className="scroll-mt-4">
                  <GenerationsPanel episodeId={selectedEpisode.id} reloadToken={generationsToken} />
                </div>
                <div id="step-delivery" className="scroll-mt-4">
                  <DeliveryPanel episodeId={selectedEpisode.id} />
                </div>
              </div>
            </div>
          ) : (
            <Card>
              <CardContent className="py-14">
                <EmptyState
                  icon={<FilmIcon />}
                  title={t('workspace.selectEpisodeTitle')}
                  description={t('workspace.selectEpisodeHint')}
                />
              </CardContent>
            </Card>
          )}
        </div>
      </div>

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
        projectId={selectedProject?.id ?? null}
        nextNumber={nextEpisodeNumber}
        onOpenChange={setEpisodeDialogOpen}
        onDone={number => {
          setEpisodeDialogOpen(false)
          episodes.reload()
          toast.success(t('projects.episodeCreated', { number }))
        }}
      />

      <StoryboardDialog
        state={storyboardDialog}
        episodeId={selectedEpisode?.id ?? null}
        onOpenChange={open => !open && setStoryboardDialog(null)}
        onDone={(mode, number) => {
          setStoryboardDialog(null)
          episodes.reload()
          storyboardsMedia.reload()
          toast.success(mode === 'edit' ? t('storyboards.updated') : t('storyboards.created', { number }))
        }}
      />

      <StatusDialog
        storyboard={statusTarget}
        onOpenChange={open => !open && setStatusTarget(null)}
        onDone={status => {
          setStatusTarget(null)
          episodes.reload()
          storyboardsMedia.reload()
          toast.success(t('storyboards.statusChanged', { status: t(`status.${status}`) }))
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

interface ProjectDialogProps {
  state: ProjectDialogState
  onOpenChange(open: boolean): void
  onDone(mode: 'create' | 'rename', name: string): void
}

function ProjectDialog({ state, onOpenChange, onDone }: ProjectDialogProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!state) return
    setName(state.mode === 'rename' ? state.project.name : '')
    setError('')
  }, [state])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!state) return
    setBusy(true)
    setError('')
    try {
      if (state.mode === 'create') {
        const created = await api<Project>('/projects', { method: 'POST', body: JSON.stringify({ name }) })
        onDone('create', created.name)
      } else {
        await api(`/projects/${state.project.id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
        onDone('rename', name)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.generic'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={state !== null} onOpenChange={open => !busy && onOpenChange(open)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{state?.mode === 'rename' ? t('projects.renameTitle') : t('projects.newTitle')}</DialogTitle>
          <DialogDescription>{t('projects.subtitle')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field label={t('projects.nameLabel')} htmlFor="projectName" required error={error}>
            <Input
              id="projectName"
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder={t('projects.namePlaceholder')}
              required
              autoFocus
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? t('common.saving') : state?.mode === 'rename' ? t('common.save') : t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface EpisodeDialogProps {
  open: boolean
  projectId: string | null
  nextNumber: number
  onOpenChange(open: boolean): void
  onDone(number: number): void
}

function EpisodeDialog({ open, projectId, nextNumber, onOpenChange, onDone }: EpisodeDialogProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const [number, setNumber] = useState(nextNumber)
  const [title, setTitle] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setNumber(nextNumber)
    setTitle('')
    setError('')
  }, [open, nextNumber])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!projectId) return
    setBusy(true)
    setError('')
    try {
      await api(`/projects/${projectId}/episodes`, { method: 'POST', body: JSON.stringify({ number, title }) })
      onDone(number)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.generic'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={value => !busy && onOpenChange(value)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('projects.newEpisodeTitle')}</DialogTitle>
          <DialogDescription>{t('projects.noEpisodesHint')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[7rem_minmax(0,1fr)]">
            <Field label={t('projects.episodeNumber')} htmlFor="episodeNumber" required>
              <Input
                id="episodeNumber"
                type="number"
                min={1}
                step={1}
                value={number}
                onChange={event => setNumber(Number(event.target.value))}
                required
              />
            </Field>
            <Field label={t('common.name')} htmlFor="episodeTitle" required error={error}>
              <Input
                id="episodeTitle"
                value={title}
                onChange={event => setTitle(event.target.value)}
                placeholder={t('projects.episodeTitlePlaceholder')}
                required
                autoFocus
              />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy || !title.trim() || !Number.isInteger(number) || number < 1}>
              {busy ? t('common.saving') : t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface StoryboardDialogProps {
  state: StoryboardDialogState
  episodeId: string | null
  onOpenChange(open: boolean): void
  onDone(mode: 'create' | 'edit', number: number): void
}

const emptyStoryboard = {
  number: 1,
  title: '',
  durationMs: 3000,
  description: '',
  dialogue: '',
  speaker: '',
  sourceExcerpt: '',
  continuityIn: '',
  continuityOut: '',
}

function StoryboardDialog({ state, episodeId, onOpenChange, onDone }: StoryboardDialogProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const [form, setForm] = useState(emptyStoryboard)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const editing = state?.mode === 'edit' ? state.storyboard : null

  useEffect(() => {
    if (!state) return
    setError('')
    setForm(
      state.mode === 'edit'
        ? {
            number: state.storyboard.number,
            title: state.storyboard.title,
            durationMs: state.storyboard.durationMs,
            description: state.storyboard.description,
            dialogue: state.storyboard.dialogue,
            speaker: state.storyboard.speaker ?? '',
            sourceExcerpt: state.storyboard.sourceExcerpt,
            continuityIn: state.storyboard.continuityIn,
            continuityOut: state.storyboard.continuityOut,
          }
        : { ...emptyStoryboard, number: state.nextNumber },
    )
  }, [state])

  function field(key: keyof typeof emptyStoryboard, value: string | number) {
    setForm(current => ({ ...current, [key]: value }))
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (editing ? false : !episodeId) return
    setBusy(true)
    setError('')
    try {
      if (editing) {
        await api(`/storyboards/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            title: form.title,
            durationMs: form.durationMs,
            description: form.description,
            dialogue: form.dialogue,
            speaker: form.speaker,
            sourceExcerpt: form.sourceExcerpt,
            continuityIn: form.continuityIn,
            continuityOut: form.continuityOut,
          }),
        })
        onDone('edit', editing.number)
      } else {
        await api(`/episodes/${episodeId}/storyboards`, { method: 'POST', body: JSON.stringify(form) })
        onDone('create', form.number)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.generic'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={state !== null} onOpenChange={open => !busy && onOpenChange(open)}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? t('storyboards.editTitle') : t('storyboards.newTitle')}</DialogTitle>
          <DialogDescription>{t('storyboards.descriptionPlaceholder')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[6rem_8rem_minmax(0,1fr)]">
            <Field label={t('storyboards.number')} htmlFor="shotNumber" required>
              <Input
                id="shotNumber"
                type="number"
                min={1}
                step={1}
                value={form.number}
                onChange={event => field('number', Number(event.target.value))}
                disabled={editing !== null}
                required
              />
            </Field>
            <Field label={t('storyboards.duration')} htmlFor="shotDuration" required>
              <Input
                id="shotDuration"
                type="number"
                min={1}
                step="any"
                value={form.durationMs}
                onChange={event => field('durationMs', Number(event.target.value))}
                required
              />
            </Field>
            <Field label={t('storyboards.titleLabel')} htmlFor="shotTitle" required>
              <Input
                id="shotTitle"
                value={form.title}
                onChange={event => field('title', event.target.value)}
                placeholder={t('storyboards.titlePlaceholder')}
                required
                autoFocus
              />
            </Field>
          </div>

          <Field label={t('storyboards.description')} htmlFor="shotDescription" required error={error}>
            <Textarea
              id="shotDescription"
              value={form.description}
              onChange={event => field('description', event.target.value)}
              rows={3}
              required
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <Field label={t('storyboards.speaker')} htmlFor="shotSpeaker">
              <Input
                id="shotSpeaker"
                value={form.speaker}
                onChange={event => field('speaker', event.target.value)}
                placeholder={t('common.optional')}
              />
            </Field>
            <Field label={t('storyboards.dialogue')} htmlFor="shotDialogue" hint={t('storyboards.dialogueHint')}>
              <Textarea
                id="shotDialogue"
                value={form.dialogue}
                onChange={event => field('dialogue', event.target.value)}
                rows={2}
                placeholder={t('common.optional')}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('storyboards.continuityIn')} htmlFor="shotIn">
              <Input
                id="shotIn"
                value={form.continuityIn}
                onChange={event => field('continuityIn', event.target.value)}
                placeholder={t('common.optional')}
              />
            </Field>
            <Field label={t('storyboards.continuityOut')} htmlFor="shotOut">
              <Input
                id="shotOut"
                value={form.continuityOut}
                onChange={event => field('continuityOut', event.target.value)}
                placeholder={t('common.optional')}
              />
            </Field>
          </div>

          <Field label={t('storyboards.sourceExcerpt')} htmlFor="shotExcerpt">
            <Textarea
              id="shotExcerpt"
              value={form.sourceExcerpt}
              onChange={event => field('sourceExcerpt', event.target.value)}
              rows={2}
              placeholder={t('common.optional')}
            />
          </Field>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy || !form.title.trim() || !form.description.trim() || form.durationMs < 1}>
              {busy ? t('common.saving') : editing ? t('common.save') : t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface StatusDialogProps {
  storyboard: Storyboard | null
  onOpenChange(open: boolean): void
  onDone(status: WorkflowStatus): void
}

function StatusDialog({ storyboard, onOpenChange, onDone }: StatusDialogProps) {
  const { t } = useI18n()
  const { api, role } = useSession()
  const { can } = usePermission()
  const [target, setTarget] = useState<WorkflowStatus | ''>('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const current = storyboard ? toWorkflowStatus(storyboard.status) : null
  const options = useMemo(
    () => (current ? workflowStatuses.filter(status => status !== current && canTransition(current, status)) : []),
    [current],
  )

  useEffect(() => {
    if (!storyboard) return
    setTarget('')
    setReason('')
    setError('')
  }, [storyboard])

  const denied = target ? !can(statusAction(target)) : false

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!storyboard || !target || denied) return
    setBusy(true)
    setError('')
    try {
      await api(`/storyboards/${storyboard.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ to: target, reason: reason.trim() || undefined }),
      })
      onDone(target)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.generic'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={storyboard !== null} onOpenChange={open => !busy && onOpenChange(open)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('storyboards.statusTitle')}</DialogTitle>
          <DialogDescription>
            {storyboard ? `${t('storyboards.shot', { number: storyboard.number })} · ${storyboard.title}` : ''}
          </DialogDescription>
        </DialogHeader>

        {current && options.length === 0 ? (
          <>
            <EmptyState icon={<ArrowRightIcon />} title={t('storyboards.noTransitions')} />
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t('common.close')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="flex items-center gap-2 text-sm">
              {current && <StatusBadge status={current} label={t(`status.${current}`)} />}
              <ArrowRightIcon className="text-muted-foreground size-4" />
              {target ? (
                <StatusBadge status={target} label={t(`status.${target}`)} />
              ) : (
                <span className="text-muted-foreground text-sm">{t('storyboards.targetStatus')}</span>
              )}
            </div>

            <Field label={t('storyboards.targetStatus')} htmlFor="targetStatus" required error={error}>
              <Select value={target} onValueChange={value => setTarget(value as WorkflowStatus)}>
                <SelectTrigger id="targetStatus" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.map(status => {
                    const action = statusAction(status)
                    return (
                      <SelectItem key={status} value={status}>
                        <span className="flex items-center gap-2">
                          {t(`status.${status}`)}
                          {!can(action) && (
                            <Badge variant="muted" className="font-normal">
                              {t(`role.${minRoleFor(action)}`)}
                            </Badge>
                          )}
                        </span>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </Field>

            {denied && target && (
              <p className="text-destructive text-xs font-medium" role="alert">
                {t('rbac.actionDenied', { role: t(`role.${role ?? 'VIEWER'}`), action: statusAction(target) })}
              </p>
            )}

            <Field label={t('storyboards.reason')} htmlFor="statusReason" hint={t('storyboards.reasonPlaceholder')}>
              <Textarea
                id="statusReason"
                value={reason}
                onChange={event => setReason(event.target.value)}
                rows={2}
                placeholder={t('common.optional')}
              />
            </Field>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={busy || !target || denied}>
                {busy ? t('common.saving') : t('common.save')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
