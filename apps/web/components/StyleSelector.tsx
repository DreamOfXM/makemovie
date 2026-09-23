'use client'

import { useEffect, useState } from 'react'
import { CheckIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

interface StylePreset {
  id: string
  name: string
  nameEn?: string
  description: string
  isOfficial: boolean
}

interface StyleSelectorProps {
  value?: string
  onChange: (styleId: string) => void
  disabled?: boolean
}

const STYLE_ICONS: Record<string, string> = {
  realistic: '📷',
  cinematic: '🎬',
  animation: '🎨',
  anime: '✨',
  noir: '🌑',
  'sci-fi': '🚀',
  fantasy: '🏰',
  commercial: '📺',
}

export function StyleSelector({ value, onChange, disabled }: StyleSelectorProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const [styles, setStyles] = useState<StylePreset[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    api<{ styles: StylePreset[] }>('/styles')
      .then(data => setStyles(data.styles))
      .catch(() => setError(t('error.generic')))
      .finally(() => setLoading(false))
  }, [api, t])

  if (loading) {
    return <div className="text-muted-foreground">{t('common.loading')}</div>
  }

  if (error) {
    return <div className="text-destructive">{error}</div>
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {styles.map((style) => {
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
                  <span className="size-5">{STYLE_ICONS[style.id] || '🎭'}</span>
                </div>
                {isSelected && (
                  <div className="flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <CheckIcon className="size-3" />
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <CardTitle className="text-base">
                {style.nameEn ? `${style.name} / ${style.nameEn}` : style.name}
              </CardTitle>
              <CardDescription className="mt-1 text-xs">{style.description}</CardDescription>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
