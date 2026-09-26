'use client'

import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { useRouter } from 'next/navigation'
import { ArrowRightIcon, BoxesIcon, CableIcon, ListChecksIcon, RadioTowerIcon, RefreshCwIcon } from 'lucide-react'
import type { Binding, CallEvidenceMap, Catalog, Connection } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { BindingsPanel } from '@/components/models/bindings-panel'
import { CatalogsPanel } from '@/components/models/catalogs-panel'
import { ConnectionsPanel } from '@/components/models/connections-panel'
import { ReadinessPanel } from '@/components/models/readiness-panel'

type ModelsTab = 'readiness' | 'connections' | 'bindings' | 'catalogs'

const MODELS_TABS: readonly ModelsTab[] = ['readiness', 'connections', 'bindings', 'catalogs']

/**
 * Drives the horizontal tab rail on narrow screens: reports whether a tab is
 * still hiding past the right edge (so the amber hint band answers that question
 * instead of decorating it), and keeps the active tab inside the viewport when
 * the page loads or the tab changes from a sidebar link. Container queries on
 * scroll position would do the first part in CSS, but they do not match in the
 * browsers this ships to.
 */
function useTabRail(activeTab: string) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [more, setMore] = useState(false)

  useEffect(() => {
    const rail = ref.current
    if (!rail) return

    const active = rail.querySelector<HTMLElement>(`[data-slot='tabs-trigger'][data-state='active']`)
    if (active) {
      // A 24px margin on the inner edge: the next tab stays clipped, which reads
      // as "there is more to scroll" better than any hint text.
      const peek = 24
      const rr = rail.getBoundingClientRect()
      const ar = active.getBoundingClientRect()
      if (ar.left < rr.left) rail.scrollLeft -= rr.left - ar.left + peek
      else if (ar.right > rr.right - peek) rail.scrollLeft += ar.right - rr.right + peek
    }

    const measure = () => setMore(rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(rail)
    rail.addEventListener('scroll', measure, { passive: true })
    return () => {
      ro.disconnect()
      rail.removeEventListener('scroll', measure)
    }
  }, [activeTab])

  return { ref, more }
}

export default function ModelsPage() {
  // The scope lives in the URL (?tab=bindings&project=…), so sidebar links
  // re-target this page without a remount; that hook needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <ModelsWorkspace />
    </Suspense>
  )
}

