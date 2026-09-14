'use client'

import { Fragment, useCallback } from 'react'
import { ArrowRightIcon, CheckIcon } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

const STEP_KEYS = ['source', 'script', 'assets', 'storyboards', 'generation', 'composition', 'delivery'] as const
type StepKey = (typeof STEP_KEYS)[number]
type StepStatus = 'done' | 'current' | 'todo'

// Where each step's content lives on the page, so clicking a step scrolls to it.
// Source and script share the sources panel; generation and composition share the
// generation panel.
const STEP_ANCHOR: Record<StepKey, string> = {
  source: 'step-source',
  script: 'step-source',
  assets: 'step-assets',
  storyboards: 'step-storyboards',
  generation: 'step-generation',
  composition: 'step-generation',
  delivery: 'step-delivery',
}

interface ProgressData {
  sourceApproved: boolean
  scriptApproved: boolean
  assetApproved: boolean
  hasGeneratedMedia: boolean
  compositionCompleted: boolean
  hasDelivery: boolean
}

/**
 * Composes the episode's production progress from the five read endpoints and
 * reduces it to per-step status plus the first incomplete step, so the workspace
 * can always tell the user where they are and what to do next.
 */
export function useEpisodeProgress(episodeId: string | null, storyboardCount: number) {
  const { api } = useSession()

  const load = useCallback(async (): Promise<ProgressData | null> => {
    if (!episodeId) return null
    const [sources, scripts, assets, generations, deliveries] = await Promise.all([
      api<{ versions: Array<{ status: string }> }>(`/episodes/${episodeId}/source-versions`),
      api<{ versions: Array<{ status: string }> }>(`/episodes/${episodeId}/script-versions`),
      api<{ assets: Array<{ status: string }> }>(`/episodes/${episodeId}/assets`),
      api<{ batches: Array<{ stage: string; tasks: Array<{ status: string }> }>; composition: { status: string } | null }>(
        `/episodes/${episodeId}/generations`,
      ),
      api<{ deliveries: Array<{ status: string }> }>(`/episodes/${episodeId}/deliveries`),
    ])
    return {
      sourceApproved: sources.versions.some(version => version.status === 'APPROVED'),
      scriptApproved: scripts.versions.some(version => version.status === 'APPROVED'),
      assetApproved: assets.assets.some(asset => asset.status === 'APPROVED'),
      hasGeneratedMedia: generations.batches.some(
        batch => (batch.stage === 'IMAGE' || batch.stage === 'VIDEO') && batch.tasks.some(task => task.status === 'SUCCEEDED'),
      ),
      compositionCompleted: generations.composition?.status === 'COMPLETED',
      hasDelivery: deliveries.deliveries.length > 0,
    }
  }, [api, episodeId])

  const { data, loading } = useAsync<ProgressData | null>(episodeId ? load : null, null)

  const done: Record<StepKey, boolean> = {
    source: data?.sourceApproved ?? false,
    script: data?.scriptApproved ?? false,
    assets: data?.assetApproved ?? false,
    storyboards: storyboardCount > 0,
    generation: data?.hasGeneratedMedia ?? false,
    composition: data?.compositionCompleted ?? false,
    delivery: data?.hasDelivery ?? false,
  }
  const firstIncomplete = STEP_KEYS.find(key => !done[key]) ?? null
  const steps = STEP_KEYS.map(key => ({
    key,
    status: (done[key] ? 'done' : key === firstIncomplete ? 'current' : 'todo') as StepStatus,
  }))

  return { loading, steps, nextStep: firstIncomplete }
}

interface EpisodeStepperProps {
  episodeId: string
  storyboardCount: number
}

export function EpisodeStepper({ episodeId, storyboardCount }: EpisodeStepperProps) {
  const { t } = useI18n()
  const { loading, steps, nextStep } = useEpisodeProgress(episodeId, storyboardCount)

  function scrollTo(key: StepKey) {
    document.getElementById(STEP_ANCHOR[key])?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <Card>
      <CardContent className="py-4">
        {loading ? (
          <Skeleton className="h-9 w-full" />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
              {steps.map((step, index) => (
                <Fragment key={step.key}>
                  {index > 0 && <ArrowRightIcon className="text-muted-foreground/40 size-3.5 shrink-0" />}
                  <button
                    type="button"
                    onClick={() => scrollTo(step.key)}
                    className={cn(
                      'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                      step.status === 'done' && 'border-transparent bg-muted text-foreground',
                      step.status === 'current' && 'border-primary/40 bg-primary/10 text-primary',
                      step.status === 'todo' && 'border-border text-muted-foreground',
                    )}
                  >
                    <span className="flex size-4 items-center justify-center">
                      {step.status === 'done' ? <CheckIcon className="size-3" /> : index + 1}
                    </span>
                    {t(`stepper.step.${step.key}`)}
                  </button>
                </Fragment>
              ))}
            </div>
            {nextStep && (
              <p className="text-muted-foreground mt-3 text-sm">
                {t('stepper.nextLabel')}
                <span className="text-foreground font-medium">{t(`stepper.next.${nextStep}`)}</span>
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
