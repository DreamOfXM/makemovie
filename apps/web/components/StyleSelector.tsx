'use client'

import { CheckIcon, ClapperboardIcon, DropletsIcon, GhostIcon, LightbulbIcon, SparklesIcon, SunDimIcon, ZapIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export interface VideoStyle {
  id: string
  nameKey: string
  descriptionKey: string
  icon: React.ReactNode
}

const OFFICIAL_STYLES: VideoStyle[] = [
  {
    id: 'realistic',
    nameKey: 'style.realistic',
    descriptionKey: 'style.realistic.desc',
    icon: <ClapperboardIcon className="size-5" />,
  },
  {
    id: 'anime',
    nameKey: 'style.anime',
    descriptionKey: 'style.anime.desc',
    icon: <SparklesIcon className="size-5" />,
  },
  {
    id: 'watercolor',
    nameKey: 'style.watercolor',
    descriptionKey: 'style.watercolor.desc',
    icon: <DropletsIcon className="size-5" />,
  },
  {
    id: 'oil_painting',
    nameKey: 'style.oil_painting',
    descriptionKey: 'style.oil_painting.desc',
    icon: <SunDimIcon className="size-5" />,
  },
  {
    id: 'sketch',
    nameKey: 'style.sketch',
    descriptionKey: 'style.sketch.desc',
    icon: <LightbulbIcon className="size-5" />,
  },
  {
    id: 'comic',
    nameKey: 'style.comic',
    descriptionKey: 'style.comic.desc',
    icon: <ZapIcon className="size-5" />,
  },
  {
    id: '3d_cgi',
    nameKey: 'style.3d_cgi',
    descriptionKey: 'style.3d_cgi.desc',
    icon: <GhostIcon className="size-5" />,
  },
  {
    id: 'fantasy',
    nameKey: 'style.fantasy',
    descriptionKey: 'style.fantasy.desc',
    icon: <SparklesIcon className="size-5" />,
  },
]

interface StyleSelectorProps {
  value?: string
  onChange: (styleId: string) => void
  disabled?: boolean
}

export function StyleSelector({ value, onChange, disabled }: StyleSelectorProps) {
  const { t } = useI18n()

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {OFFICIAL_STYLES.map((style) => {
        const isSelected = value === style.id
        return (
          <Card
            key={style.id}
            className={cn(
              'cursor-pointer transition-all duration-200',
              isSelected && 'ring-2 ring-primary',
              !disabled && 'hover:border-primary/50 hover:shadow-md',
              disabled && 'opacity-50 cursor-not-allowed',
            )}
            onClick={() => !disabled && onChange(style.id)}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div
                  className={cn(
                    'flex size-9 items-center justify-center rounded-lg',
                    isSelected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {style.icon}
                </div>
                {isSelected && (
                  <div className="flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <CheckIcon className="size-3" />
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <CardTitle className="text-base">{t(style.nameKey)}</CardTitle>
              <CardDescription className="mt-1 text-xs">{t(style.descriptionKey)}</CardDescription>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

interface StyleBadgeProps {
  styleId?: string
  size?: 'sm' | 'default'
}

export function StyleBadge({ styleId, size = 'default' }: StyleBadgeProps) {
  const { t } = useI18n()

  if (!styleId) return null

  const style = OFFICIAL_STYLES.find((s) => s.id === styleId)
  if (!style) return null

  return (
    <Button variant="outline" size={size === 'sm' ? 'sm' : 'default'} className="gap-2" disabled>
      <span className={size === 'sm' ? 'size-4' : 'size-5'}>{style.icon}</span>
      {t(style.nameKey)}
    </Button>
  )
}
