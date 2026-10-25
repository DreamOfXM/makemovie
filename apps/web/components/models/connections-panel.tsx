'use client'

import { Fragment, useMemo, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { capabilitySlots, modelModalities, modalityInputs, readDurationSpec } from '@studio/domain'
import { apiErrorMessage } from '@/lib/api-error'
import {
  CircleAlertIcon,
  ClockIcon,
  KeyRoundIcon,
  ListOrderedIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  RadioTowerIcon,
  Settings2Icon,
  ShieldCheckIcon,
  Trash2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
} from 'lucide-react'
import { patchDurationEvidence, type Binding, type CatalogModel, type Capability, type Catalog, type Connection, type DurationEvidence, type ProbeResponse, type ProbeResult } from '@/lib/api'
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
import { HelpHint } from '@/components/ui/help-hint'
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
  bindings: AsyncState<Binding[]>
  onManageDefaults(): void
}

export function ConnectionsPanel({ connections, catalogs, bindings, onManageDefaults }: ConnectionsPanelProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const [dialog, setDialog] = useState<DialogState>(null)
  const [modelDialog, setModelDialog] = useState<Connection | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [probingId, setProbingId] = useState<string | null>(null)
  const [verifyingId, setVerifyingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  // The space's production line: which model answers each slot for every project
  // that never overrode it. Read-only here; the binding itself is managed in 模型绑定.
  const defaultChains = useMemo(
    () =>
      capabilitySlots
        .map(slot => ({
          slot,
          chain: bindings.data
            .filter(binding => binding.slot === slot && binding.projectId === null && binding.enabled && binding.capability)
            .sort((a, b) => b.priority - a.priority)
            .map(binding => ({ id: binding.id, model: binding.capability?.model ?? binding.capabilityId })),
        }))
        .filter(entry => entry.chain.length > 0),
    [bindings.data],
  )

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
      toast.error(apiErrorMessage(error, t))
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
      toast.error(apiErrorMessage(error, t))
    } finally {
      setVerifyingId(null)
    }
  }

  async function toggleEnabled(connection: Connection, enabled: boolean) {
    try {
      await api(`/providers/connections/${connection.id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) })
      connections.mutate(current => current.map(item => (item.id === connection.id ? { ...item, enabled } : item)))
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
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
      toast.error(apiErrorMessage(error, t))
    } finally {
      setDeleting(false)
    }
  }

  if (connections.error) return <ErrorState message={connections.error} onRetry={connections.reload} />

  return (
    <div className="space-y-4">
      <div id="connections-panel" className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold flex items-center gap-1.5">{t('models.connections')}<HelpHint text={t('models.connectionsHint')} /></h2>

        </div>
        <GuardedButton action="providers:manage" onClick={() => setDialog({ mode: 'create' })}>
          <PlusIcon />
          {t('models.newConnection')}
        </GuardedButton>
      </div>

      <Card>
        <CardHeader className="border-b">
          <div className="flex items-start gap-3">
            <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
              <ListOrderedIcon className="size-4.5" />
            </span>
            <div className="space-y-1.5">
              <CardTitle>{t('models.defaultChainTitle')}</CardTitle>
              <CardDescription>{t('models.defaultChainHint')}</CardDescription>
            </div>
          </div>
          <CardAction>
            <Button variant="outline" size="sm" onClick={onManageDefaults}>
              <Settings2Icon />
              {t('models.manageDefaults')}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {defaultChains.length === 0 ? (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <CircleAlertIcon className="size-4" />
              {t('models.defaultChainEmpty')}
            </p>
          ) : (
            <div className="space-y-2">
              {defaultChains.map(entry => (
                <div key={entry.slot} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2">
                  <span className="w-40 shrink-0 text-sm font-medium">{translateEnum(t, 'slots', entry.slot)}</span>
                  <span className="flex flex-wrap items-center gap-1">
                    {entry.chain.map((candidate, index) => (
                      <Fragment key={candidate.id}>
                        {index > 0 && <span className="text-muted-foreground text-xs">→</span>}
                        <Badge variant={index === 0 ? 'tinted' : 'muted'}>{candidate.model}</Badge>
                      </Fragment>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {connections.loading && connections.data.length === 0 ? (
        <Card>
          <TableSkeleton rows={3} columns={5} />
        </Card>
      ) : connections.data.length === 0 ? (
        <EmptyState icon={<PlugIcon />} title={t('models.noConnections')} description={t('models.noConnectionsHint')} />
      ) : (
        <div className="space-y-4">
          {connections.data.map((connection, index) => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              probing={probingId === connection.id}
              verifyingId={verifyingId}
              probeAnchor={index === 0 ? 'probe-first' : undefined}
              onProbe={() => probe(connection)}
              onVerify={capability => void verifyModel(capability)}
              onEvidenceSaved={connections.reload}
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
        catalogs={catalogs}
        onOpenChange={open => !open && setModelDialog(null)}
        onAdded={name => {
          setModelDialog(null)
          toast.success(t('models.modelAdded', { model: name }))
          // 手动添加的模型天生未验证,而视频/图片类无法单模型验证——自动补一轮
          // 连接探测(密钥级,极小开销),让新模型立即可绑定,否则它是死锁状态。
          void (async () => {
            try {
              await api<ProbeResponse>(`/providers/connections/${modelDialog?.id ?? ''}/probe`, { method: 'POST' })
              toast.success(t('models.autoProbed'))
            } catch {
              // 自动探测失败不打断:用户仍可手动点探测。
            }
            connections.reload()
          })()
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
  /** Flow-guide step 2 lands here: the first connection's probe control. */
  probeAnchor?: string
  onProbe(): void
  onVerify(capability: Capability): void
  onEvidenceSaved(): void
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
  probeAnchor,
  onProbe,
  onVerify,
  onEvidenceSaved,
  onAddModel,
  onDeleteCapability,
  onToggle,
  onEdit,
  onDelete,
}: ConnectionCardProps) {
  const { t, locale } = useI18n()
  const { can, denyReason } = usePermission()
  const manage = can('providers:manage')
  // 模型清单是查阅型内容：卡片默认收起，探测/启停/编辑留在卡头常驻。
  const [modelsOpen, setModelsOpen] = useState(false)

  const toggle = (
    <Switch
      checked={connection.enabled}
      disabled={!manage}
      onCheckedChange={onToggle}
      aria-label={connection.enabled ? t('models.toggleDisabled') : t('models.toggleEnabled')}
    />
  )

  return (
    <Card className="gap-4 py-4">
      <CardHeader>
        <div className="flex items-start gap-3">
          <button
            type="button"
            aria-expanded={modelsOpen}
            aria-label={modelsOpen ? t('common.collapse') : t('common.expand')}
            onClick={() => setModelsOpen(value => !value)}
            className="text-muted-foreground hover:text-foreground mt-1 shrink-0"
          >
            {modelsOpen ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
          </button>
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
              <Badge variant="outline">{t('models.capabilityCount', { count: connection.capabilities.length })}</Badge>
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
              <span id={probeAnchor} className="inline-flex">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex" tabIndex={0}>
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
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">{t('models.probeHelp')}</TooltipContent>
                </Tooltip>
              </span>
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
              {/* The banner survives until the next connection-level probe clears
                  it, so its age is the difference between "broken now" and an
                  "old failure already fixed" — say which. */}
              <p className="text-muted-foreground text-xs">
                {t('models.lastErrorAt', { when: relativeTime(connection.updatedAt, locale) })}
              </p>
            </AlertDescription>
          </Alert>
        </CardContent>
      )}

      {modelsOpen && (
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
                <TableHead className="whitespace-nowrap">
                  {t('models.specColumn')}
                  <HelpHint text={t('models.specColumnHint')} />
                </TableHead>
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
                  onEvidenceSaved={onEvidenceSaved}
                  onDelete={() => onDeleteCapability(capability)}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      )}
    </Card>
  )
}

interface CapabilityRowProps {
  capability: Capability
  locale: string
  verifying: boolean
  onVerify(): void
  onEvidenceSaved(): void
  onDelete(): void
}

function CapabilityRow({ capability, locale, verifying, onVerify, onEvidenceSaved, onDelete }: CapabilityRowProps) {
  const { t } = useI18n()
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const evidence = capability.durationEvidence
  const declaredLength = declaredLengthLabel(t, capability.spec)
  return (
    <TableRow>
      <TableCell>
        <p className="font-medium">{capability.model}</p>
        {capability.displayName && capability.displayName !== capability.model && (
          <p className="text-muted-foreground text-xs">{capability.displayName}</p>
        )}
        {/* 实测/文档留痕挂在模型名下：预审门的上限就是按它算的，读数要跟模型放一起看。 */}
        {evidence && (
          <p className="text-muted-foreground text-xs">
            {evidence.source === 'probe'
              ? t('models.durationEvidenceProbe', { seconds: evidence.verifiedSeconds ?? 0, date: evidence.checkedAt })
              : evidence.source === 'doc'
                ? t('models.durationEvidenceDoc', { seconds: evidence.declaredSeconds ?? 0, date: evidence.checkedAt })
                : t('models.durationEvidenceManual', { date: evidence.checkedAt })}
          </p>
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
        <Badge variant={capability.specSource === 'unknown' ? 'warning' : capability.specSource === 'manual' ? 'outline' : 'muted'}>
          {specSourceLabel(t, capability.specSource)}
        </Badge>
        {declaredLength && <p className="text-muted-foreground mt-1 text-xs">{declaredLength}</p>}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1.5">
          <ProbeBadge status={capability.probeStatus} label={translateEnum(t, 'probe', capability.probeStatus)} />
          <VerifyButton capability={capability} verifying={verifying} onVerify={onVerify} />
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {capability.entitlementVerifiedAt ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-success">
                {t('models.entitlementVerified')} · {relativeTime(capability.entitlementVerifiedAt, locale)}
              </span>
            </TooltipTrigger>
            <TooltipContent>{t('models.entitlementHint')}</TooltipContent>
          </Tooltip>
        ) : capability.credentialVerifiedAt ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-muted-foreground">
                {t('models.credentialOnly')} · {relativeTime(capability.credentialVerifiedAt, locale)}
              </span>
            </TooltipTrigger>
            <TooltipContent>{t('models.credentialHint')}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-muted-foreground">{t('models.neverProbed')}</span>
        )}
      </TableCell>
      <TableCell>
        {capability.probeMessage ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-muted-foreground block max-w-[14rem] truncate text-xs">
                {capability.probeStatus === 'verified' && /^probe ok/i.test(capability.probeMessage)
                  ? t('models.probeOkDetail')
                  : capability.probeMessage}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs break-all">{capability.probeMessage}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex" tabIndex={0}>
                <GuardedButton
                  action="providers:manage"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('models.durationEvidenceEdit')}
                  onClick={() => setEvidenceOpen(true)}
                >
                  <ClockIcon />
                </GuardedButton>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{t('models.durationEvidenceHint')}</TooltipContent>
          </Tooltip>
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
        </div>
      </TableCell>
      <DurationEvidenceDialog
        capability={capability}
        open={evidenceOpen}
        onClose={() => setEvidenceOpen(false)}
        onSaved={() => {
          setEvidenceOpen(false)
          onEvidenceSaved()
        }}
      />
    </TableRow>
  )
}

/** 这份声明从哪来的——三种来源要能一眼分开，最后一种按厂商默认计费。 */
function specSourceLabel(t: (key: string, values?: Record<string, string | number>) => string, source: string): string {
  if (source === 'manual') return t('models.specSourceManual')
  if (source === 'unknown') return t('models.specSourceUnknown')
  return t('models.specSourceCatalog')
}

/** 把声明的时长翻成人话；界面上不出现 kind/range/steps 这些内部字段名。 */
function declaredLengthLabel(t: (key: string, values?: Record<string, string | number>) => string, spec: unknown): string | null {
  const duration = readDurationSpec(spec)
  if (!duration) return null
  if (duration.kind === 'range') return t('models.specSecondsRange', { min: duration.min, max: duration.max })
  if (duration.kind === 'fixed') return t('models.specSecondsFixed', { seconds: duration.value })
  return t('models.specSecondsList', { values: duration.values.join(' / ') })
}

/** The modalities billed per second, so the only ones whose lengths must be known. */
const SECONDS_BILLED_MODALITIES = new Set(['t2v', 'i2v', 'r2v'])

/** `720P, 1080P` and `720P 1080P` are the same list; the platform caps it at twelve tiers. */
function splitTiers(value: string): string[] {
  return [...new Set(value.split(/[,;\s]+/).map(item => item.trim()).filter(item => item !== ''))].slice(0, 12)
}

/**
 * The catalog row a typed name means, matched exactly the way the API matches it:
 * case-insensitively, preferring the row filed under the chosen modality. Only the
 * vendor's own rows count — the org's overlay rows have no spec to inherit.
 */
function findOfficialModel(catalogs: Catalog[], provider: string | undefined, model: string, modality: string): CatalogModel | undefined {
  if (!provider) return undefined
  const wanted = model.trim().toLowerCase()
  if (wanted === '') return undefined
  const rows = (catalogs.find(entry => entry.provider === provider)?.models ?? []).filter(
    entry => entry.source !== 'custom' && entry.model.trim().toLowerCase() === wanted,
  )
  return rows.find(entry => entry.modality === modality) ?? rows[0]
}

/**
 * 一镜上限的「凭什么」：实测过的秒数会真的下调预检上限，文档/手记只做标注。
 * 记错也要能撤回——null 是显式撤回，不是没填。
 */
function DurationEvidenceDialog({ capability, open, onClose, onSaved }: {
  capability: Capability
  open: boolean
  onClose(): void
  onSaved(): void
}) {
  const { t } = useI18n()
  const { api } = useSession()
  const existing = capability.durationEvidence
  const [source, setSource] = useState<DurationEvidence['source']>(existing?.source ?? 'manual')
  const [seconds, setSeconds] = useState(() => String(existing?.verifiedSeconds ?? existing?.declaredSeconds ?? ''))
  const [checkedAt, setCheckedAt] = useState(existing?.checkedAt ?? new Date().toISOString().slice(0, 10))
  const [url, setUrl] = useState(existing?.url ?? '')
  const [note, setNote] = useState(existing?.note ?? '')
  const [saving, setSaving] = useState(false)

  const measured = Number(seconds)
  const needsSeconds = source !== 'manual'

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (needsSeconds && !(Number.isFinite(measured) && measured > 0)) {
      toast.error(t('models.durationEvidenceVerifiedRequired'))
      return
    }
    const evidence: DurationEvidence = {
      source,
      checkedAt,
      ...(needsSeconds && Number.isFinite(measured) && measured > 0
        ? source === 'probe' ? { verifiedSeconds: measured } : { declaredSeconds: measured }
        : {}),
      ...(url.trim() ? { url: url.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    }
    setSaving(true)
    try {
      await patchDurationEvidence(api, capability.id, evidence)
      toast.success(t('models.durationEvidenceSaved', { model: capability.model }))
      onSaved()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setSaving(false)
    }
  }

  async function clear() {
    setSaving(true)
    try {
      await patchDurationEvidence(api, capability.id, null)
      toast.success(t('models.durationEvidenceCleared', { model: capability.model }))
      onSaved()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={value => !value && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('models.durationEvidenceTitle', { model: capability.model })}</DialogTitle>
          <DialogDescription>{t('models.durationEvidenceHint')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={event => void submit(event)} className="space-y-3">
          <Field label={t('models.durationEvidenceSource')}>
            <Select value={source} onValueChange={value => setSource(value as DurationEvidence['source'])}>
              <SelectTrigger aria-label={t('models.durationEvidenceSource')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="probe">{translateEnum(t, 'models.durationEvidenceSource', 'probe')}</SelectItem>
                <SelectItem value="doc">{translateEnum(t, 'models.durationEvidenceSource', 'doc')}</SelectItem>
                <SelectItem value="manual">{translateEnum(t, 'models.durationEvidenceSource', 'manual')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {needsSeconds && (
            <Field label={t('models.durationEvidenceSeconds')}>
              <Input
                type="number"
                min={0.1}
                step={0.1}
                value={seconds}
                required
                onChange={event => setSeconds(event.target.value)}
                className="tabular-nums"
              />
            </Field>
          )}
          <Field label={t('models.durationEvidenceDate')}>
            <Input type="date" value={checkedAt} required onChange={event => setCheckedAt(event.target.value)} />
          </Field>
          {source === 'doc' && (
            <Field label={t('models.durationEvidenceUrl')}>
              <Input type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://" />
            </Field>
          )}
          <Field label={t('models.durationEvidenceNote')}>
            <Input value={note} onChange={event => setNote(event.target.value)} />
          </Field>
          <DialogFooter>
            {existing && (
              <Button type="button" variant="outline" className="text-destructive" disabled={saving} onClick={() => void clear()}>
                {t('models.durationEvidenceClear')}
              </Button>
            )}
            <Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={saving}>
              {saving ? <LoaderCircleIcon className="animate-spin" /> : null}
              {t('models.durationEvidenceSave')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Every row can be probed: text/vlm rows get a model-addressed entitlement check;
 * generation rows (image/video/tts/music) get a credential ping that stamps only the
 * key tier — their entitlement is proven by the first real generation.
 */
function VerifyButton({ capability, verifying, onVerify }: { capability: Capability; verifying: boolean; onVerify(): void }) {
  const { t } = useI18n()
  const label = t('models.verifyModel')
  const generationModality = !PROBEABLE_MODALITIES.has(capability.modality)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" tabIndex={0}>
          <GuardedButton
            action="providers:manage"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            disabled={verifying}
            onClick={onVerify}
          >
            {verifying ? <LoaderCircleIcon className="animate-spin" /> : <ShieldCheckIcon />}
          </GuardedButton>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {generationModality ? t('models.verifyCredentialHint') : t('models.probeModelCosts')}
      </TooltipContent>
    </Tooltip>
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
      setError(apiErrorMessage(err, t))
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
                autoComplete="new-password"
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
              // new-password 是拦浏览器密码管理器自动填充的标准开关——off 会被
              // Chrome 忽略。曾发生:用户浏览器存过一条测试密钥,弹窗一开就被
              // 自动填进密钥框,用户以为系统在偷填数据(2026-10-19 用户实测)。
              autoComplete="new-password"
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
  catalogs: Catalog[]
  onOpenChange(open: boolean): void
  onAdded(model: string): void
}

/**
 * Names a model our catalog cannot: a gateway's own checkpoint, a fine-tune, a newer
 * release on the same connection. The row is born unverified — this dialog claims that a
 * model exists here, only a probe can show that it answers.
 *
 * A row the catalog does know is not hand-entered at all: its declaration is inherited,
 * and the dialog says so instead of letting an empty spec through — an empty spec is what
 * made a shot bill at whatever the vendor defaults to (SD-166).
 */
function AddModelDialog({ connection, catalogs, onOpenChange, onAdded }: AddModelDialogProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const [model, setModel] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [modality, setModality] = useState<string>('text')
  const [acceptsFirstFrame, setAcceptsFirstFrame] = useState(false)
  const [acceptsReferenceImages, setAcceptsReferenceImages] = useState(false)
  const [maxReferenceImages, setMaxReferenceImages] = useState('1')
  const [durationKind, setDurationKind] = useState<'range' | 'steps' | 'fixed'>('range')
  const [durationMin, setDurationMin] = useState('')
  const [durationMax, setDurationMax] = useState('')
  const [durationSteps, setDurationSteps] = useState('')
  const [durationFixed, setDurationFixed] = useState('')
  const [resolutions, setResolutions] = useState('')
  const [error, setError] = useState('')
  const [specError, setSpecError] = useState('')
  const [busy, setBusy] = useState(false)

  const inputs = modalityInputs(modality)
  const billedBySecond = SECONDS_BILLED_MODALITIES.has(modality)
  const catalogRow = findOfficialModel(catalogs, connection?.provider, model, modality)
  // A catalog row that states the lengths is the answer already; one that states nothing
  // is not, and the operator still has to say. Mirrors the API's own predicate.
  const inheritedDuration = catalogRow ? readDurationSpec(catalogRow.spec) : undefined
  const mustDeclare = billedBySecond && connection?.provider !== 'mock' && inheritedDuration === undefined

  function buildDuration(): Record<string, unknown> | undefined {
    const positiveInt = (value: string) => {
      const parsed = Number(value.trim())
      return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
    }
    if (durationKind === 'range') {
      const min = positiveInt(durationMin)
      const max = positiveInt(durationMax)
      return min !== undefined && max !== undefined && max >= min ? { kind: 'range', min, max } : undefined
    }
    if (durationKind === 'fixed') {
      const value = positiveInt(durationFixed)
      return value === undefined ? undefined : { kind: 'fixed', value }
    }
    const values = splitTiers(durationSteps).map(positiveInt)
    return values.length > 0 && values.every(value => value !== undefined)
      ? { kind: 'steps', values: values as number[] }
      : undefined
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!connection) return
    const duration = mustDeclare ? buildDuration() : undefined
    if (mustDeclare && duration === undefined) {
      // Refusing here is the honest option: a row that stored no length sends no length,
      // and the clip then comes back at whatever the vendor feels like.
      setSpecError(t('models.durationRequired'))
      return
    }
    const tiers = splitTiers(resolutions)
    setBusy(true)
    setError('')
    setSpecError('')
    try {
      const created = await api<Capability>(`/providers/connections/${connection.id}/models`, {
        method: 'POST',
        body: JSON.stringify({
          model: model.trim(),
          displayName: displayName.trim() || undefined,
          modality,
          ...(inputs.takesInput ? { ...(inputs.firstFrame ? { acceptsFirstFrame } : {}), acceptsReferenceImages, ...(acceptsReferenceImages ? { maxReferenceImages: Number(maxReferenceImages) } : {}) } : {}),
          ...(duration !== undefined ? { duration } : {}),
          ...(mustDeclare && tiers.length > 0 ? { resolutions: tiers } : {}),
        }),
      })
      onAdded(created.model)
    } catch (err) {
      setError(apiErrorMessage(err, t))
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

          {billedBySecond && connection?.provider !== 'mock' && (
            mustDeclare ? (
              <div className="space-y-3 rounded-lg border p-3">
                <p className="text-sm font-medium">
                  {t('models.declareSpecTitle')}
                  <HelpHint text={t('models.declareSpecHint')} />
                </p>
                <Field label={t('models.durationKind')} htmlFor="modelDurationKind" required error={specError}>
                  <Select value={durationKind} onValueChange={value => setDurationKind(value as 'range' | 'steps' | 'fixed')}>
                    <SelectTrigger id="modelDurationKind" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="range">{t('models.durationKindRange')}</SelectItem>
                      <SelectItem value="steps">{t('models.durationKindSteps')}</SelectItem>
                      <SelectItem value="fixed">{t('models.durationKindFixed')}</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                {durationKind === 'range' && (
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t('models.durationMin')} htmlFor="modelDurationMin" required>
                      <Input id="modelDurationMin" type="number" min={1} step={1} value={durationMin} onChange={event => setDurationMin(event.target.value)} className="w-full" />
                    </Field>
                    <Field label={t('models.durationMax')} htmlFor="modelDurationMax" required>
                      <Input id="modelDurationMax" type="number" min={1} step={1} value={durationMax} onChange={event => setDurationMax(event.target.value)} className="w-full" />
                    </Field>
                  </div>
                )}
                {durationKind === 'steps' && (
                  <Field label={t('models.durationSteps')} htmlFor="modelDurationSteps" required>
                    <Input id="modelDurationSteps" value={durationSteps} onChange={event => setDurationSteps(event.target.value)} placeholder={t('models.durationStepsPlaceholder')} className="w-full" />
                  </Field>
                )}
                {durationKind === 'fixed' && (
                  <Field label={t('models.durationFixed')} htmlFor="modelDurationFixed" required>
                    <Input id="modelDurationFixed" type="number" min={1} step={1} value={durationFixed} onChange={event => setDurationFixed(event.target.value)} className="w-24" />
                  </Field>
                )}
                <Field label={t('models.resolutions')} htmlFor="modelResolutions" hint={t('models.resolutionsHint')}>
                  <Input id="modelResolutions" value={resolutions} onChange={event => setResolutions(event.target.value)} placeholder={t('models.resolutionsPlaceholder')} className="w-full" />
                </Field>
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">
                {t('models.inheritedSpec', { length: declaredLengthLabel(t, catalogRow?.spec) ?? '' })}
                <HelpHint text={t('models.inheritedSpecHint')} />
              </p>
            )
          )}

          {inputs.takesInput && (
            <div className="space-y-3 rounded-lg border p-3">
              {inputs.firstFrame && (
                <label className="flex items-center justify-between gap-3 text-sm">
                  <span>{t('models.firstFrame')}</span>
                  <Switch checked={acceptsFirstFrame} onCheckedChange={setAcceptsFirstFrame} />
                </label>
              )}
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
