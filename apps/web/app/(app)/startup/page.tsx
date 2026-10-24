'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2Icon, AlertTriangleIcon, XCircleIcon, ActivityIcon } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface Check {
  id: string
  status: 'ok' | 'warn' | 'error'
  detail: string
}

export default function StartupPage() {
  const { t } = useI18n()
  const [checks, setChecks] = useState<Check[] | null>(null)
  const [version, setVersion] = useState('')

  useEffect(() => {
    void fetch('/api/system/startup-check')
      .then(response => response.json())
      .then((data: { service: string; version: string; checks: Check[] }) => {
        setChecks(data.checks)
        setVersion(data.version)
      })
      .catch(() => setChecks([]))
  }, [])

  const icon = (status: Check['status']) =>
    status === 'ok' ? <CheckCircle2Icon className="size-4 text-success" />
    : status === 'warn' ? <AlertTriangleIcon className="size-4 text-warning" />
    : <XCircleIcon className="size-4 text-destructive" />

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ActivityIcon className="text-muted-foreground size-4" />
            {t('startup.title')}
          </CardTitle>
          <CardDescription>{t('startup.desc')} · v{version} · {t('startup.modelHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          {checks === null ? (
            <div className="text-muted-foreground text-sm">{t('startup.checking')}</div>
          ) : (
            <div className="space-y-2">
              {checks.map(check => (
                <div key={check.id} className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
                  {icon(check.status)}
                  <div className="flex-1">
                    <span className="font-medium">{check.id}</span>
                    <span className="text-muted-foreground ml-2 text-xs">{check.detail}</span>
                  </div>
                  <Badge variant={check.status === 'ok' ? 'default' : check.status === 'warn' ? 'secondary' : 'destructive'} className="text-xs">
                    {check.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
