'use client'

import { useCallback } from 'react'
import { BoxesIcon, CableIcon, RadioTowerIcon, RefreshCwIcon } from 'lucide-react'
import type { Catalog, Connection } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { BindingsPanel } from '@/components/models/bindings-panel'
import { CatalogsPanel } from '@/components/models/catalogs-panel'
import { ConnectionsPanel } from '@/components/models/connections-panel'

export default function ModelsPage() {
  const { t } = useI18n()
  const { api, organizationId } = useSession()

  const loadConnections = useCallback(() => api<Connection[]>('/providers/connections'), [api, organizationId])
  const connections = useAsync<Connection[]>(loadConnections, [])

  const loadCatalogs = useCallback(() => api<Catalog[]>('/providers/catalogs'), [api])
  const catalogs = useAsync<Catalog[]>(loadCatalogs, [])

  return (
    <>
      <PageHeader
        title={t('models.title')}
        description={t('models.subtitle')}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              connections.reload()
              catalogs.reload()
            }}
          >
            <RefreshCwIcon />
            {t('common.refresh')}
          </Button>
        }
      />

      <FlowGuide />

      <Tabs defaultValue="connections">
        <TabsList>
          <TabsTrigger value="connections">
            <CableIcon />
            {t('models.tab.connections')}
          </TabsTrigger>
          <TabsTrigger value="bindings">
            <RadioTowerIcon />
            {t('models.tab.bindings')}
          </TabsTrigger>
          <TabsTrigger value="catalogs">
            <BoxesIcon />
            {t('models.tab.catalogs')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="connections">
          <ConnectionsPanel connections={connections} catalogs={catalogs.data} />
        </TabsContent>
        <TabsContent value="bindings">
          <BindingsPanel connections={connections} />
        </TabsContent>
        <TabsContent value="catalogs">
          <CatalogsPanel catalogs={catalogs} />
        </TabsContent>
      </Tabs>
    </>
  )
}

function FlowGuide() {
  const { t } = useI18n()
  const steps = [t('models.flow.step1'), t('models.flow.step2'), t('models.flow.step3'), t('models.flow.step4')]

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="text-sm">{t('models.flow.title')}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        {steps.map((step, index) => (
          <div key={step} className="flex gap-3">
            <span className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums">
              {index + 1}
            </span>
            <p className="text-muted-foreground text-sm leading-relaxed">{step}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
