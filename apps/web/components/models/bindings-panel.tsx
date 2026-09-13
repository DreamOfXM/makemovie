'use client'

import { useCallback, useMemo, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { CircleAlertIcon, LinkIcon, ListOrderedIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { canBind, capabilitySlots, slotModality, type CapabilitySlot, type ModelModality } from '@studio/domain'
import type { Binding, Connection, Project, ResolveResponse } from '@/lib/api'
import { translateEnum, useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync, type AsyncState } from '@/lib/use-async'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TableSkeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ErrorState } from '@/components/error-state'
import { GuardedButton, usePermission } from '@/components/permission'

const ALL = '__all__'
const ORG_SCOPE = '__org__'

interface BindableCapability {
  capabilityId: string
  model: string
  displayName: string | null
  modality: string
  connectionId: string
  connectionName: string
  provider: string
  acceptsFirstFrame: boolean
  acceptsReferenceImages: boolean
  maxReferenceImages: number
}

/**
 * Only capabilities on an enabled connection whose entitlement the provider
 * confirmed are offered here — the same two rules `POST /bindings` enforces.
 */
function bindableCapabilities(connections: Connection[]): BindableCapability[] {
  return connections.flatMap(connection =>
    connection.enabled
      ? connection.capabilities
          .filter(capability => capability.entitlementVerifiedAt)
          .map(capability => ({
            capabilityId: capability.id,
            model: capability.model,
            displayName: capability.displayName,
            modality: capability.modality,
            connectionId: connection.id,
            connectionName: connection.name,
            provider: connection.provider,
            acceptsFirstFrame: capability.acceptsFirstFrame,
            acceptsReferenceImages: capability.acceptsReferenceImages,
            maxReferenceImages: capability.maxReferenceImages,
          }))
      : [],
  )
}

function candidatesForSlot(pool: BindableCapability[], slot: CapabilitySlot): BindableCapability[] {
  return pool.filter(item =>
    canBind(slot, {
      provider: item.provider,
      model: item.model,
      modality: item.modality as ModelModality,
      acceptsFirstFrame: item.acceptsFirstFrame,
      acceptsReferenceImages: item.acceptsReferenceImages,
      maxReferenceImages: item.maxReferenceImages,
    }).ok,
  )
}

interface BindingsPanelProps {
  connections: AsyncState<Connection[]>
}

export function BindingsPanel({ connections }: BindingsPanelProps) {
  const { t } = useI18n()
  const { api, organizationId } = useSession()
  const { can } = usePermission()

  const [slotFilter, setSlotFilter] = useState<string>(ALL)
  const [projectFilter, setProjectFilter] = useState<string>(ALL)
  const [bindOpen, setBindOpen] = useState(false)
  const [bindKey, setBindKey] = useState(0)
  const [unbindTarget, setUnbindTarget] = useState<Binding | null>(null)
  const [unbinding, setUnbinding] = useState(false)

  const loadBindings = useCallback(() => api<Binding[]>('/bindings'), [api, organizationId])
  const bindings = useAsync<Binding[]>(loadBindings, [])

  const loadProjects = useCallback(() => api<Project[]>('/projects'), [api, organizationId])
  const projects = useAsync<Project[]>(loadProjects, [])

  const pool = useMemo(() => bindableCapabilities(connections.data), [connections.data])

  const visible = useMemo(
    () =>
      bindings.data.filter(binding => {
        if (slotFilter !== ALL && binding.slot !== slotFilter) return false
        if (projectFilter === ALL) return true
        if (projectFilter === ORG_SCOPE) return binding.projectId === null
        return binding.projectId === projectFilter
      }),
    [bindings.data, slotFilter, projectFilter],
  )

  const resolveSlot = slotFilter === ALL ? null : (slotFilter as CapabilitySlot)
  const resolveProject = projectFilter === ALL || projectFilter === ORG_SCOPE ? null : projectFilter

  const loadResolve = useCallback(() => {
    const query = new URLSearchParams({ slot: resolveSlot ?? capabilitySlots[0] })
    if (resolveProject) query.set('projectId', resolveProject)
    return api<ResolveResponse>(`/bindings/resolve?${query.toString()}`)
  }, [api, resolveSlot, resolveProject])
  const resolved = useAsync<ResolveResponse | null>(resolveSlot ? loadResolve : null, null)

  async function toggleBinding(binding: Binding, enabled: boolean) {
    try {
      await api(`/bindings/${binding.id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) })
      bindings.mutate(current => current.map(item => (item.id === binding.id ? { ...item, enabled } : item)))
      toast.success(enabled ? t('models.bindingEnabled') : t('models.bindingDisabled'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    }
  }

  async function unbind(binding: Binding) {
    setUnbinding(true)
    try {
      await api(`/bindings/${binding.id}`, { method: 'DELETE' })
      toast.success(t('models.unbound'))
      setUnbindTarget(null)
      bindings.reload()
      resolved.reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      setUnbinding(false)
    }
  }

  function projectLabel(projectId: string | null): string {
    if (!projectId) return t('models.scopeOrg')
    return projects.data.find(project => project.id === projectId)?.name ?? projectId
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{t('models.bindings')}</h2>
          <p className="text-muted-foreground text-sm">{t('models.bindingsHint')}</p>
        </div>
        <GuardedButton
          action="bindings:manage"
          onClick={() => {
            setBindKey(key => key + 1)
            setBindOpen(true)
          }}
        >
          <PlusIcon />
          {t('models.bind')}
        </GuardedButton>
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="text-sm">{t('models.currentBindings')}</CardTitle>
          <CardDescription>{t('common.count', { count: visible.length })}</CardDescription>
          <CardAction>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={slotFilter} onValueChange={setSlotFilter}>
                <SelectTrigger size="sm" className="w-56" aria-label={t('models.filterSlot')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>
                    {t('models.filterSlot')}: {t('common.all')}
                  </SelectItem>
                  {capabilitySlots.map(slot => (
                    <SelectItem key={slot} value={slot}>
                      {translateEnum(t, 'slots', slot)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={projectFilter} onValueChange={setProjectFilter}>
                <SelectTrigger size="sm" className="w-48" aria-label={t('models.filterProject')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>
                    {t('models.filterProject')}: {t('common.all')}
                  </SelectItem>
                  <SelectItem value={ORG_SCOPE}>{t('models.scopeOrg')}</SelectItem>
                  {projects.data.map(project => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardAction>
        </CardHeader>

        {bindings.error ? (
          <CardContent>
            <ErrorState message={bindings.error} onRetry={bindings.reload} />
          </CardContent>
        ) : bindings.loading && bindings.data.length === 0 ? (
          <TableSkeleton rows={3} columns={6} />
        ) : visible.length === 0 ? (
          <CardContent>
            <EmptyState icon={<LinkIcon />} title={t('models.noBindings')} description={t('models.noBindingsHint')} />
          </CardContent>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('models.slot')}</TableHead>
                <TableHead>{t('common.model')}</TableHead>
                <TableHead>{t('common.scope')}</TableHead>
                <TableHead>{t('common.priority')}</TableHead>
                <TableHead>{t('common.status')}</TableHead>
                <TableHead className="text-right">{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map(binding => (
                <TableRow key={binding.id}>
                  <TableCell className="font-medium">{translateEnum(t, 'slots', binding.slot)}</TableCell>
                  <TableCell>
                    <p>{binding.capability?.model ?? binding.capabilityId}</p>
                    {binding.capability?.connection && (
                      <p className="text-muted-foreground text-xs">
                        {binding.capability.connection.name} · {binding.capability.connection.provider}
                      </p>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={binding.projectId ? 'info' : 'muted'}>{projectLabel(binding.projectId)}</Badge>
                  </TableCell>
                  <TableCell className="tabular-nums">{binding.priority}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={binding.enabled}
                        disabled={!can('bindings:manage')}
                        onCheckedChange={enabled => toggleBinding(binding, enabled)}
                        aria-label={binding.enabled ? t('common.disable') : t('common.enable')}
                      />
                      <span className="text-muted-foreground text-xs">
                        {binding.enabled ? t('common.enabled') : t('common.disabled')}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <GuardedButton
                      action="bindings:manage"
                      variant="ghost"
                      size="icon-sm"
                      className="text-destructive hover:text-destructive"
                      aria-label={t('common.delete')}
                      onClick={() => setUnbindTarget(binding)}
                    >
                      <Trash2Icon />
                    </GuardedButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <ResolveCard resolved={resolved} slot={resolveSlot} />

      <BindDialog
        key={bindKey}
        open={bindOpen}
        pool={pool}
        projects={projects.data}
        defaultSlot={resolveSlot}
        onOpenChange={setBindOpen}
        onDone={() => {
          setBindOpen(false)
          bindings.reload()
          resolved.reload()
        }}
      />

      <AlertDialog open={unbindTarget !== null} onOpenChange={open => !unbinding && !open && setUnbindTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('models.unbindTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {unbindTarget &&
                t('models.unbindBody', {
                  model: unbindTarget.capability?.model ?? unbindTarget.capabilityId,
                  slot: translateEnum(t, 'slots', unbindTarget.slot),
                })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={unbinding}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={unbinding}
              onClick={event => {
                event.preventDefault()
                if (unbindTarget) void unbind(unbindTarget)
              }}
            >
              {unbinding ? t('common.loading') : t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function ResolveCard({ resolved, slot }: { resolved: AsyncState<ResolveResponse | null>; slot: CapabilitySlot | null }) {
  const { t } = useI18n()
  const candidates = resolved.data?.candidates ?? []

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
            <ListOrderedIcon className="size-4.5" />
          </span>
          <div className="space-y-1.5">
            <CardTitle>{t('models.resolveTitle')}</CardTitle>
            <CardDescription>
              {slot ? t('models.resolved', { slot: translateEnum(t, 'slots', slot) }) : t('models.resolveHint')}
            </CardDescription>
          </div>
        </div>
        {slot && (
          <CardAction>
            <Button variant="outline" size="sm" onClick={resolved.reload} disabled={resolved.loading}>
              {t('models.resolve')}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {!slot ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <CircleAlertIcon className="size-4" />
            {t('models.resolveSelectSlot')}
          </p>
        ) : resolved.error ? (
          <ErrorState message={resolved.error} onRetry={resolved.reload} />
        ) : resolved.loading && !resolved.data ? (
          <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
        ) : candidates.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('models.noCandidates')}</p>
        ) : (
          <ol className="space-y-2">
            {candidates.map((candidate, index) => (
              <li
                key={candidate.bindingId}
                className="bg-muted/40 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2"
              >
                <Badge variant={index === 0 ? 'default' : 'muted'} className="tabular-nums">
                  {t('models.candidateRank', { rank: index + 1 })}
                </Badge>
                <span className="text-sm font-medium">{candidate.model}</span>
                {candidate.displayName && candidate.displayName !== candidate.model && (
                  <span className="text-muted-foreground text-xs">{candidate.displayName}</span>
                )}
                <span className="ml-auto flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{candidate.provider}</Badge>
                  <span className="text-muted-foreground text-xs">{candidate.connectionName}</span>
                  <Badge variant={candidate.scope === 'project' ? 'info' : 'muted'}>
                    {candidate.scope === 'project' ? t('models.scopeProject') : t('models.scopeOrg')}
                  </Badge>
                  <span className="text-muted-foreground text-xs tabular-nums">p{candidate.priority}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}

interface BindDialogProps {
  open: boolean
  pool: BindableCapability[]
  projects: Project[]
  defaultSlot: CapabilitySlot | null
  onOpenChange(open: boolean): void
  onDone(): void
}

function BindDialog({ open, pool, projects, defaultSlot, onOpenChange, onDone }: BindDialogProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const [slot, setSlot] = useState<CapabilitySlot>(defaultSlot ?? capabilitySlots[0])
  const [capabilityId, setCapabilityId] = useState('')
  const [scope, setScope] = useState(ORG_SCOPE)
  const [priority, setPriority] = useState('0')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const candidates = useMemo(() => candidatesForSlot(pool, slot), [pool, slot])
  const selected = candidates.find(item => item.capabilityId === capabilityId)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!selected) return
    setBusy(true)
    setError('')
    try {
      await api('/bindings', {
        method: 'POST',
        body: JSON.stringify({
          slot,
          capabilityId: selected.capabilityId,
          projectId: scope === ORG_SCOPE ? null : scope,
          priority: Number(priority) || 0,
        }),
      })
      toast.success(t('models.bound', { model: selected.model, slot: translateEnum(t, 'slots', slot) }))
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.generic'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={open => !busy && onOpenChange(open)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('models.bindTitle')}</DialogTitle>
          <DialogDescription>{t('models.bindHint')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field label={t('models.slot')} htmlFor="bindingSlot" required>
            <Select
              value={slot}
              onValueChange={value => {
                setSlot(value as CapabilitySlot)
                setCapabilityId('')
              }}
            >
              <SelectTrigger id="bindingSlot" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {capabilitySlots.map(item => (
                  <SelectItem key={item} value={item}>
                    {translateEnum(t, 'slots', item)}
                    <span className="text-muted-foreground ml-2 text-xs">
                      {translateEnum(t, 'modality', slotModality[item])}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label={t('models.capability')} htmlFor="bindingCapability" required error={error}>
            {candidates.length === 0 ? (
              <p className="text-muted-foreground rounded-md border border-dashed px-3 py-6 text-center text-sm">
                {t('models.noVerifiedCapability')}
              </p>
            ) : (
              <Select value={capabilityId} onValueChange={setCapabilityId}>
                <SelectTrigger id="bindingCapability" className="w-full">
                  <SelectValue placeholder={t('models.capability')} />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map(item => (
                    <SelectItem key={item.capabilityId} value={item.capabilityId}>
                      {item.model}
                      <span className="text-muted-foreground ml-2 text-xs">
                        {item.connectionName} · {item.provider}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('common.scope')} htmlFor="bindingScope">
              <Select value={scope} onValueChange={setScope}>
                <SelectTrigger id="bindingScope" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ORG_SCOPE}>{t('models.scopeOrg')}</SelectItem>
                  {projects.map(project => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('common.priority')} htmlFor="bindingPriority">
              <Input
                id="bindingPriority"
                type="number"
                value={priority}
                onChange={event => setPriority(event.target.value)}
              />
            </Field>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy || !selected}>
              {busy ? t('common.saving') : t('models.bind')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
