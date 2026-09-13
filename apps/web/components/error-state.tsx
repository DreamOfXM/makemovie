'use client'

import { CircleAlertIcon, RefreshCwIcon } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

interface ErrorStateProps {
  message: string
  onRetry?(): void
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  const { t } = useI18n()
  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertTitle>{t('error.loadTitle')}</AlertTitle>
      <AlertDescription className="justify-items-start">
        <p>{message}</p>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCwIcon />
            {t('common.retry')}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}
