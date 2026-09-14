'use client'

import { SparklesIcon, UserPenIcon } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// The generation pipeline is where a task can actually be inspected, and every lineage
// badge is rendered on the workspace page that carries that section.
const GENERATIONS_ANCHOR = '#step-generation'

interface LineageBadgeProps {
  /**
   * The persisted `generationTaskId`: a task id for AI-written content, null for content a
   * human authored or edited by hand, undefined when the endpoint did not report lineage.
   */
  taskId: string | null | undefined
  className?: string
}

/**
 * Answers "who wrote this?" at a glance. A bare cuid is not an affordance, so the id stays in
 * the tooltip and the badge itself links to the generation pipeline that produced the content.
 */
export function LineageBadge({ taskId, className }: LineageBadgeProps) {
  const { t } = useI18n()

  // An endpoint that omits the field is not claiming a human wrote the row.
  if (taskId === undefined) return <span className={cn('text-muted-foreground text-xs', className)}>—</span>

  const badge = taskId ? (
    <Badge variant="tinted" className={cn('gap-1', className)}>
      <SparklesIcon />
      {t('lineage.ai')}
    </Badge>
  ) : (
    <Badge variant="muted" className={cn('gap-1 font-normal', className)}>
      <UserPenIcon />
      {t('lineage.human')}
    </Badge>
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {taskId ? (
          <a href={GENERATIONS_ANCHOR} className="inline-flex">
            {badge}
          </a>
        ) : (
          <span className="inline-flex" tabIndex={0}>
            {badge}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent>
        {taskId ? t('lineage.aiTooltip') : t('lineage.humanTooltip')}
        {taskId && (
          <span className="mt-1 block font-mono text-[11px] break-all opacity-80">
            {t('lineage.task')} {taskId}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
