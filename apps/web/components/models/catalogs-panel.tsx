'use client'

import { useState } from 'react'
import { BoxesIcon, ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import type { Catalog, CatalogModel } from '@/lib/api'
import { translateEnum, useI18n } from '@/lib/i18n'
import type { AsyncState } from '@/lib/use-async'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { TableSkeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ErrorState } from '@/components/error-state'

export function CatalogsPanel({ catalogs }: { catalogs: AsyncState<Catalog[]> }) {
  const { t } = useI18n()

  if (catalogs.error) return <ErrorState message={catalogs.error} onRetry={catalogs.reload} />

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t('models.catalogs')}</h2>
        <p className="text-muted-foreground text-sm">{t('models.catalogsHint')}</p>
      </div>

      {catalogs.loading && catalogs.data.length === 0 ? (
        <Card>
          <TableSkeleton rows={4} columns={4} />
        </Card>
      ) : catalogs.data.length === 0 ? (
        <EmptyState icon={<BoxesIcon />} title={t('common.empty')} />
      ) : (
        <div className="space-y-4">
          {catalogs.data.map(catalog => (
            <Card key={catalog.provider}>
              <CardHeader>
                <div className="flex items-start gap-3">
                  <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
                    <BoxesIcon className="size-4.5" />
                  </span>
                  <div className="min-w-0 space-y-1.5">
                    <CardTitle className="flex flex-wrap items-center gap-2">
                      {catalog.label}
                      <Badge variant="outline">{catalog.provider}</Badge>
                    </CardTitle>
                    <CardDescription className="truncate font-mono text-xs">
                      {catalog.defaultBaseUrl} · {t('models.catalogVersion')} {catalog.catalogVersion}
                    </CardDescription>
                  </div>
                </div>
                <CardAction>
                  <Badge variant="muted">{t('models.capabilityCount', { count: catalog.models.length })}</Badge>
                </CardAction>
              </CardHeader>
              {catalog.models.length === 0 ? (
                <p className="text-muted-foreground px-6 text-sm">{t('models.noCapabilities')}</p>
              ) : (
                <div className="border-t">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>{t('common.model')}</TableHead>
                        <TableHead>{t('common.modality')}</TableHead>
                        <TableHead>{t('models.inputs')}</TableHead>
                        <TableHead>{t('models.spec')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {catalog.models.map(model => (
                        <CatalogModelRow key={model.model} model={model} />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

function CatalogModelRow({ model }: { model: CatalogModel }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const spec = model.spec ?? {}
  const specKeys = Object.keys(spec)

  function specLabel(key: string): string {
    switch (key) {
      case 'use':
        return t('models.specUse')
      case 'resolutions':
        return t('models.specResolutions')
      case 'durations':
        return t('models.specDurations')
      default:
        return key
    }
  }

  return (
    <TableRow>
      <TableCell>
        <p className="font-medium">{model.model}</p>
        {model.displayName && model.displayName !== model.model && (
          <p className="text-muted-foreground text-xs">{model.displayName}</p>
        )}
      </TableCell>
      <TableCell>
        <Badge variant="outline">{translateEnum(t, 'modality', model.modality)}</Badge>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {model.acceptsFirstFrame && <Badge variant="muted">{t('models.firstFrame')}</Badge>}
          {model.acceptsReferenceImages && (
            <Badge variant="muted">
              {t('models.referenceImages')}
              {model.maxReferenceImages ? ` · ${model.maxReferenceImages}` : ''}
            </Badge>
          )}
          {!model.acceptsFirstFrame && !model.acceptsReferenceImages && (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
      </TableCell>
      <TableCell>
        {specKeys.length === 0 ? (
          <span className="text-muted-foreground text-xs">{t('models.noSpec')}</span>
        ) : (
          <div className="space-y-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground -ml-2 h-7 gap-1 px-2 text-xs"
              aria-expanded={open}
              onClick={() => setOpen(value => !value)}
            >
              {open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
              {specKeys.length === 1 ? specLabel(specKeys[0]) : t('common.count', { count: specKeys.length })}
            </Button>
            {open && (
              <pre className="bg-muted/60 text-foreground max-w-md overflow-x-auto rounded-md p-3 font-mono text-xs">
                {JSON.stringify(spec, null, 2)}
              </pre>
            )}
          </div>
        )}
      </TableCell>
    </TableRow>
  )
}
