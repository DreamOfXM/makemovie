'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { ArrowRightIcon } from 'lucide-react'
import {
  canTransition,
  contentLocales,
  formatDefaults,
  formatDurationRange,
  minRoleFor,
  projectFormats,
  workflowStatuses,
  type ContentLocale,
  type ProjectFormat,
  type WorkflowStatus,
} from '@studio/domain'
import { createEpisode, createProject, toWorkflowStatus, type Project, type Storyboard } from '@/lib/api'
import { translateEnum, useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Field } from '@/components/ui/field'
import { HelpHint } from '@/components/ui/help-hint'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StatusBadge } from '@/components/ui/status-badge'
import { Textarea } from '@/components/ui/textarea'
import { usePermission } from '@/components/permission'

export type ProjectDialogState = { mode: 'create' } | { mode: 'rename'; project: Project } | null
export type StoryboardDialogState = { mode: 'create'; nextNumber: number } | { mode: 'edit'; storyboard: Storyboard } | null

/** Mirrors the API rule: approving or blocking is a review decision, everything else is an edit. */
function statusAction(target: WorkflowStatus): 'review:decide' | 'storyboard:write' {
  return target === 'approved' || target === 'blocked' ? 'review:decide' : 'storyboard:write'
}

export interface ProjectDialogProps {
  state: ProjectDialogState
  onOpenChange(open: boolean): void
  onDone(mode: 'create' | 'rename', name: string): void
}

