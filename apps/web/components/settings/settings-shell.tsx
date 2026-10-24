'use client'

import { useEffect, useId, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ChevronDownIcon, Loader2Icon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { HelpHint } from '@/components/ui/help-hint'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

export type SettingsScope = 'space' | 'project' | 'episode' | 'local'

const SCOPE_LABEL: Record<SettingsScope, string> = {
  space: 'settingsPage.scope.space',
  project: 'settingsPage.scope.project',
  episode: 'settingsPage.scope.episode',
  local: 'settingsPage.scope.local',
}

interface SettingsRowProps {
  /** Anchor target for cross-references between rows. */
  id?: string
  title: ReactNode
  description?: ReactNode
  /** Which layer this row governs; the right-hand summary answers "what is in effect". */
  scope: SettingsScope
  summary?: ReactNode
  /** At most one status badge besides the scope badge. */
  status?: ReactNode
  /** Extra tag that belongs to the title (e.g. "Locked"), counted as the status badge. */
  tag?: ReactNode
  /** Rows whose status badge already names the layer keep a single badge. */
  hideScope?: boolean
  defaultOpen?: boolean
  children: ReactNode
}

export function SettingsRow({ id, title, description, scope, summary, status, tag, hideScope, defaultOpen, children }: SettingsRowProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(defaultOpen ?? false)
  const panelId = useId()

  // A cross-reference may link straight to a collapsed row; land on its content,
  // not on a closed header. The page renders after its data loads, so the anchor
  // scroll the browser attempted on navigation missed — re-land once mounted.
  useEffect(() => {
    if (!id) return
    const landIfTargeted = () => {
      if (window.location.hash !== `#${id}`) return
      setOpen(true)
      const element = document.getElementById(id)
      if (!element) return
      const top = element.getBoundingClientRect().top
      if (top < 0 || top > 200) {
        element.scrollIntoView({ block: 'start' })
      }
    }
    landIfTargeted()
    // Data arrives in several waves; each one moves the rows below it. Re-land
    // while the page settles, but only for a bounded two seconds.
    const timers = [120, 400, 800, 1400, 2000].map(ms => window.setTimeout(landIfTargeted, ms))
    window.addEventListener('hashchange', landIfTargeted)
    return () => {
      timers.forEach(timer => window.clearTimeout(timer))
      window.removeEventListener('hashchange', landIfTargeted)
    }
  }, [id])

  return (
    <section id={id} className="scroll-mt-32 overflow-hidden rounded-xl border bg-card">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(value => !value)}
        className="flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-accent/30"
      >
        <ChevronDownIcon
          className={cn(
            'text-muted-foreground mt-0.5 size-4 shrink-0 transition-transform duration-200',
            open && 'rotate-180',
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium">{title}</span>
            {hideScope ? null : <Badge variant="muted">{t(SCOPE_LABEL[scope])}</Badge>}
            {tag ?? status}
          </span>
          {description ? (
            <span className="text-muted-foreground mt-1 block text-xs leading-relaxed">{description}</span>
          ) : null}
          {summary ? (
            <span className="mt-1.5 block text-xs font-medium tabular-nums sm:hidden">{summary}</span>
          ) : null}
        </span>
        {summary ? (
          <span className="text-muted-foreground hidden shrink-0 text-right text-xs tabular-nums sm:block">
            {summary}
          </span>
        ) : null}
      </button>
      {open ? (
        <div id={panelId} className="border-border border-t border-dashed px-4 py-4 sm:pl-11">
          {children}
        </div>
      ) : null}
    </section>
  )
}

export function GroupHeader({
  id,
  title,
  hint,
  action,
}: {
  id: string
  title: string
  hint: ReactNode
  action?: ReactNode
}) {
  return (
    <div id={id} className="scroll-mt-32 scroll-mb-6 border-b pb-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          <div className="text-muted-foreground text-xs">{hint}</div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  )
}

export interface SegmentOption<T extends string | number | null> {
  value: T
  label: string
  disabled?: boolean
}

export function Segmented<T extends string | number | null>({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: T
  options: SegmentOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
  label: string
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map(option => {
        const selected = option.value === value
        const blocked = disabled || option.disabled
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={selected}
            disabled={blocked}
            onClick={() => onChange(option.value)}
            className={cn(
              'h-8 rounded-md border px-3 text-xs font-medium whitespace-nowrap transition-colors',
              selected
                ? 'border-primary bg-primary/15 text-primary'
                : 'border-control-line hover:bg-accent/50',
              blocked && 'cursor-not-allowed opacity-50',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export function SaveButton({
  onClick,
  dirty,
  saving,
  disabled,
}: {
  onClick: () => void
  dirty: boolean
  saving: boolean
  disabled?: boolean
}) {
  const { t } = useI18n()
  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={!dirty || saving || disabled}>
      {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
      {saving ? t('common.saving') : t('common.save')}
    </Button>
  )
}

export function PanelNote({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground text-xs leading-relaxed">{children}</p>
}

export function CalcLine({ children }: { children: ReactNode }) {
  return (
    <div className="bg-muted/50 rounded-md border px-3 py-2 text-[12px] leading-relaxed tabular-nums">
      {children}
    </div>
  )
}

export function ReadonlyNote({ children }: { children: ReactNode }) {
  return (
    <div className="bg-muted/50 text-muted-foreground rounded-md px-3 py-2.5 text-xs leading-relaxed">
      {children}
    </div>
  )
}

export function RowField({
  label,
  hint,
  children,
}: {
  label: ReactNode
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-[13px] font-medium">
        <span>{label}</span>
        {hint ? <HelpHint text={hint} /> : null}
      </div>
      {children}
    </div>
  )
}

export function OpenLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={href}>{children}</Link>
    </Button>
  )
}
