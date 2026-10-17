'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CableIcon, CheckCircle2Icon, ListChecksIcon, LoaderCircleIcon, WandSparklesIcon } from 'lucide-react'
import { toast } from 'sonner'
import { autoBindProject, fetchCreationReadiness, getToken, type CreationReadiness } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/api-error'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * US-010 模型接通引导:跟着 nextStep 状态机走——没连接去连、没探测去探、能补齐
 * 一键补齐,成功后回作品。缺配置权限的编辑者看到的是「请管理员连接模型」的出口,
 * 而不是一堆自己点不动的按钮。
 */
export function ModelGuidanceCard({ projectId, onDone }: { projectId: string; onDone?: () => void }) {
  const { t } = useI18n()
  const router = useRouter()
  const [data, setData] = useState<CreationReadiness | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await fetchCreationReadiness(getToken(), projectId))
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    }
  }, [projectId, t])

  useEffect(() => { void load() }, [load])

  async function bindNow() {
    setBusy(true)
    try {
      const result = await autoBindProject(getToken(), projectId)
      if (result.created.length > 0) toast.success(t('guidance.bound', { count: result.created.length }))
      else toast.info(t('guidance.nothingBound'))
      await load()
      onDone?.()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setBusy(false)
    }
  }

  if (data === null) return null

  const ready = data.nextStep === 'ready'
  return (
    <Card className={ready ? 'border-success/40' : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {ready ? <CheckCircle2Icon className="size-4 text-success" /> : <CableIcon className="text-muted-foreground size-4" />}
          {t('guidance.title')}
        </CardTitle>
        <CardDescription>
          {ready
            ? t('guidance.allSet', { ready: data.required.ready, total: data.required.total })
            : t('guidance.missing', { ready: data.required.ready, total: data.required.total })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!ready && (
          <div className="space-y-1">
            {data.gaps.filter(gap => gap.required).map(gap => (
              <div key={gap.slot} className="text-muted-foreground flex items-center justify-between text-sm">
                <span>{t(`slots.${gap.slot}`)}</span>
                <span className="text-xs">{gap.autoBindable ? t('guidance.autoBindable') : t('guidance.needsCandidate')}</span>
              </div>
            ))}
          </div>
        )}

        {ready ? (
          <Button size="sm" onClick={() => router.push(`/projects/${projectId}`)}>
            <ListChecksIcon />
            {t('guidance.backToWork')}
          </Button>
        ) : data.nextStep === 'connect_provider' || data.nextStep === 'probe_models' ? (
          data.canConfigure ? (
            <Button size="sm" onClick={() => router.push('/models')}>
              <CableIcon />
              {data.nextStep === 'connect_provider' ? t('guidance.goConnect') : t('guidance.goProbe')}
            </Button>
          ) : (
            <p className="text-muted-foreground text-sm">{t('guidance.askAdmin')}</p>
          )
        ) : data.canConfigure ? (
          <Button size="sm" disabled={busy} onClick={() => void bindNow()}>
            {busy ? <LoaderCircleIcon className="animate-spin" /> : <WandSparklesIcon />}
            {t('guidance.autoBind')}
          </Button>
        ) : (
          <p className="text-muted-foreground text-sm">{t('guidance.askAdmin')}</p>
        )}
      </CardContent>
    </Card>
  )
}