function ModelsWorkspace() {
  const { t } = useI18n()
  const { api, organizationId } = useSession()
  const router = useRouter()
  const searchParams = useSearchParams()
  const tabParam = searchParams.get('tab')
  const tab: ModelsTab = MODELS_TABS.includes((tabParam ?? '') as ModelsTab) ? (tabParam as ModelsTab) : 'readiness'
  const projectParam = searchParams.get('project')

  const setTab = useCallback(
    (next: ModelsTab) => {
      const query = new URLSearchParams({ tab: next })
      // Keep the project scope alive while it is meaningful on this page.
      if (projectParam && next === 'bindings') query.set('project', projectParam)
      router.replace(`/models?${query.toString()}`, { scroll: false })
    },
    [projectParam, router],
  )

// Each flow step has its own landing target; a step whose specific target does not exist
// yet (nothing to probe, nothing to resolve) falls back to its panel.
const ANCHOR_FALLBACK: Record<string, string> = {
  'probe-first': 'connections-panel',
  'bind-btn': 'bindings-panel',
}

  // Flow-guide jumps flash the step's own target — a button or the resolve card — and
  // scroll only when that target is off-screen. Switching tabs alone reads as "nothing
  // happened"; scrolling to an already-visible panel reads as "where did it go".
  const gotoReveal = useCallback(
    (next: 'connections' | 'bindings', anchor?: string) => {
      setTab(next)
      if (typeof window === 'undefined' || !anchor) return
      window.setTimeout(() => {
        const el = document.getElementById(anchor) ?? document.getElementById(ANCHOR_FALLBACK[anchor] ?? '')
        if (!el) return
        el.classList.add('ring-2', 'ring-primary', 'rounded-xl')
        window.setTimeout(() => el.classList.remove('ring-2', 'ring-primary', 'rounded-xl'), 1600)
        const rect = el.getBoundingClientRect()
        if (rect.top >= 0 && rect.bottom <= window.innerHeight) return
        // Do NOT drive this with requestAnimationFrame: a throttled or background tab
        // never fires rAF, and the scroll would silently never happen. A plain interval
        // fires even when clamped, and 'instant' beats any page scroll-behavior.
        const startedAt = Date.now()
        const land = window.setInterval(() => {
          const target = document.getElementById(anchor) ?? document.getElementById(ANCHOR_FALLBACK[anchor] ?? '')
          if (!target) return
          target.scrollIntoView({ behavior: 'instant', block: 'center' })
          const r = target.getBoundingClientRect()
          if ((r.top >= 0 && r.bottom <= window.innerHeight) || Date.now() - startedAt > 3000) {
            window.clearInterval(land)
          }
        }, 200)
      }, 350)
    },
    [setTab],
  )

  const loadConnections = useCallback(() => api<Connection[]>('/providers/connections'), [api, organizationId])
  const connections = useAsync<Connection[]>(loadConnections, [])

  const loadBindings = useCallback(() => api<Binding[]>('/bindings'), [api, organizationId])
  const bindings = useAsync<Binding[]>(loadBindings, [])

  const loadCatalogs = useCallback(() => api<Catalog[]>('/providers/catalogs'), [api])
  const catalogs = useAsync<Catalog[]>(loadCatalogs, [])

  // 就绪度要说「现在跑不跑得通」，只有真实调用履历能回答；探测时间戳不会自己变红。
  const loadCallEvidence = useCallback(() => api<CallEvidenceMap>('/providers/call-evidence'), [api, organizationId])
  const callEvidence = useAsync<CallEvidenceMap>(loadCallEvidence, {})

  const rail = useTabRail(tab)

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
              bindings.reload()
              catalogs.reload()
              callEvidence.reload()
            }}
          >
            <RefreshCwIcon />
            {t('common.refresh')}
          </Button>
        }
      />

      <FlowGuide onGoto={gotoReveal} />

      <Tabs value={tab} onValueChange={value => setTab(value as ModelsTab)}>
        <div className="tab-rail-hint" data-more={rail.more ? '1' : '0'}>
          <TabsList ref={rail.ref} className="tab-rail w-full justify-start rounded-none border-b bg-transparent px-0">
            <TabsTrigger value="readiness">
              <ListChecksIcon />
              {t('models.tab.readiness')}
            </TabsTrigger>
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
        </div>
        <TabsContent value="readiness">
          <ReadinessPanel
            connections={connections}
            bindings={bindings}
            catalogs={catalogs.data}
            callEvidence={callEvidence.data}
            onGoto={setTab}
          />
        </TabsContent>
        <TabsContent value="connections">
          <ConnectionsPanel connections={connections} catalogs={catalogs.data} bindings={bindings} onManageDefaults={() => setTab('bindings')} />
        </TabsContent>
        <TabsContent value="bindings">
          <BindingsPanel connections={connections} bindings={bindings} projectScope={projectParam} />
        </TabsContent>
        <TabsContent value="catalogs">
          <CatalogsPanel catalogs={catalogs} onChanged={catalogs.reload} />
        </TabsContent>
      </Tabs>
    </>
  )
}

function FlowGuide({ onGoto }: { onGoto: (tab: 'connections' | 'bindings', anchor?: string) => void }) {
  const { t } = useI18n()
  const { can } = useSession()
  // Three of the four steps are ADMIN-only writes. Left visible, they are cards that
  // jump a REVIEWER or VIEWER onto a panel where every control is greyed out.
  if (!can('providers:manage') && !can('bindings:manage')) return null
  const steps = [
    { text: t('models.flow.step1'), tab: 'connections' as const, tabLabel: t('models.flow.link1'), anchor: 'connections-panel' },
    { text: t('models.flow.step2'), tab: 'connections' as const, tabLabel: t('models.flow.link2'), anchor: 'probe-first' },
    { text: t('models.flow.step3'), tab: 'bindings' as const, tabLabel: t('models.flow.link3'), anchor: 'bind-btn' },
    { text: t('models.flow.step4'), tab: 'bindings' as const, tabLabel: t('models.flow.link4'), anchor: 'resolve-card' },
  ]

  return (
    <Card className="gap-3 px-5 py-4">
      <p className="text-muted-foreground text-xs font-medium">{t('models.flow.title')}</p>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {steps.map((step, index) => (
          <button
            key={step.text}
            type="button"
            onClick={() => onGoto(step.tab, step.anchor)}
            className="group -m-2 flex gap-3 rounded-lg p-2 text-left transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <span className="bg-muted text-muted-foreground group-hover:bg-primary group-hover:text-primary-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums">
              {index + 1}
            </span>
            <span className="min-w-0">
              <span className="text-primary mb-1 flex items-center gap-1 text-xs font-medium">
                {step.tabLabel}
                <ArrowRightIcon className="size-3 transition-transform group-hover:translate-x-0.5" />
              </span>
              <span className="text-muted-foreground block text-sm leading-relaxed">{step.text}</span>
            </span>
          </button>
        ))}
      </div>
    </Card>
  )
}
