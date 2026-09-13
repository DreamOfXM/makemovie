'use client'

import { CheckIcon, LanguagesIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n, type Locale } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const locales: { value: Locale; labelKey: string }[] = [
  { value: 'en', labelKey: 'locale.en' },
  { value: 'zh', labelKey: 'locale.zh' },
]

export function LocaleSwitcher() {
  const { locale, setLocale, t } = useI18n()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('locale.label')} title={t('locale.label')}>
          <LanguagesIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        {locales.map(option => (
          <DropdownMenuItem key={option.value} onClick={() => setLocale(option.value)}>
            {t(option.labelKey)}
            <CheckIcon className={cn('ml-auto', locale === option.value ? 'opacity-100' : 'opacity-0')} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
