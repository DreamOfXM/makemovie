'use client'

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { apiErrorMessage } from '@/lib/api-error'
import {
  CheckIcon,
  DownloadIcon,
  FileJsonIcon,
  FileTextIcon,
  LoaderCircleIcon,
  PackageIcon,
  RefreshCwIcon,
  ScissorsIcon,
  TriangleAlertIcon,
  XCircleIcon,
} from 'lucide-react'
import { ApiError, API_BASE, getToken } from '@/lib/api'
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
import { HelpHint } from '@/components/ui/help-hint'
import { TableSkeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/ui/status-badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ErrorState } from '@/components/error-state'
import { GuardedButton } from '@/components/permission'
import type { ShotRhythm } from '@/components/sources/sources-panel'

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

interface ManifestLabeling {
  standard: string
  badgeText: string
  explicit: 'burned' | 'skipped' | 'unrecorded'
  implicit: 'written' | 'unrecorded'
  reason?: string
}

interface ManifestPostProcess {
  status: 'applied' | 'fallback'
  steps: Array<{ step: 'loudnorm' | 'upscale' | 'interpolate' | 'grade'; outcome: 'applied' | 'skipped'; reason?: string }>
  loudness?: { before: { i: number; tp: number }; after?: { i: number; tp: number } }
  target?: { i: number; tp: number }
  reason?: string
}

/** 验收三读数（S5）：与 @studio/pipeline 的 review-readings 同形，web 不能 import 该包，故在此重述。
 *  节奏那一份直接借用「原文」面板已有的 ShotRhythm——同一把尺量出来的数，不许长成两个类型。 */
interface ManifestReviewAxis {
  present: boolean
  gaps: string[]
}

interface ManifestRhythm extends ManifestReviewAxis, Pick<ShotRhythm, 'settings' | 'gate'> {
  masterDurationMs: number | null
  readings: ShotRhythm['readings']
}

interface ManifestTransition extends ManifestReviewAxis {
  kinds: string[]
  blendedSeamCount: number
  requestedNonCutCount: number | null
  blended: boolean
  headFadeMs: number
  tailFadeMs: number
  fps: number | null
  shotCount: number
}

interface ManifestSound extends ManifestReviewAxis {
  dialogueShotCount: number
  silentDialogueShots: number[]
  bedCount: number
  importedBedCount: number
  hasMusic: boolean
}

interface ManifestReview {
  rhythm: ManifestRhythm
  transition: ManifestTransition
  sound: ManifestSound
  complete: boolean
}

const REVIEW_AXES = ['rhythm', 'transition', 'sound'] as const

interface DeliveryManifest {
  schemaVersion: number
  packagedAt: string
  episode: { id: string; number: number; title: string }
  source: ManifestVersionRef | null
  script: ManifestVersionRef | null
  // Optional because a manifest packaged before labeling existed still loads; the UI
  // reads an absent record as "this master was composed before labeling shipped".
  labeling?: ManifestLabeling | null
  // Same absent-record reading as labeling: a pre-quality-floor master says so, it is
  // never rendered as if it had been normalized.
  postProcess?: ManifestPostProcess | null
  storyboards: ManifestStoryboard[]
  // Optional because a manifest packaged before tracks existed still loads; the UI reads
  // an absent list as "not recorded" and an empty one as "the master is silent".
  composition: { objectKey: string; checksum: string; mimeType: string; durationMs: number | null; tracks?: ManifestArtifact[] }
  quality: { checks: number; approved: number; rejected: number; threshold: number }
  // 缺这一行 = 清单打包于验收读数上线之前；界面按「未记录」读，不补一个假读数。
  review?: ManifestReview
  acceptance?: { acceptedAt?: string; rejectedAt?: string; reason: string | null }
}

