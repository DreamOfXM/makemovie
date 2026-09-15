'use client'

import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { modelModalities } from '@studio/domain'
import {
  CircleAlertIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  RadioTowerIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from 'lucide-react'
import type { Capability, Catalog, Connection, ProbeResponse, ProbeResult } from '@/lib/api'
import { translateEnum, useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import type { AsyncState } from '@/lib/use-async'
import { cn, relativeTime } from '@/lib/utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { EmptyState } from '@/components/ui/empty-state'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TableSkeleton } from '@/components/ui/skeleton'
import { ProbeBadge } from '@/components/ui/status-badge'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ErrorState } from '@/components/error-state'
import { GuardedButton, usePermission } from '@/components/permission'

type DialogState = { mode: 'create' } | { mode: 'edit'; connection: Connection } | null
/** One confirm dialog serves both deletes; a model row is removed from a line, a line takes its models with it. */
type DeleteTarget = { connection: Connection; capability: null } | { connection: Connection; capability: Capability }
/** Only the chat family can be asked about one model without paying for an answer. */
const PROBEABLE_MODALITIES = new Set(['text', 'vlm'])

interface ConnectionsPanelProps {
  connections: AsyncState<Connection[]>
  catalogs: Catalog[]
}

export function ConnectionsPanel({ connections, catalogs }: ConnectionsPanelProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const [dialog, setDialog] = useState<DialogState>(null)
  const [modelDialog, setModelDialog] = useState<Connection | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [probingId, setProbingId] = useState<string | null>(null)
  const [verifyingId, setVerifyingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  async function probe(connection: Connection) {
    setProbingId(connection.id)
    try {
      const result = await api<ProbeResponse>(`/providers/connections/${connection.id}/probe`, { method: 'POST' })
      const verified = result.results.filter(item => item.ok).length
      const failed = result.results.length - verified
      if (verified === 0) toast.error(t('models.probeAllFailed'))
      else toast.success(t('models.probeDone', { verified, failed }))
      connections.reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      setProbingId(null)
    }
  }

  async function verifyModel(capability: Capability) {
    setVerifyingId(capability.id)
    try {
      const result = await api<ProbeResult>(`/providers/capabilities/${capability.id}/probe`, { method: 'POST' })
      if (result.ok) toast.success(t('models.modelVerified', { model: capability.model }))
      else toast.error(result.message ?? t('models.modelNotVerified', { model: capability.model }))
      connections.reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      setVerifyingId(null)
    }
  }

  async function toggleEnabled(connection: Connection, enabled: boolean) {
    try {
      await api(`/providers/connections/${connection.id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) })
      connections.mutate(current => current.map(item => (item.id === connection.id ? { ...item, enabled } : item)))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    }
  }

  async function removeTarget(target: DeleteTarget) {
    setDeleting(true)
    try {
      if (target.capability) {
        await api(`/providers/capabilities/${target.capability.id}`, { method: 'DELETE' })
        toast.success(t('models.modelDeleted', { model: target.capability.model }))
      } else {
        await api(`/providers/connections/${target.connection.id}`, { method: 'DELETE' })
        toast.success(t('models.deleted', { name: target.connection.name }))
      }
      setDeleteTarget(null)
      connections.reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      setDeleting(false)
    }
  }

  if (connections.error) return <ErrorState message={connections.error} onRetry={connections.reload} />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{t('models.connections')}</h2>
          <p className="text-muted-foreground text-sm">{t('models.connectionsHint')}</p>
        </div>
        <GuardedButton action="providers:manage" onClick={() => setDialog({ mode: 'create' })}>
          <PlusIcon />
          {t('models.newConnection')}
        </GuardedButton>
      </div>

      {connections.loading && connections.data.length === 0 ? (
        <Card>
          <TableSkeleton rows={3} columns={5} />
        </Card>
      ) : connections.data.length === 0 ? (
        <EmptyState icon={<PlugIcon />} title={t('models.noConnections')} description={t('models.noConnectionsHint')} />
      ) : (
        <div className="space-y-4">
          {connections.data.map(connection => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              probing={probingId === connection.id}
              verifyingId={verifyingId}
              onProbe={() => probe(connection)}
              onVerify={capability => void verifyModel(capability)}
              onAddModel={() => setModelDialog(connection)}
              onDeleteCapability={capability => setDeleteTarget({ connection, capability })}
              onToggle={enabled => toggleEnabled(connection, enabled)}
              onEdit={() => setDialog({ mode: 'edit', connection })}
              onDelete={() => setDeleteTarget({ connection, capability: null })}
            />
          ))}
        </div>
      )}

      {/* The key remounts the dialog per target so its fields reset without an effect. */}
      <ConnectionDialog
        key={dialog?.mode === 'edit' ? dialog.connection.id : 'create'}
        state={dialog}
        catalogs={catalogs}
        onOpenChange={open => !open && setDialog(null)}
        onDone={() => {
          setDialog(null)
          connections.reload()
        }}
      />

      <AddModelDialog
        key={modelDialog?.id ?? 'no-model'}
        connection={modelDialog}
        onOpenChange={open => !open && setModelDialog(null)}
        onAdded={name => {
          setModelDialog(null)
          toast.success(t('models.modelAdded', { model: name }))
          connections.reload()
        }}
      />

      <AlertDialog open={deleteTarget !== null} onOpenChange={open => !deleting && !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget?.capability ? t('models.deleteModelTitle') : t('models.deleteTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.capability
                ? t('models.deleteModelBody', { model: deleteTarget.capability.model })
                : deleteTarget &&
                  t('models.deleteBody', {
                    name: deleteTarget.connection.name,
                    count: deleteTarget.connection.capabilities.length,
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleting}
              onClick={event => {
                event.preventDefault()
                if (deleteTarget) void removeTarget(deleteTarget)
              }}
            >
              {deleting ? t('common.loading') : t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

interface ConnectionCardProps {
  connection: Connection
  probing: boolean
  verifyingId: string | null
  onProbe(): void
  onVerify(capability: Capability): void
  onAddModel(): void
  onDeleteCapability(capability: Capability): void
  onToggle(enabled: boolean): void
  onEdit(): void
  onDelete(): void
}

function ConnectionCard({
  connection,
  probing,
  verifyingId,
  onProbe,
  onVerify,
  onAddModel,
  onDeleteCapability,
  onToggle,
  onEdit,
  onDelete,
}: ConnectionCardProps) {
  const { t, locale } = useI18n()
  const { can, denyReason } = usePermission()
  const manage = can('providers:manage')

  const toggle = (
    <Switch
      checked={connection.enabled}
      disabled={!manage}
      onCheckedChange={onToggle}
      aria-label={connection.enabled ? t('models.toggleDisabled') : t('models.toggleEnabled')}
    />
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
            <RadioTowerIcon className="size-4.5" />
          </span>
          <div className="min-w-0 space-y-1.5">
            <CardTitle className="flex flex-wrap items-center gap-2">
              {connection.name}
              <Badge variant="outline">{connection.provider}</Badge>
              {connection.apiKeySet ? (
                <Badge variant="muted" className="gap-1">
                  <KeyRoundIcon />
                  {t('models.apiKeySet')}
                </Badge>
              ) : (
                <Badge variant="warning">{t('models.apiKeyMissing')}</Badge>
              )}
            </CardTitle>
            <CardDescription className="truncate font-mono text-xs">{connection.baseUrl}</CardDescription>
          </div>
        </div>
        <CardAction>
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            <div className="flex items-center gap-2">
              {manage ? (
                toggle
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex" tabIndex={0}>
                      {toggle}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{denyReason('providers:manage')}</TooltipContent>
                </Tooltip>
              )}
              <span className={cn('text-xs font-medium', !connection.enabled && 'text-muted-foreground')}>
                {connection.enabled ? t('common.enabled') : t('common.disabled')}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <GuardedButton
                action="providers:manage"
                variant="outline"
                size="sm"
                disabled={probing || !connection.enabled}
                onClick={onProbe}
              >
                {probing ? <LoaderCircleIcon className="animate-spin" /> : <RadioTowerIcon />}
                {probing ? t('models.probing') : t('models.probe')}
              </GuardedButton>
              <GuardedButton
                action="providers:manage"
                variant="ghost"
                size="icon-sm"
                aria-label={t('common.edit')}
                onClick={onEdit}
              >
                <PencilIcon />
              </GuardedButton>
              <GuardedButton
                action="providers:manage"
                variant="ghost"
                size="icon-sm"
                className="text-destructive hover:text-destructive"
                aria-label={t('common.delete')}
                onClick={onDelete}
              >
                <Trash2Icon />
              </GuardedButton>
            </div>
          </div>
        </CardAction>
      </CardHeader>

      {!connection.enabled && (
        <CardContent>
          <Alert variant="warning">
            <CircleAlertIcon />
            <AlertDescription>{t('models.enabledHint')}</AlertDescription>
          </Alert>
        </CardContent>
      )}

      {connection.lastError && (
        <CardContent>
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>{t('models.lastError')}</AlertTitle>
            <AlertDescription className="justify-items-start">
              <p className="font-mono text-xs break-all">{connection.lastError}</p>
            </AlertDescription>
          </Alert>
        </CardContent>
      )}

      <div className="border-t">
        <div className="flex items-center justify-between gap-3 px-6 py-3">
          <p className="text-sm font-medium">{t('models.capabilities')}</p>
          <div className="flex items-center gap-3">
            <Badge variant="muted">{t('models.capabilityCount', { count: connection.capabilities.length })}</Badge>
            <GuardedButton action="providers:manage" variant="ghost" size="sm" onClick={onAddModel}>
              <PlusIcon />
              {t('models.addModel')}
            </GuardedButton>
          </div>
        </div>
        {connection.capabilities.length === 0 ? (
          <p className="text-muted-foreground px-6 pb-6 text-sm">{t('models.emptyConnection')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('common.model')}</TableHead>
                <TableHead>{t('common.modality')}</TableHead>
                <TableHead>{t('models.inputs')}</TableHead>
                <TableHead>{t('models.probe')}</TableHead>
                <TableHead>{t('models.entitlement')}</TableHead>
                <TableHead>{t('common.details')}</TableHead>
                <TableHead className="w-20 text-right">{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {connection.capabilities.map(capability => (
                <CapabilityRow
                  key={capability.id}
                  capability={capability}
                  locale={locale}
                  verifying={verifyingId === capability.id}
                  onVerify={() => onVerify(capability)}
                  onDelete={() => onDeleteCapability(capability)}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </Card>
  )
}

interface CapabilityRowProps {
  capability: Capability
  locale: string
  verifying: boolean
  onVerify(): void
  onDelete(): void
}

function CapabilityRow({ capability, locale, verifying, onVerify, onDelete }: CapabilityRowProps) {
  const { t } = useI18n()
  return (
    <TableRow>
      <TableCell>
        <p className="font-medium">{capability.model}</p>
        {capability.displayName && capability.displayName !== capability.model && (
          <p className="text-muted-foreground text-xs">{capability.displayName}</p>
        )}
      </TableCell>
      <TableCell>
        <Badge variant="outline">{translateEnum(t, 'modality', capability.modality)}</Badge>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {capability.acceptsFirstFrame && <Badge variant="muted">{t('models.firstFrame')}</Badge>}
          {capability.acceptsReferenceImages && (
            <Badge variant="muted">
              {t('models.referenceImages')}
              {capability.maxReferenceImages > 0 ? ` · ${capability.maxReferenceImages}` : ''}
            </Badge>
          )}
          {!capability.acceptsFirstFrame && !capability.acceptsReferenceImages && (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1.5">
          <ProbeBadge status={capability.probeStatus} label={translateEnum(t, 'probe', capability.probeStatus)} />
          <VerifyButton capability={capability} verifying={verifying} onVerify={onVerify} />
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground whitespace-nowrap">
        {capability.entitlementVerifiedAt
          ? relativeTime(capability.entitlementVerifiedAt, locale)
          : t('models.neverProbed')}
      </TableCell>
      <TableCell>
        {capability.probeMessage ? (
          <span
            className="text-muted-foreground block max-w-[14rem] truncate text-xs"
            title={capability.probeMessage}
          >
            {capability.probeMessage}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <GuardedButton
          action="providers:manage"
          variant="ghost"
          size="icon-sm"
          className="text-destructive hover:text-destructive"
          aria-label={t('models.deleteModel')}
          onClick={onDelete}
        >
          <Trash2Icon />
        </GuardedButton>
      </TableCell>
    </TableRow>
  )
}

/**
 * Asking a chat model one question is free enough to do on a click. An image, video or
 * audio endpoint has no such request, so those rows stay grey with the reason on them —
 * they are proven by the first real generation, and a check mark we did not earn is
 * worse than no check mark.
 */
function VerifyButton({ capability, verifying, onVerify }: { capability: Capability; verifying: boolean; onVerify(): void }) {
  const { t } = useI18n()
  const label = t('models.verifyModel')
  if (!PROBEABLE_MODALITIES.has(capability.modality)) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex" tabIndex={0}>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={label} disabled>
              <ShieldCheckIcon />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t('models.probeModelCosts')}</TooltipContent>
      </Tooltip>
    )
  }
  return (
    <GuardedButton
      action="providers:manage"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      disabled={verifying}
      onClick={onVerify}
    >
      {verifying ? <LoaderCircleIcon className="animate-spin" /> : <ShieldCheckIcon />}
    </GuardedButton>
  )
}

interface ConnectionDialogProps {
  state: DialogState
  catalogs: Catalog[]
  onOpenChange(open: boolean): void
  onDone(): void
}

function ConnectionDialog({ state, catalogs, onOpenChange, onDone }: ConnectionDialogProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const editing = state?.mode === 'edit' ? state.connection : null
  const [provider, setProvider] = useState(editing?.provider ?? catalogs[0]?.provider ?? '')
  const [name, setName] = useState(editing?.name ?? '')
  const [apiKey, setApiKey] = useState('')
  const [accessKey, setAccessKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const catalog = catalogs.find(item => item.provider === (editing ? editing.provider : provider))
  const requiresAccessKey = Boolean(catalog?.requiresAccessKey)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (editing) {
        const body: Record<string, string> = { name, baseUrl }
        if (apiKey) body.apiKey = apiKey
        if (accessKey) body.accessKey = accessKey
        await api(`/providers/connections/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) })
        toast.success(t('models.updated', { name }))
      } else {
        const body: Record<string, string> = { provider, name, apiKey }
        if (accessKey) body.accessKey = accessKey
        if (baseUrl.trim()) body.baseUrl = baseUrl.trim()
        const created = await api<Connection>('/providers/connections', { method: 'POST', body: JSON.stringify(body) })
        // A gateway ships no model list, so an empty connection is the honest start —
        // and the cue for the next click, not a finished setup.
        if (created.capabilities.length === 0) toast.success(t('models.createdEmpty', { name: created.name }))
        else toast.success(t('models.created', { name: created.name, count: created.capabilities.length }))
      }
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.generic'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={state !== null} onOpenChange={open => !busy && onOpenChange(open)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? t('models.editConnectionTitle') : t('models.newConnectionTitle')}</DialogTitle>
          <DialogDescription>{t('models.apiKeyHint')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field label={t('common.provider')} htmlFor="connectionProvider" required>
            {editing ? (
              <div className="border-input bg-muted/40 flex h-9 items-center rounded-md border px-3 text-sm">
                {editing.provider}
              </div>
            ) : (
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger id="connectionProvider" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {catalogs.map(item => (
                    <SelectItem key={item.provider} value={item.provider}>
                      {item.label}
                      <span className="text-muted-foreground ml-2 text-xs">{item.provider}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>

          <Field label={t('models.connectionName')} htmlFor="connectionName" required error={error}>
            <Input
              id="connectionName"
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder={t('models.connectionNamePlaceholder')}
              required
              autoFocus
            />
          </Field>

          {requiresAccessKey && (
            <Field
              label={t('models.accessKey')}
              htmlFor="connectionAccessKey"
              required={!editing}
              hint={editing ? t('models.accessKeyRotated') : t('models.keyPairHint')}
            >
              <Input
                id="connectionAccessKey"
                type="password"
                value={accessKey}
                onChange={event => setAccessKey(event.target.value)}
                placeholder={t('models.accessKeyPlaceholder')}
                required={!editing}
                autoComplete="off"
              />
            </Field>
          )}

          <Field
            label={requiresAccessKey ? t('models.secretKey') : t('models.apiKey')}
            htmlFor="connectionApiKey"
            required={!editing}
            hint={editing ? t('models.apiKeyRotated') : t('models.apiKeyHint')}
          >
            <Input
              id="connectionApiKey"
              type="password"
              value={apiKey}
              onChange={event => setApiKey(event.target.value)}
              placeholder={t('models.apiKeyPlaceholder')}
              required={!editing}
              autoComplete="off"
            />
          </Field>

          <Field
            label={t('models.baseUrl')}
            htmlFor="connectionBaseUrl"
            required={!catalog?.defaultBaseUrl}
            hint={
              catalog?.defaultBaseUrl
                ? `${t('models.catalogBaseUrl')}: ${catalog.defaultBaseUrl}`
                : t('models.baseUrlOwnHost')
            }
          >
            <Input
              id="connectionBaseUrl"
              value={baseUrl}
              onChange={event => setBaseUrl(event.target.value)}
              placeholder={catalog?.defaultBaseUrl ?? 'https://gateway.internal/v1'}
            />
          </Field>

          {catalog && (
            <p className="text-muted-foreground text-xs">
              {t('models.capabilityCount', { count: catalog.models.length })} · {t('models.catalogVersion')}{' '}
              <span className="font-mono">{catalog.catalogVersion}</span>
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={
                busy ||
                !name.trim() ||
                (!editing && (!apiKey || (requiresAccessKey && !accessKey) || (!catalog?.defaultBaseUrl && !baseUrl.trim())))
              }
            >
              {busy ? t('common.saving') : editing ? t('common.save') : t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface AddModelDialogProps {
  connection: Connection | null
  onOpenChange(open: boolean): void
  onAdded(model: string): void
}

/**
 * Names a model our catalog cannot: a gateway's own checkpoint, a fine-tune, a newer
 * release on the same connection. The row is born unverified — this dialog claims that a
 * model exists here, only a probe can show that it answers.
 */
function AddModelDialog({ connection, onOpenChange, onAdded }: AddModelDialogProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const [model, setModel] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [modality, setModality] = useState<string>('text')
  const [acceptsFirstFrame, setAcceptsFirstFrame] = useState(false)
  const [acceptsReferenceImages, setAcceptsReferenceImages] = useState(false)
  const [maxReferenceImages, setMaxReferenceImages] = useState('1')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const videoInput = modality === 'i2v' || modality === 'r2v'

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!connection) return
    setBusy(true)
    setError('')
    try {
      const created = await api<Capability>(`/providers/connections/${connection.id}/models`, {
        method: 'POST',
        body: JSON.stringify({
          model: model.trim(),
          displayName: displayName.trim() || undefined,
          modality,
          ...(videoInput ? { acceptsFirstFrame, acceptsReferenceImages, maxReferenceImages: Number(maxReferenceImages) } : {}),
        }),
      })
      onAdded(created.model)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.generic'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={connection !== null} onOpenChange={open => !busy && onOpenChange(open)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('models.addModelTitle')}</DialogTitle>
          <DialogDescription>{t('models.addModelHint')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field label={t('models.modelName')} htmlFor="modelName" required error={error}>
            <Input
              id="modelName"
              value={model}
              onChange={event => setModel(event.target.value)}
              placeholder={t('models.modelNamePlaceholder')}
              required
              autoFocus
            />
          </Field>

          <Field label={t('models.modelDisplayName')} htmlFor="modelDisplayName" hint={t('models.modelDisplayNameHint')}>
            <Input
              id="modelDisplayName"
              value={displayName}
              onChange={event => setDisplayName(event.target.value)}
              placeholder={t('models.modelDisplayNamePlaceholder')}
            />
          </Field>

          <Field label={t('common.modality')} htmlFor="modelModality" required>
            <Select value={modality} onValueChange={setModality}>
              <SelectTrigger id="modelModality" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modelModalities.map(item => (
                  <SelectItem key={item} value={item}>
                    {translateEnum(t, 'modality', item)}
                    <span className="text-muted-foreground ml-2 font-mono text-xs">{item}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {videoInput && (
            <div className="space-y-3 rounded-lg border p-3">
              {modality === 'i2v' && (
                <label className="flex items-center justify-between gap-3 text-sm">
                  <span>{t('models.firstFrame')}</span>
                  <Switch checked={acceptsFirstFrame} onCheckedChange={setAcceptsFirstFrame} />
                </label>
              )}
              {modality === 'r2v' && (
                <>
                  <label className="flex items-center justify-between gap-3 text-sm">
                    <span>{t('models.referenceImages')}</span>
                    <Switch checked={acceptsReferenceImages} onCheckedChange={setAcceptsReferenceImages} />
                  </label>
                  {acceptsReferenceImages && (
                    <Field label={t('models.maxRefs')} htmlFor="modelMaxRefs">
                      <Input
                        id="modelMaxRefs"
                        type="number"
                        min={1}
                        max={8}
                        value={maxReferenceImages}
                        onChange={event => setMaxReferenceImages(event.target.value)}
                        className="w-24"
                      />
                    </Field>
                  )}
                </>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy || !model.trim()}>
              {busy ? t('common.saving') : t('common.add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
