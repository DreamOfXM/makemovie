'use client'

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import {
  CheckIcon,
  DownloadIcon,
  FileJsonIcon,
  PackageIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XCircleIcon,
} from 'lucide-react'
import { ApiError } from '@/lib/api'
import { translateEnum, useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { cn, formatDateTime, formatDuration } from '@/lib/utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { TableSkeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/ui/status-badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { ErrorState } from '@/components/error-state'
import { GuardedButton } from '@/components/permission'

interface ManifestVersionRef {
  version: number
  checksum: string
  status: string
}

interface ManifestArtifact {
  stage: string | null
  objectKey: string
  checksum: string
  mimeType: string
  version: number
  width: number | null
  height: number | null
  durationMs: number | null
}

interface ManifestStoryboard {
  number: number
  title: string
  durationMs: number
  artifacts: ManifestArtifact[]
}

interface DeliveryManifest {
  schemaVersion: number
  packagedAt: string
  episode: { id: string; number: number; title: string }
  source: ManifestVersionRef | null
  script: ManifestVersionRef | null
  storyboards: ManifestStoryboard[]
  composition: { objectKey: string; checksum: string; mimeType: string; durationMs: number | null }
  quality: { checks: number; approved: number; rejected: number; threshold: number }
  acceptance?: { acceptedAt?: string; rejectedAt?: string; reason: string | null }
}

interface Delivery {
  id: string
  status: string
  manifest: DeliveryManifest
}

const EMPTY_DELIVERIES: Delivery[] = []

function toneFor(status: string): string {
  return status.toLowerCase()
}

interface DeliveryPanelProps {
  episodeId: string | null
}

export function DeliveryPanel({ episodeId }: DeliveryPanelProps) {
  const { t, locale } = useI18n()
  const { api, organizationId } = useSession()

  const [packaging, setPackaging] = useState(false)
  const [notReadyReasons, setNotReadyReasons] = useState<string[] | null>(null)
  const [manifestTarget, setManifestTarget] = useState<Delivery | null>(null)
  const [rejectTarget, setRejectTarget] = useState<Delivery | null>(null)
  const [acceptingId, setAcceptingId] = useState<string | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)

  const loadDeliveries = useCallback(
    () =>
      episodeId
        ? api<{ deliveries: Delivery[] }>(`/episodes/${episodeId}/deliveries`).then(result => result.deliveries)
        : Promise.resolve<Delivery[]>(EMPTY_DELIVERIES),
    // organizationId is not in the path but scopes the session token behind `api`.
    [api, episodeId, organizationId],
  )
  const deliveries = useAsync<Delivery[]>(loadDeliveries, EMPTY_DELIVERIES)
  const { reload } = deliveries

  // Stale rejection reasons belong to the previously selected episode.
  useEffect(() => {
    setNotReadyReasons(null)
  }, [episodeId])

  async function packageDelivery() {
    if (!episodeId) return
    setPackaging(true)
    setNotReadyReasons(null)
    try {
      await api<{ delivery: Delivery }>(`/episodes/${episodeId}/deliveries`, { method: 'POST' })
      toast.success(t('delivery.packaged'))
      reload()
    } catch (error) {
      if (error instanceof ApiError && error.message === 'delivery:notReady') {
        const reasons = Array.isArray(error.body?.reasons)
          ? error.body.reasons.filter((reason): reason is string => typeof reason === 'string')
          : []
        setNotReadyReasons(reasons)
        toast.error(t('delivery.notReady'))
      } else {
        toast.error(error instanceof Error ? error.message : t('error.generic'))
      }
    } finally {
      setPackaging(false)
    }
  }

  async function accept(delivery: Delivery) {
    setAcceptingId(delivery.id)
    try {
      await api(`/deliveries/${delivery.id}/accept`, { method: 'POST' })
      toast.success(t('delivery.accepted'))
      reload()
    } catch (error) {
      toast.error(
        error instanceof ApiError && error.message === 'delivery:alreadyAccepted'
          ? t('delivery.alreadyAccepted')
          : error instanceof Error
            ? error.message
            : t('error.generic'),
      )
      reload()
    } finally {
      setAcceptingId(null)
    }
  }

  /**
   * The manifest is fetched through the session api (bearer auth) and handed to
   * the browser as a revocable blob URL — never as a raw API URL in the DOM.
   */
  async function downloadManifest(delivery: Delivery) {
    setDownloadingId(delivery.id)
    try {
      const manifest = await api<DeliveryManifest>(`/deliveries/${delivery.id}/manifest`)
      const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `delivery-${delivery.id}-manifest.json`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      toast.success(t('delivery.manifestDownloaded'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      setDownloadingId(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PackageIcon className="text-muted-foreground size-4" />
          {t('delivery.title')}
        </CardTitle>
        <CardDescription>{t('delivery.subtitle')}</CardDescription>
        {episodeId && (
          <CardAction>
            <div className="flex flex-wrap items-center gap-2">
              <GuardedButton
                action="episode:write"
                size="sm"
                disabled={packaging}
                onClick={() => void packageDelivery()}
              >
                <PackageIcon />
                {packaging ? t('delivery.packaging') : t('delivery.package')}
              </GuardedButton>
              <Button variant="outline" size="sm" onClick={reload} disabled={deliveries.loading}>
                <RefreshCwIcon className={cn(deliveries.loading && 'animate-spin')} />
                {t('common.refresh')}
              </Button>
            </div>
          </CardAction>
        )}
      </CardHeader>

      {!episodeId ? (
        <CardContent>
          <EmptyState icon={<PackageIcon />} title={t('delivery.selectEpisode')} />
        </CardContent>
      ) : deliveries.error ? (
        <CardContent>
          <ErrorState message={deliveries.error} onRetry={reload} />
        </CardContent>
      ) : (
        <CardContent className="space-y-4">
          {notReadyReasons && (
            <Alert variant="warning">
              <TriangleAlertIcon />
              <AlertTitle>{t('delivery.notReady')}</AlertTitle>
              <AlertDescription className="justify-items-start">
                <ul className="list-disc space-y-0.5 pl-4 text-xs">
                  {notReadyReasons.map(reason => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {deliveries.loading && deliveries.data.length === 0 ? (
            <TableSkeleton rows={2} columns={4} />
          ) : deliveries.data.length === 0 ? (
            <EmptyState
              icon={<PackageIcon />}
              title={t('delivery.noDeliveries')}
              description={t('delivery.noDeliveriesHint')}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-36">{t('common.status')}</TableHead>
                  <TableHead className="w-44">{t('delivery.packagedAt')}</TableHead>
                  <TableHead>{t('delivery.quality')}</TableHead>
                  <TableHead className="w-80 text-right">{t('common.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.data.map(delivery => {
                  const accepted = delivery.status === 'APPROVED'
                  return (
                    <TableRow key={delivery.id}>
                      <TableCell>
                        <StatusBadge
                          status={toneFor(delivery.status)}
                          label={translateEnum(t, 'delivery.status', delivery.status)}
                        />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDateTime(delivery.manifest.packagedAt, locale)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {t('delivery.qualitySummary', {
                          checks: delivery.manifest.quality.checks,
                          approved: delivery.manifest.quality.approved,
                          rejected: delivery.manifest.quality.rejected,
                          threshold: delivery.manifest.quality.threshold,
                        })}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setManifestTarget(delivery)}
                          >
                            <FileJsonIcon />
                            {t('delivery.manifest')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={downloadingId === delivery.id}
                            onClick={() => void downloadManifest(delivery)}
                          >
                            <DownloadIcon className={cn(downloadingId === delivery.id && 'animate-pulse')} />
                            {t('delivery.downloadManifest')}
                          </Button>
                          <GuardedButton
                            action="episode:write"
                            variant="ghost"
                            size="sm"
                            disabled={accepted || acceptingId === delivery.id}
                            onClick={() => void accept(delivery)}
                          >
                            <CheckIcon />
                            {t('delivery.accept')}
                          </GuardedButton>
                          <GuardedButton
                            action="episode:write"
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            disabled={accepted}
                            onClick={() => setRejectTarget(delivery)}
                          >
                            <XCircleIcon />
                            {t('delivery.reject')}
                          </GuardedButton>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      )}

      <ManifestDialog delivery={manifestTarget} onOpenChange={open => !open && setManifestTarget(null)} />

      <RejectDialog
        delivery={rejectTarget}
        onOpenChange={open => !open && setRejectTarget(null)}
        onDone={() => {
          setRejectTarget(null)
          toast.success(t('delivery.rejected'))
          reload()
        }}
      />
    </Card>
  )
}

interface ManifestDialogProps {
  delivery: Delivery | null
  onOpenChange(open: boolean): void
}

function ManifestDialog({ delivery, onOpenChange }: ManifestDialogProps) {
  const { t, locale } = useI18n()
  const manifest = delivery?.manifest ?? null

  return (
    <Dialog open={delivery !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('delivery.manifestTitle')}</DialogTitle>
          <DialogDescription>
            {manifest
              ? `${t('projects.episode')} ${manifest.episode.number} · ${manifest.episode.title} · ${formatDateTime(manifest.packagedAt, locale)}`
              : ''}
          </DialogDescription>
        </DialogHeader>

        {manifest && (
          <div className="space-y-5">
            <dl className="space-y-3">
              <DetailRow label={t('delivery.source')}>
                <VersionRefValue reference={manifest.source} />
              </DetailRow>
              <DetailRow label={t('delivery.script')}>
                <VersionRefValue reference={manifest.script} />
              </DetailRow>
              <DetailRow label={t('delivery.composition')}>
                <span className="font-mono text-xs break-all">{manifest.composition.objectKey}</span>
                <span className="text-muted-foreground block text-xs">
                  {manifest.composition.mimeType}
                  {manifest.composition.durationMs !== null && ` · ${formatDuration(manifest.composition.durationMs)}`}
                  {' · '}
                  <span className="font-mono" title={manifest.composition.checksum}>
                    {manifest.composition.checksum.slice(0, 12)}
                  </span>
                </span>
              </DetailRow>
              <DetailRow label={t('delivery.quality')}>
                <span className="text-sm">
                  {t('delivery.qualitySummary', {
                    checks: manifest.quality.checks,
                    approved: manifest.quality.approved,
                    rejected: manifest.quality.rejected,
                    threshold: manifest.quality.threshold,
                  })}
                </span>
              </DetailRow>
              {manifest.acceptance && (
                <DetailRow label={t('delivery.acceptance')}>
                  {manifest.acceptance.acceptedAt && (
                    <span className="text-xs">
                      {t('delivery.acceptedAt')} {formatDateTime(manifest.acceptance.acceptedAt, locale)}
                    </span>
                  )}
                  {manifest.acceptance.rejectedAt && (
                    <span className="text-xs">
                      {t('delivery.rejectedAt')} {formatDateTime(manifest.acceptance.rejectedAt, locale)}
                    </span>
                  )}
                  {manifest.acceptance.reason && (
                    <span className="text-destructive block text-xs">{manifest.acceptance.reason}</span>
                  )}
                </DetailRow>
              )}
            </dl>

            <div className="space-y-3">
              <p className="flex items-center gap-2 text-sm font-medium">
                {t('delivery.storyboards')}
                <Badge variant="secondary">{t('delivery.storyboardCount', { count: manifest.storyboards.length })}</Badge>
              </p>
              {manifest.storyboards.map(storyboard => (
                <div key={storyboard.number} className="space-y-2">
                  <p className="text-sm">
                    <span className="font-medium">{t('storyboards.shot', { number: storyboard.number })}</span>
                    {' · '}
                    {storyboard.title}
                    <span className="text-muted-foreground text-xs"> · {formatDuration(storyboard.durationMs)}</span>
                  </p>
                  {storyboard.artifacts.length === 0 ? (
                    <p className="text-muted-foreground text-xs">{t('delivery.noArtifacts')}</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead className="w-24">{t('delivery.stage')}</TableHead>
                          <TableHead>{t('delivery.objectKey')}</TableHead>
                          <TableHead className="w-28">{t('delivery.mimeType')}</TableHead>
                          <TableHead className="w-14">{t('delivery.artifactVersion')}</TableHead>
                          <TableHead className="w-24">{t('delivery.dimensions')}</TableHead>
                          <TableHead className="w-28">{t('delivery.checksum')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {storyboard.artifacts.map((artifact, index) => (
                          <TableRow key={`${artifact.objectKey}-${artifact.version}-${index}`}>
                            <TableCell className="font-medium">
                              {artifact.stage ? translateEnum(t, 'generations.stage', artifact.stage) : '—'}
                            </TableCell>
                            <TableCell className="font-mono text-xs break-all">{artifact.objectKey}</TableCell>
                            <TableCell className="text-muted-foreground text-xs">{artifact.mimeType}</TableCell>
                            <TableCell className="text-muted-foreground text-xs tabular-nums">{artifact.version}</TableCell>
                            <TableCell className="text-muted-foreground text-xs">
                              {artifact.width !== null && artifact.height !== null
                                ? `${artifact.width}×${artifact.height}`
                                : artifact.durationMs !== null
                                  ? formatDuration(artifact.durationMs)
                                  : '—'}
                            </TableCell>
                            <TableCell className="text-muted-foreground font-mono text-xs" title={artifact.checksum}>
                              {artifact.checksum.slice(0, 12)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DetailRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] items-start gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 space-y-0.5">{children}</dd>
    </div>
  )
}

function VersionRefValue({ reference }: { reference: ManifestVersionRef | null }) {
  const { t } = useI18n()
  if (!reference) return <span className="text-muted-foreground text-xs">{t('common.none')}</span>
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs">
      <span className="font-medium">v{reference.version}</span>
      <StatusBadge status={toneFor(reference.status)} label={t(`status.${toneFor(reference.status)}`)} />
      <span className="text-muted-foreground font-mono" title={reference.checksum}>
        {reference.checksum.slice(0, 12)}
      </span>
    </span>
  )
}

interface RejectDialogProps {
  delivery: Delivery | null
  onOpenChange(open: boolean): void
  onDone(): void
}

function RejectDialog({ delivery, onOpenChange, onDone }: RejectDialogProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!delivery) return
    setReason('')
    setError('')
  }, [delivery])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!delivery) return
    if (!reason.trim()) {
      setError(t('delivery.reasonRequired'))
      return
    }
    setBusy(true)
    setError('')
    try {
      await api(`/deliveries/${delivery.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      })
      onDone()
    } catch (err) {
      setError(
        err instanceof ApiError && err.message === 'delivery:alreadyAccepted'
          ? t('delivery.alreadyAccepted')
          : err instanceof Error
            ? err.message
            : t('error.generic'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={delivery !== null} onOpenChange={open => !busy && onOpenChange(open)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('delivery.rejectTitle')}</DialogTitle>
          <DialogDescription>{t('delivery.rejectHint')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field label={t('delivery.reason')} htmlFor="rejectReason" required error={error || undefined}>
            <Textarea
              id="rejectReason"
              rows={3}
              value={reason}
              onChange={event => setReason(event.target.value)}
              placeholder={t('delivery.reasonPlaceholder')}
              required
              autoFocus
              aria-invalid={error !== ''}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="destructive" disabled={busy || !reason.trim()}>
              {busy ? t('common.saving') : t('delivery.reject')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
