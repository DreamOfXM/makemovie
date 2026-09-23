'use client'

import { useEffect, useState } from 'react'
import { CheckIcon, PaletteIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface SkinOption {
  value: string
  labelKey: string
  descriptionKey?: string
  previewColors: [string, string, string] // background, primary, accent
}

const SKINS: SkinOption[] = [
  {
    value: 'forest',
    labelKey: 'skin.forest',
    descriptionKey: 'skin.forest.desc',
    previewColors: ['#1e3a2f', '#059669', '#d97706'],
  },
  {
    value: 'tungsten',
    labelKey: 'skin.tungsten',
    descriptionKey: 'skin.tungsten.desc',
    previewColors: ['#4a2c18', '#ea580c', '#b45309'],
  },
  {
    value: 'rice',
    labelKey: 'skin.rice',
    descriptionKey: 'skin.rice.desc',
    previewColors: ['#fafaf9', '#1d4ed8', '#dc2626'],
  },
]

export function SkinSelector() {
  const { t } = useI18n()
  const [mounted, setMounted] = useState(false)
  const [currentSkin, setCurrentSkin] = useState('default')

  useEffect(() => {
    setMounted(true)
    // Read skin preference
    const storedSkin = localStorage.getItem('studio.skin') || 'default'
    document.documentElement.setAttribute('data-skin', storedSkin)
    setCurrentSkin(storedSkin)
  }, [])

  function applySkin(skin: string) {
    document.documentElement.setAttribute('data-skin', skin)
    localStorage.setItem('studio.skin', skin)
    setCurrentSkin(skin)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={t('skin.label')}>
          <PaletteIcon className="size-4.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[280px]">
        <DropdownMenuLabel>{t('skin.label')}</DropdownMenuLabel>
        <DropdownMenuSeparator />

        {/* Default theme (purple) */}
        <DropdownMenuItem
          onClick={() => applySkin('default')}
          className={cn('flex items-center gap-3 p-3 cursor-pointer', currentSkin === 'default' && 'bg-accent')}
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border">
            <div className="h-4 w-4 rounded-sm bg-primary" style={{ backgroundColor: 'var(--primary)' }} />
          </div>
          <div className="flex-1 text-left">
            <p className="text-sm font-medium">{t('skin.default')}</p>
            <p className="text-xs text-muted-foreground">{t('skin.default.desc')}</p>
          </div>
          {mounted && currentSkin === 'default' && <CheckIcon className="ml-auto size-4 text-muted-foreground" />}
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* Custom skins */}
        {SKINS.map((skin, index) => (
          <DropdownMenuItem
            key={skin.value}
            onClick={() => applySkin(skin.value)}
            className={cn('flex items-center gap-3 p-3 cursor-pointer', currentSkin === skin.value && 'bg-accent')}
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border">
              <div
                className="h-4 w-1 rounded-sm"
                style={{ backgroundColor: skin.previewColors[0] }}
              />
              <div
                className="h-4 w-2 -ml-1 rounded-sm"
                style={{ backgroundColor: skin.previewColors[1] }}
              />
              <div
                className="h-4 w-1 -ml-1 rounded-sm"
                style={{ backgroundColor: skin.previewColors[2] }}
              />
            </div>
            <div className="flex-1 text-left">
              <p className="text-sm font-medium">{t(skin.labelKey)}</p>
              {skin.descriptionKey && (
                <p className="text-xs text-muted-foreground">{t(skin.descriptionKey)}</p>
              )}
            </div>
            {mounted && currentSkin === skin.value && <CheckIcon className="ml-auto size-4 text-muted-foreground" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
