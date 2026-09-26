'use client'

import { FilmIcon, ReceiptTextIcon, WorkflowIcon } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/**
 * The three readings of one episode. They are views over the same episode, so they belong
 * to the content area; the sidebar carries only scopes, never views.
 */
export type EpisodeTab = 'board' | 'flow' | 'usage'

const tabs: { id: EpisodeTab; labelKey: string; icon: typeof FilmIcon }[] = [
  { id: 'board', labelKey: 'shotboard.viewBoard', icon: FilmIcon },
  { id: 'flow', labelKey: 'shotboard.viewFlow', icon: WorkflowIcon },
  { id: 'usage', labelKey: 'shotboard.viewUsage', icon: ReceiptTextIcon },
]

export function EpisodeTabs({ value, onChange }: { value: EpisodeTab; onChange(next: EpisodeTab): void }) {
  const { t } = useI18n()
  return (
    <div role="tablist" aria-label={t('episode.tabs')} className="border-border/70 bg-muted/40 inline-flex items-center gap-0.5 rounded-lg border p-0.5">
      {tabs.map(tab => (
        <Button
          key={tab.id}
          role="tab"
          variant="ghost"
          aria-selected={value === tab.id}
          size="sm"
          className={cn(
            'h-7 rounded-md border px-2.5 text-xs font-medium whitespace-nowrap transition-colors [&_svg]:size-3.5',
            value === tab.id ? 'border-primary/70 bg-primary/15 text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
          onClick={() => onChange(tab.id)}
        >
          <tab.icon />
          {t(tab.labelKey)}
        </Button>
      ))}
    </div>
  )
}