export function ProjectDialog({ state, onOpenChange, onDone }: ProjectDialogProps) {
  const { locale, t } = useI18n()
  const { api } = useSession()
  const [name, setName] = useState('')
  const [contentLocale, setContentLocale] = useState<ContentLocale>('zh')
  const [format, setFormat] = useState<ProjectFormat>('short_drama')
  // Minutes in the box, ms on the wire — kept as text so the field can be emptied
  // while typing; the verdict happens on save, not on every keystroke. Switching
  // formats re-seeds the box with that format's default.
  const [durationText, setDurationText] = useState(String(formatDefaults.short_drama.targetDurationMs / 60_000))
  const [durationError, setDurationError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const durationRange = formatDurationRange[format]
  const durationMinutes = Number(durationText)
  const durationEmpty = durationText.trim() === ''
  const durationValid =
    !durationEmpty && Number.isFinite(durationMinutes) &&
    durationMinutes >= durationRange.minMs / 60_000 && durationMinutes <= durationRange.maxMs / 60_000

  useEffect(() => {
    if (!state) return
    setName(state.mode === 'rename' ? state.project.name : '')
    // The console language is the only hint available for a brand-new project, and it
    // is a hint the field below can overrule — never a decision made for the user.
    setContentLocale(state.mode === 'rename' ? state.project.contentLocale : locale)
    setFormat('short_drama')
    setDurationText(String(formatDefaults.short_drama.targetDurationMs / 60_000))
    setDurationError('')
    setError('')
  }, [state, locale])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!state) return
    // 空值/越界在保存这一刻裁决并落到字段下,而不是悄悄禁用按钮或边打字边抢焦点。
    if (state.mode === 'create' && !durationValid) {
      setDurationError(
        durationEmpty
          ? t('projects.durationRequired')
          : t('projects.durationOutOfRange', { min: durationRange.minMs / 60_000, max: durationRange.maxMs / 60_000 }),
      )
      return
    }
    setBusy(true)
    setError('')
    try {
      if (state.mode === 'create') {
        const created = await createProject(api, { name, contentLocale, format, targetDurationMs: Math.round(durationMinutes * 60_000) })
        onDone('create', created.name)
      } else {
        await api(`/projects/${state.project.id}`, { method: 'PATCH', body: JSON.stringify({ name, contentLocale }) })
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
      {/* Create mode carries the three format cards, so it gets the wider shell. */}
      <DialogContent className={state?.mode === 'create' ? 'sm:max-w-lg' : 'sm:max-w-md'}>
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
          <Field label={t('projects.contentLanguageLabel')} htmlFor="projectContentLocale" hint={t('projects.contentLanguageHint')}>
            <Select value={contentLocale} onValueChange={value => setContentLocale(value as ContentLocale)}>
              <SelectTrigger id="projectContentLocale">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {contentLocales.map(item => (
                  <SelectItem key={item} value={item}>
                    {translateEnum(t, 'projects.contentLocale', item)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {state?.mode === 'create' && (
            <div className="space-y-1.5">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                {t('projects.formatLabel')}
                <HelpHint text={t('projects.formatHint')} />
              </p>
              <div role="radiogroup" aria-label={t('projects.formatLabel')} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {projectFormats.map(item => {
                  const minutes = formatDefaults[item].targetDurationMs / 60_000
                  const selected = format === item
                  return (
                    <label
                      key={item}
                      className={cn(
                        'flex cursor-pointer flex-col gap-1 rounded-lg border px-3 py-2.5 transition-colors',
                        selected ? 'border-primary/40 bg-primary/10' : 'hover:bg-accent/40',
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="projectFormat"
                          className="accent-primary size-4"
                          checked={selected}
                          onChange={() => {
                            setFormat(item)
                            setDurationText(String(formatDefaults[item].targetDurationMs / 60_000))
                            setDurationError('')
                          }}
                          disabled={busy}
                        />
                        <span className="text-sm font-medium">{t(`projects.format.${item}`)}</span>
                      </span>
                      <span className="text-muted-foreground pl-6 text-xs">
                        {t('projects.format.duration', { minutes })}
                      </span>
                      {item === 'film' && (
                        <span className="text-primary pl-6 text-xs">{t('projects.format.filmNote')}</span>
                      )}
                    </label>
                  )
                })}
              </div>
              <p className="text-muted-foreground text-xs">{t(`projects.format.desc.${format}`)}</p>
              <div className="space-y-1.5">
                <label htmlFor="projectDuration" className="flex items-center gap-1.5 text-sm font-medium">
                  {t('projects.durationLabel')}
                  <HelpHint text={t('projects.durationHint')} />
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="projectDuration"
                    type="number"
                    inputMode="decimal"
                    /* No native min/max/step: they veto the submit with a browser
                       bubble before our save-time verdict can name the range. The
                       range lives in the hint text and in the save-time error. */
                    step="any"
                    value={durationText}
                    onChange={e => {
                      setDurationText(e.target.value)
                      setDurationError('')
                    }}
                    disabled={busy}
                    aria-invalid={durationError !== ''}
                    className={cn(
                      'border-input bg-background w-28 rounded-md border px-2.5 py-1.5 text-sm',
                      durationError !== '' && 'border-destructive focus-visible:ring-destructive',
                    )}
                  />
                  <span className="text-muted-foreground text-xs">
                    {t('projects.durationRange', { min: durationRange.minMs / 60_000, max: durationRange.maxMs / 60_000 })}
                  </span>
                </div>
                {durationError !== '' && <p className="text-destructive text-xs">{durationError}</p>}
              </div>
            </div>
          )}
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

export interface EpisodeDialogProps {
  open: boolean
  projectId: string | null
  nextNumber: number
  onOpenChange(open: boolean): void
  onDone(number: number): void
}

export function EpisodeDialog({ open, projectId, nextNumber, onOpenChange, onDone }: EpisodeDialogProps) {
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
      // No targetDurationMs here on purpose: the server seeds it from the
      // project's format default, which is the single source of that number.
      await createEpisode(api, projectId, { number, title })
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

export interface StoryboardDialogProps {
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

export function StoryboardDialog({ state, episodeId, onOpenChange, onDone }: StoryboardDialogProps) {
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
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
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

export interface StatusDialogProps {
  storyboard: Storyboard | null
  onOpenChange(open: boolean): void
  onDone(status: WorkflowStatus): void
}

export function StatusDialog({ storyboard, onOpenChange, onDone }: StatusDialogProps) {
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
