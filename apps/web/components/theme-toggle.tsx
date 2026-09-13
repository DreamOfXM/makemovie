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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const options = [
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
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={t('theme.label')} title={t('theme.label')}>
          {/* Both icons ship in the markup so the trigger never mismatches the
              server render; CSS picks the one for the active color scheme. */}
          <SunIcon className="size-4.5 scale-100 rotate-0 transition-all dark:scale-90 dark:-rotate-90" />
          <MoonIcon className="absolute size-4.5 scale-90 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        {options.map(option => {
          const Icon = option.icon
          return (
            <DropdownMenuItem key={option.value} onClick={() => setTheme(option.value)}>
              <Icon className="text-muted-foreground" />
              {t(option.labelKey)}
              <CheckIcon className={cn('ml-auto', mounted && theme === option.value ? 'opacity-100' : 'opacity-0')} />
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
