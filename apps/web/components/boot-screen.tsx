'use client'

import { ClapperboardIcon } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { Spinner } from '@/components/ui/spinner'

export function BootScreen() {
  const { t } = useI18n()
  return (
    <div className="bg-background flex min-h-dvh flex-col items-center justify-center gap-4">
      <span className="from-primary to-primary/60 flex size-11 items-center justify-center rounded-xl bg-linear-to-br text-primary-foreground shadow-raised">
        <ClapperboardIcon className="size-6" />
      </span>
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Spinner />
        {t('auth.booting')}
      </p>
    </div>
  )
}