interface Delivery {
  id: string
  status: string
  /** The composed master clip this delivery ships. */
  artifactId: string | null
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
  const [notReadyShots, setNotReadyShots] = useState<number[]>([])
  const [pendingAdjudications, setPendingAdjudications] = useState<number | null>(null)
  const [reviewGaps, setReviewGaps] = useState<string[] | null>(null)
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
    setNotReadyShots([])
    setPendingAdjudications(null)
    setReviewGaps(null)
  }, [episodeId])

  // 缺画面的镜头可能有三四十个，逐条列会把警告撑成一屏；报前 8 个 + 总数，
  // 完整名单在镜头总览的待处理泳道里逐个可见。
  const gapShotList = notReadyShots.length === 0
    ? ''
    : `${notReadyShots.slice(0, 8).map(number => `#${number}`).join('、')}${notReadyShots.length > 8 ? t('delivery.gap.shotsMore', { count: notReadyShots.length }) : ''}`

  // 质检门禁拦下打包时，后端 reasons 是一条条 QC 结论原文——实测一集 55 条，整段上屏
  // 等于把裁决队列倒进警告条，人一条也读不完；不接住则退成一句通用报错，等于没说。
  // 这里只报「还差几条」，原文进 console 供排查，逐条裁决在「质检裁决」面板里做。
  function handleQualityGate(error: unknown): boolean {
    if (!(error instanceof ApiError) || error.message !== 'delivery:qualityGate') return false
    const reasons = Array.isArray(error.body?.reasons) ? error.body.reasons : []
    setPendingAdjudications(typeof error.body?.pendingCount === 'number' ? error.body.pendingCount : reasons.length)
    console.warn('[delivery] quality gate findings:', reasons)
    return true
  }

  function goToAdjudication() {
    // 认 EpisodeFlow 给每个块挂的 `id` + `scroll-mt-20`（吸顶条要让位），
    // 不是内层那个 data-flow-step 包装——它没有 scroll-margin，跳过去标题正压在天头下面。
    document.getElementById('step-quality')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  async function packageDelivery() {
    if (!episodeId) return
    setPackaging(true)
    setNotReadyReasons(null)
    setNotReadyShots([])
    setPendingAdjudications(null)
    setReviewGaps(null)
    try {
      await api<{ delivery: Delivery }>(`/episodes/${episodeId}/deliveries`, { method: 'POST' })
      toast.success(t('delivery.packaged'))
      reload()
    } catch (error) {
      if (error instanceof ApiError && error.message === 'delivery:notReady') {
        const reasons = Array.isArray(error.body?.reasons)
          ? error.body.reasons.filter((reason): reason is string => typeof reason === 'string')
          : []
        const shots = Array.isArray(error.body?.shotNumbers)
          ? error.body.shotNumbers.filter((n): n is number => typeof n === 'number')
          : []
        setNotReadyReasons(reasons)
        setNotReadyShots(shots)
        toast.error(t('delivery.notReady'))
      } else if (handleQualityGate(error)) {
        // 门禁结论已经摊在卡片上了，这里什么都不该再说一遍。
      } else {
        toast.error(apiErrorMessage(error, t))
      }
    } finally {
      setPackaging(false)
    }
  }

  async function accept(delivery: Delivery) {
    setAcceptingId(delivery.id)
    setReviewGaps(null)
    setPendingAdjudications(null)
    try {
      await api(`/deliveries/${delivery.id}/accept`, { method: 'POST' })
      toast.success(t('delivery.accepted'))
      reload()
    } catch (error) {
      // 读数不全是「台账缺项」，不是一句报错：把缺的哪一项摊在行上方，
      // 人才知道要回去重新合成，而不是再点一次验收。
      if (error instanceof ApiError && error.message === 'delivery:reviewIncomplete') {
        const gaps = Array.isArray(error.body?.reasons)
          ? error.body.reasons.filter((reason): reason is string => typeof reason === 'string')
          : []
        setReviewGaps(gaps)
        toast.error(t('delivery.review.incomplete'))
      } else if (handleQualityGate(error)) {
        // 打包之后重渲染过母带，旧裁决随指纹失效——同样摊在卡片上，不弹一句空话。
      } else {
        toast.error(apiErrorMessage(error, t))
      }
      reload()
    } finally {
      setAcceptingId(null)
    }
  }

  /**
   * The manifest is fetched through the session api (bearer auth) and handed to
   * the browser as a revocable blob URL — never as a raw API URL in the DOM.
   */
  /** 「下载」交付的是成片 mp4 本体;清单(JSON)走旁边的「清单」按钮。 */
  async function downloadVideo(delivery: Delivery) {
    if (!delivery.artifactId) {
      toast.error(t('delivery.noVideo'))
      return
    }
    setDownloadingId(delivery.id)
    try {
      const response = await fetch(`${API_BASE}/artifacts/${delivery.artifactId}/content`, {
        headers: { authorization: `Bearer ${getToken()}` },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${delivery.manifest.episode.title}.mp4`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      toast.success(t('delivery.videoDownloaded'))
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setDownloadingId(null)
    }
  }

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
      toast.error(apiErrorMessage(error, t))
    } finally {
      setDownloadingId(null)
    }
  }

  /** 剪辑交接:同一份交付清单导出 EDL/FCPXML/OTIO，精剪在 NLE 里做而不是重烧。 */
  async function downloadEditList(delivery: Delivery, format: 'edl' | 'fcpxml' | 'otio') {
    setDownloadingId(delivery.id)
    try {
      const response = await fetch(`${API_BASE}/deliveries/${delivery.id}/edit-list?format=${format}`, {
        headers: { authorization: `Bearer ${getToken()}` },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      const blob = new Blob([text], { type: format === 'edl' ? 'text/plain' : format === 'fcpxml' ? 'application/xml' : 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `episode-${delivery.manifest.episode.number}-edit.${format}`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      toast.success(t('delivery.editListDownloaded'))
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setDownloadingId(null)
    }
  }

  /** 字幕交付：SRT 是交付物的一部分——烧进画面或挂成软轨不等于交出去了，
   *  用户要能拿文件去外部工具校对、复用。没有字幕轨的交付不显示这条入口。 */
  async function downloadSubtitle(delivery: Delivery) {
    setDownloadingId(delivery.id)
    try {
      const response = await fetch(`${API_BASE}/deliveries/${delivery.id}/subtitle`, {
        headers: { authorization: `Bearer ${getToken()}` },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      const blob = new Blob([text], { type: 'application/x-subrip' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `episode-${delivery.manifest.episode.number}.srt`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      toast.success(t('delivery.subtitleDownloaded'))
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
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
                variant="outline"
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
              {/* EDL/XML 是行内小按钮，问号常驻头部解释这对外交接入口，触屏用户也有地方看。 */}
              <HelpHint text={t('delivery.editListHint')} />
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
                    <li key={reason}>{t(reason, { shots: gapShotList })}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {pendingAdjudications !== null && (
            <Alert variant="warning">
              <TriangleAlertIcon />
              <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-2 justify-items-start">
                <span className="text-sm">
                  {t('delivery.qualityGate.pending', { count: pendingAdjudications })}
                </span>
                <Button variant="outline" size="sm" onClick={goToAdjudication}>
                  {t('delivery.qualityGate.go')}
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {reviewGaps && (
            <Alert variant="warning">
              <TriangleAlertIcon />
              <AlertTitle>{t('delivery.review.incomplete')}</AlertTitle>
              <AlertDescription className="justify-items-start">
                <ul className="list-disc space-y-0.5 pl-4 text-xs">
                  {reviewGaps.map(gap => (
                    <li key={gap}>{t(gap)}</li>
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
                  // 增删对等：母带里没有字幕轨的交付不显示 SRT 入口，不做点了 404 的死按钮。
                  const hasSubtitle = delivery.manifest.composition.tracks?.some(track => track.stage === 'SUBTITLE') ?? false
                  return (
                    <TableRow key={delivery.id}>
                      <TableCell>
                        <StatusBadge
                          status={toneFor(delivery.status)}
                          label={translateEnum(t, 'delivery.status', delivery.status)}
                        />
                      </TableCell>
                      <TableCell className="text-subtle-foreground">
                        {formatDateTime(delivery.manifest.packagedAt, locale)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {t('delivery.qualitySummary', {
                          checks: delivery.manifest.quality.checks,
                          approved: delivery.manifest.quality.approved,
                          rejected: delivery.manifest.quality.rejected,
                          threshold: Math.round(delivery.manifest.quality.threshold * 100),
                        })}
                        <ReviewChips review={delivery.manifest.review} />
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
                            disabled={downloadingId === delivery.id || !delivery.artifactId}
                            onClick={() => void downloadVideo(delivery)}
                          >
                            {downloadingId === delivery.id
                              ? <LoaderCircleIcon className="animate-spin" />
                              : <DownloadIcon />}
                            {t('delivery.downloadVideo')}
                          </Button>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={downloadingId === delivery.id}
                                onClick={() => void downloadEditList(delivery, 'edl')}
                              >
                                {downloadingId === delivery.id
                                  ? <LoaderCircleIcon className="animate-spin" />
                                  : <ScissorsIcon />}
                                EDL
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t('delivery.editListHint')}</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={downloadingId === delivery.id}
                                onClick={() => void downloadEditList(delivery, 'fcpxml')}
                              >
                                {downloadingId === delivery.id
                                  ? <LoaderCircleIcon className="animate-spin" />
                                  : <ScissorsIcon />}
                                XML
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t('delivery.editListHint')}</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={downloadingId === delivery.id}
                                onClick={() => void downloadEditList(delivery, 'otio')}
                              >
                                {downloadingId === delivery.id
                                  ? <LoaderCircleIcon className="animate-spin" />
                                  : <ScissorsIcon />}
                                OTIO
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t('delivery.editListHint')}</TooltipContent>
                          </Tooltip>
                          {hasSubtitle && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={downloadingId === delivery.id}
                                  onClick={() => void downloadSubtitle(delivery)}
                                >
                                  {downloadingId === delivery.id
                                    ? <LoaderCircleIcon className="animate-spin" />
                                    : <FileTextIcon />}
                                  SRT
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>{t('delivery.subtitleHint')}</TooltipContent>
                            </Tooltip>
                          )}
                          <GuardedButton
                            action="episode:write"
                            variant="outline"
                            size="sm"
                            disabled={accepted || acceptingId === delivery.id}
                            onClick={() => void accept(delivery)}
                          >
                            <CheckIcon />
                            {t('delivery.accept')}
                          </GuardedButton>
                          <GuardedButton
                            action="episode:write"
                            variant="destructive"
                            size="sm"
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

/** 三枚读数徽章：齐=绿、缺=黄、这份清单打包于读数上线之前=灰。
 *  行里常驻的只有「三轴各齐不齐」这一眼，具体数字与缺项全进 Tooltip——
 *  缺哪一格只说「没记上」是不够的，人才需要知道要回去补什么。 */
function ReviewChips({ review }: { review: ManifestReview | undefined }) {
  const { t } = useI18n()
  if (!review) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="muted" className="mt-1">{t('delivery.review.unrecorded')}</Badge>
        </TooltipTrigger>
        <TooltipContent>{t('delivery.review.unrecordedHint')}</TooltipContent>
      </Tooltip>
    )
  }
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {REVIEW_AXES.map(axis => {
        const reading = review[axis]
        return (
          <Tooltip key={axis}>
            <TooltipTrigger asChild>
              <Badge variant={reading.present ? 'success' : 'warning'}>{t(`delivery.review.axis.${axis}`)}</Badge>
            </TooltipTrigger>
            <TooltipContent>
              {reading.present
                ? t(`delivery.review.hint.${axis}`)
                : reading.gaps.map(gap => t(gap)).join(t('apiError.listSeparator'))}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

/** 秒数口径与「原文」面板同一把尺（sources-panel 的 secondsOf）。 */
function secondsOf(ms: number): string {
  return (ms / 1000).toFixed(1)
}

function ReviewAxis({ axis, gaps, children }: { axis: 'rhythm' | 'transition' | 'sound'; gaps: string[]; children?: ReactNode }) {
  const { t } = useI18n()
  return (
    <div className="space-y-0.5">
      <p className="font-medium">{t(`delivery.review.axis.${axis}`)}</p>
      {children}
      {gaps.map(gap => (
        <p key={gap} className="text-warning-ink">{t(gap)}</p>
      ))}
    </div>
  )
}

/** 清单里的验收三读数（S5）：只摆这条母带台账里真的记下的数。
 *  拦验收的是「台账有没有」，不是「节奏好不好」——与 S1 同口径：碎不等于错，
 *  所以节奏过不过线用颜色标出来，不当错误。 */
function ReviewDetail({ review }: { review: ManifestReview }) {
  const { t } = useI18n()
  const { rhythm, transition, sound } = review
  const readings = rhythm.readings
  return (
    <div className="space-y-3 text-xs">
      <ReviewAxis axis="rhythm" gaps={rhythm.gaps}>
        {readings && (
          <>
            <p className="text-muted-foreground">
              {t('delivery.review.masterDuration')}{' '}
              <span className="tabular-nums">{t('sources.rhythmValueSeconds', { value: secondsOf(readings.totalMs) })}</span>
              {' · '}
              {t('sources.rhythmAvg')}{' '}
              <span className="tabular-nums">{t('sources.rhythmValueSeconds', { value: secondsOf(readings.avgShotMs) })}</span>
              {' · '}
              {t('sources.rhythmLongLabel', { min: secondsOf(rhythm.settings.longTakeMinMs) })}{' '}
              <span className="tabular-nums">
                {t('sources.rhythmLongValue', {
                  count: readings.longTakeCount,
                  share: Math.round(readings.longTakeShare * 100),
                })}
              </span>
            </p>
            <p className={rhythm.gate.pass ? 'text-success-ink' : 'text-warning-ink'}>
              {rhythm.gate.pass
                ? t('delivery.review.gatePass')
                : rhythm.gate.failures.map(failure => (failure === 'avgShot'
                    ? t('sources.rhythmFailAvg', { min: secondsOf(rhythm.settings.avgShotMs) })
                    : t('sources.rhythmFailLong', {
                        actual: Math.round(readings.longTakeShare * 100),
                        min: secondsOf(rhythm.settings.longTakeMinMs),
                        share: Math.round(rhythm.settings.longTakeShareMin * 100),
                      }))).join(t('apiError.listSeparator'))}
            </p>
          </>
        )}
      </ReviewAxis>

      <ReviewAxis axis="transition" gaps={transition.gaps}>
        {transition.present && (
          <p className="text-muted-foreground">
            {t('delivery.review.blended', { count: transition.blendedSeamCount })}
            {' · '}
            {transition.requestedNonCutCount === null
              ? t('delivery.review.requestedUnknown')
              : t('delivery.review.requested', { count: transition.requestedNonCutCount })}
            {!transition.blended && ` · ${t('delivery.review.streamCopy')}`}
          </p>
        )}
      </ReviewAxis>

      <ReviewAxis axis="sound" gaps={sound.gaps}>
        {sound.present && (
          <>
            <p className="text-muted-foreground">{t('delivery.review.dialogue', { count: sound.dialogueShotCount })}</p>
            {sound.silentDialogueShots.length > 0 && (
              <p className="text-warning-ink">
                {t('delivery.review.silent', { shots: sound.silentDialogueShots.map(shot => `#${shot}`).join(t('apiError.listSeparator')) })}
              </p>
            )}
            <p className="text-muted-foreground">
              {sound.bedCount === 0
                ? t('delivery.review.noBeds')
                : t('delivery.review.beds', { count: sound.bedCount, imported: sound.importedBedCount })}
              {' · '}
              {t(sound.hasMusic ? 'delivery.review.musicYes' : 'delivery.review.musicNo')}
            </p>
          </>
        )}
      </ReviewAxis>
    </div>
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
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="font-mono">{manifest.composition.checksum.slice(0, 12)}</span>
                    </TooltipTrigger>
                    <TooltipContent className="break-all">{`${t('delivery.checksum')} ${manifest.composition.checksum}`}</TooltipContent>
                  </Tooltip>
                </span>
                {manifest.composition.tracks && (
                  manifest.composition.tracks.length === 0 ? (
                    <span className="text-muted-foreground block text-xs">{t('delivery.silent')}</span>
                  ) : (
                    <div className="block space-y-1 pt-1">
                      <span className="text-muted-foreground text-xs">{t('delivery.tracks')}</span>
                      {manifest.composition.tracks.map(track => (
                        <p key={`${track.objectKey}-${track.version}`} className="text-xs">
                          <span className="font-medium">{track.stage ? translateEnum(t, 'generations.stage', track.stage) : '—'}</span>
                          {' · '}
                          <span className="font-mono break-all">{track.objectKey}</span>
                          <span className="text-muted-foreground"> · </span>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="text-muted-foreground font-mono">{track.checksum.slice(0, 12)}</span>
                            </TooltipTrigger>
                            <TooltipContent className="break-all">{`${t('delivery.checksum')} ${track.checksum}`}</TooltipContent>
                          </Tooltip>
                        </p>
                      ))}
                    </div>
                  )
                )}
              </DetailRow>
              <DetailRow label={t('delivery.labeling')}>
                {manifest.labeling ? (
                  <span className="block space-y-1">
                    <span className="block text-xs">
                      <span className={manifest.labeling.explicit === 'burned' ? 'text-success-ink' : 'text-warning-ink'}>
                        {t(`delivery.labelingExplicit.${manifest.labeling.explicit}`)}
                      </span>
                      {' · '}
                      <span className={manifest.labeling.implicit === 'written' ? 'text-success-ink' : 'text-warning-ink'}>
                        {t(`delivery.labelingImplicit.${manifest.labeling.implicit}`)}
                      </span>
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      {manifest.labeling.standard} · {manifest.labeling.badgeText}
                    </span>
                    {manifest.labeling.reason && (
                      <span className="text-warning-ink block text-xs">{manifest.labeling.reason}</span>
                    )}
                  </span>
                ) : (
                  <span className="text-muted-foreground text-xs">{t('delivery.labelingMissing')}</span>
                )}
              </DetailRow>
              <DetailRow label={t('delivery.postProcess')}>
                {manifest.postProcess ? (
                  <span className="block space-y-1">
                    <span className={`block text-xs ${manifest.postProcess.status === 'applied' ? 'text-success-ink' : 'text-warning-ink'}`}>
                      {t(manifest.postProcess.status === 'applied' ? 'delivery.postApplied' : 'delivery.postFallback')}
                    </span>
                    {manifest.postProcess.loudness?.after && (
                      <span className="text-muted-foreground block text-xs">
                        {manifest.postProcess.loudness.before.i} → {manifest.postProcess.loudness.after.i} LUFS · {t('delivery.postTarget')} {manifest.postProcess.target?.i} LUFS
                      </span>
                    )}
                    {manifest.postProcess.reason && (
                      <span className="text-warning-ink block text-xs">{manifest.postProcess.reason}</span>
                    )}
                  </span>
                ) : (
                  <span className="text-muted-foreground text-xs">{t('delivery.postMissing')}</span>
                )}
              </DetailRow>
              <DetailRow label={t('delivery.quality')}>
                <span className="text-sm">
                  {t('delivery.qualitySummary', {
                    checks: manifest.quality.checks,
                    approved: manifest.quality.approved,
                    rejected: manifest.quality.rejected,
                    threshold: Math.round(manifest.quality.threshold * 100),
                  })}
                </span>
              </DetailRow>
              <DetailRow label={t('delivery.review')}>
                {manifest.review ? (
                  <ReviewDetail review={manifest.review} />
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="muted">{t('delivery.review.unrecorded')}</Badge>
                    </TooltipTrigger>
                    <TooltipContent>{t('delivery.review.unrecordedHint')}</TooltipContent>
                  </Tooltip>
                )}
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
                            <TableCell className="text-muted-foreground font-mono text-xs">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span>{artifact.checksum.slice(0, 12)}</span>
                                </TooltipTrigger>
                                <TooltipContent className="break-all">{`${t('delivery.checksum')} ${artifact.checksum}`}</TooltipContent>
                              </Tooltip>
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
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-muted-foreground font-mono">{reference.checksum.slice(0, 12)}</span>
        </TooltipTrigger>
        <TooltipContent className="break-all">{`${t('delivery.checksum')} ${reference.checksum}`}</TooltipContent>
      </Tooltip>
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
      setError(apiErrorMessage(err, t))
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
            <Button type="button" variant="destructive" onClick={() => onOpenChange(false)} disabled={busy}>
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
