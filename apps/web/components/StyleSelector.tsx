'use client'

import { useEffect, useState, type ReactNode } from 'react'
import {
  CameraIcon,
  CastleIcon,
  CheckIcon,
  ClapperboardIcon,
  ContrastIcon,
  MegaphoneIcon,
  PaletteIcon,
  RocketIcon,
  ShapesIcon,
  SparklesIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { Card } from '@/components/ui/card'

interface StylePreset {
  id: string
  name: string
  nameEn?: string | null
  description: string
  isOfficial: boolean
}

interface StyleSelectorProps {
  value?: string
  onChange: (styleId: string) => void
  disabled?: boolean
}

/** The icon set follows the app-wide lucide outline language — no emoji in product UI. */
const STYLE_ICONS: Record<string, ReactNode> = {
  realistic: <CameraIcon className="size-4" />,
  cinematic: <ClapperboardIcon className="size-4" />,
  animation: <PaletteIcon className="size-4" />,
  anime: <SparklesIcon className="size-4" />,
  noir: <ContrastIcon className="size-4" />,
  'sci-fi': <RocketIcon className="size-4" />,
  fantasy: <CastleIcon className="size-4" />,
  commercial: <MegaphoneIcon className="size-4" />,
}
const FALLBACK_ICON = <ShapesIcon className="size-4" />

export function StyleSelector({ value, onChange, disabled }: StyleSelectorProps) {
  const { t, locale } = useI18n()
  const { api } = useSession()
  const [styles, setStyles] = useState<StylePreset[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    api<{ styles: StylePreset[] }>('/styles')
      .then(data => {
        if (!cancelled) setStyles(data.styles)
      })
      .catch(() => {
        if (!cancelled) setError(t('error.generic'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [api, t])

  if (loading) {
    return <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
  }

  if (error) {
    return <div className="text-sm text-destructive">{error}</div>
  }

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {styles.map(style => {
        const isSelected = value === style.id
        const displayName = locale === 'zh' || !style.nameEn ? style.name : style.nameEn
        return (
          <Card
            key={style.id}
            className={cn(
              'flex-row items-start gap-3 p-3 transition-colors',
              'cursor-pointer',
              isSelected ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:border-primary/40',
              disabled && 'cursor-not-allowed opacity-50',
            )}
            onClick={() => !disabled && onChange(style.id)}
          >
            <div
              className={cn(
                'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border',
                isSelected
                  ? 'border-primary/40 bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {STYLE_ICONS[style.id] ?? FALLBACK_ICON}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{displayName}</span>
                {isSelected && <CheckIcon className="size-4 shrink-0 text-primary" />}
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                {style.description}
              </p>
            </div>
          </Card>
        )
      })}
    </div>
  )
}
