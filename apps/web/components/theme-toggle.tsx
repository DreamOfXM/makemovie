'use client'

import { useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const themeOptions = [
  { value: 'light', icon: SunIcon, labelKey: 'theme.light' },
  { value: 'dark', icon: MoonIcon, labelKey: 'theme.dark' },
  { value: 'system', icon: MonitorIcon, labelKey: 'theme.system' },
] as const

export function ThemeToggle() {
  const { t } = useI18n()
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="relative" aria-label={t('theme.label')}>
              {/* Both icons ship in the markup so the trigger never mismatches the
                  server render; CSS picks the one for the active color scheme. */}
              <SunIcon className="size-4.5 scale-100 rotate-0 transition-all dark:scale-90 dark:-rotate-90" />
              <MoonIcon className="absolute size-4.5 scale-90 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t('theme.label')} · {t('theme.hint')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-[280px]">
        <DropdownMenuLabel>{t('theme.label')}</DropdownMenuLabel>
        
        {themeOptions.map(option => {
          const Icon = option.icon
          return (
            <DropdownMenuItem key={option.value} onClick={() => setTheme(option.value)}>
              <Icon className="text-muted-foreground" />
              <span className="flex-1">{t(option.labelKey)}</span>
              {mounted && theme === option.value && <CheckIcon className="ml-auto size-4 text-muted-foreground" />}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
