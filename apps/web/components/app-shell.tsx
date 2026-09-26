'use client'

import { Suspense, useCallback, useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { apiErrorMessage } from '@/lib/api-error'
import {
  ArrowLeftIcon,
  Building2Icon,
  CheckIcon,
  ChevronDownIcon,
  ClapperboardIcon,
  CpuIcon,
  FilmIcon,
  LogOutIcon,
  MenuIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  ReceiptTextIcon,
  ScrollTextIcon,
  UsersIcon,
  XIcon,
} from 'lucide-react'
import type { Action } from '@studio/domain'
import type { Project } from '@/lib/api'
import { cn, initials } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LocaleSwitcher } from '@/components/locale-switcher'
import { SkinSelector } from '@/components/ui/skin-selector'
import { ThemeToggle } from '@/components/theme-toggle'

/** Which way the rail sits is a per-device habit, not account data. */
const NAV_COLLAPSED_KEY = 'studio.nav.collapsed'

interface NavItem {
  href: string
  labelKey: string
  icon: ReactNode
  action?: Action
  // Query-scoped links (/models?tab=…) must still light up on their page,
  // so active-ness matches on the path part unless an override says otherwise.
  isActive?(pathname: string): boolean
}

/** Space-level rail: everything that belongs to the organization, not one project. */
const spaceItems: NavItem[] = [
  { href: '/projects', labelKey: 'nav.projects', icon: <ClapperboardIcon /> },
  { href: '/models?tab=connections', labelKey: 'nav.connections', icon: <CpuIcon />, isActive: p => p === '/models' },
  { href: '/members', labelKey: 'nav.members', icon: <UsersIcon /> },
  { href: '/usage', labelKey: 'nav.usage', icon: <ReceiptTextIcon /> },
  { href: '/audit', labelKey: 'nav.audit', icon: <ScrollTextIcon />, action: 'audit:read' },
]

function projectItems(projectId: string): NavItem[] {
  return [
    { href: `/projects/${projectId}`, labelKey: 'nav.episodes', icon: <FilmIcon /> },
    { href: `/models?tab=bindings&project=${projectId}`, labelKey: 'nav.bindings', icon: <CpuIcon />, isActive: p => p === '/models' },
    { href: `/usage?project=${projectId}`, labelKey: 'nav.usage', icon: <ReceiptTextIcon />, isActive: p => p === '/usage' },
  ]
}

function navBase(href: string): string {
  return href.split('?')[0]
}

function defaultActive(item: NavItem, pathname: string): boolean {
  if (item.isActive) return item.isActive(pathname)
  const base = navBase(item.href)
  return pathname === base || pathname.startsWith(`${base}/`)
}

/** The project in scope comes from the route itself, never from local state. */
function projectIdFromPath(pathname: string): string | null {
  const match = /^\/projects\/([^/]+)/.exec(pathname)
  return match ? decodeURIComponent(match[1]) : null
}

/** Space surfaces that can also be pulled into one project's scope by the `project` query. */
const QUERY_SCOPED_PATHS = new Set(['/models', '/usage'])

function scopedProjectId(pathname: string, searchParams: URLSearchParams): string | null {
  const fromPath = projectIdFromPath(pathname)
  if (fromPath) return fromPath
  if (!QUERY_SCOPED_PATHS.has(pathname)) return null
  return searchParams.get('project')
}

function OrgSwitcher() {
  const { t } = useI18n()
  const { me, organizationId, switchOrganization } = useSession()
  const [busy, setBusy] = useState(false)
  const memberships = me?.memberships ?? []
  const current = memberships.find(item => item.organizationId === organizationId)

  if (memberships.length < 2) {
    return (
      <div className="hidden min-w-0 items-center gap-2 rounded-md border bg-card px-3 py-1.5 md:flex">
        <Building2Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium">{current?.organizationName ?? '—'}</span>
        <Badge variant="secondary" className="shrink-0">
          {t(`role.${current?.role ?? 'VIEWER'}`)}
        </Badge>
      </div>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* Button 基础类带 shrink-0，390px 下它会把头像顶出屏（整页横向滚动）——这里必须显式允许收缩 */}
        <Button variant="outline" size="sm" className="min-w-0 max-w-40 shrink gap-2" disabled={busy}>
          <Building2Icon className="text-muted-foreground shrink-0" />
          <span className="min-w-0 flex-1 truncate">{current?.organizationName ?? '—'}</span>
          <ChevronDownIcon className="text-muted-foreground shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="font-normal text-muted-foreground">{t('org.switch')}</DropdownMenuLabel>
        {memberships.map(membership => (
          <DropdownMenuItem
            key={membership.organizationId}
            disabled={busy || membership.organizationId === organizationId}
            onClick={async () => {
              setBusy(true)
              try {
                await switchOrganization(membership.organizationId)
                toast.success(t('org.switched', { name: membership.organizationName }))
              } catch (error) {
                toast.error(apiErrorMessage(error, t))
              } finally {
                setBusy(false)
              }
            }}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{membership.organizationName}</p>
              <p className="text-xs text-muted-foreground">{t(`role.${membership.role}`)}</p>
            </div>
            <CheckIcon className={cn('ml-auto', membership.organizationId === organizationId ? 'opacity-100' : 'opacity-0')} />
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('org.switchHint')}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function UserMenu() {
  const { t } = useI18n()
  const { me, role, signOut } = useSession()
  const router = useRouter()
  if (!me) return null
  const name = me.user.name || me.user.email

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2 px-2">
          <span className="bg-primary/10 text-primary flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
            {initials(me.user.email, me.user.name)}
          </span>
          <span className="hidden max-w-40 truncate text-sm font-medium lg:block">{name}</span>
          <ChevronDownIcon className="hidden text-muted-foreground lg:block" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>
          <p className="text-sm font-medium">{name}</p>
          <p className="text-xs font-normal text-muted-foreground">{me.user.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="text-xs text-muted-foreground">{t('org.role')}</span>
          <Badge variant="tinted">{t(`role.${role ?? 'VIEWER'}`)}</Badge>
        </div>
        <p className="text-muted-foreground px-2 pb-1.5 text-xs">{t(`role.${role ?? 'VIEWER'}.hint`)}</p>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={async () => {
            await signOut()
            router.replace('/login')
          }}
        >
          <LogOutIcon />
          {t('user.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface SidebarContentProps {
  collapsed?: boolean
  onNavigate?: () => void
  onToggleCollapsed?: () => void
}

function SidebarContent({ collapsed = false, onNavigate, onToggleCollapsed }: SidebarContentProps) {
  const { t } = useI18n()
  const { api, me, organizationId, role, can: canPerform } = useSession()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const projectId = scopedProjectId(pathname, searchParams)
  const organizationName = me?.memberships.find(item => item.organizationId === organizationId)?.organizationName ?? null

  // The project name is only worth a request once a project is actually in scope.
  const loadProjects = useCallback(
    () => (projectId ? api<Project[]>('/projects') : Promise.resolve<Project[]>([])),
    [api, projectId],
  )
  const projects = useAsync<Project[]>(loadProjects, [])
  const projectName = projectId ? projects.data.find(item => item.id === projectId)?.name ?? null : null

  const items = (projectId ? projectItems(projectId) : spaceItems).filter(item => !item.action || canPerform(item.action))
  const returnLink = (
    <Link
      href="/projects"
      onClick={onNavigate}
      aria-label={t('nav.backToSpace')}
      className={cn(
        'group flex items-center gap-3 rounded-md py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-primary',
        collapsed ? 'justify-center px-2' : 'px-3',
      )}
    >
      {/* The space name *is* the back control: the glyph swaps in place, so nothing shifts. */}
      <span className="relative size-4.5 shrink-0">
        <Building2Icon className="absolute inset-0 transition-opacity group-hover:opacity-0" />
        <ArrowLeftIcon className="text-primary absolute inset-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
      </span>
      {!collapsed && <span className="truncate">{organizationName ?? t('app.title')}</span>}
    </Link>
  )

  return (
    <div className={cn('flex h-full flex-col gap-6 p-4', collapsed && 'items-center gap-4 px-2')}>
      <div className={cn('flex items-center gap-1', collapsed && 'flex-col gap-4')}>
        <Link href="/projects" onClick={onNavigate} className={cn('flex min-w-0 flex-1 items-center gap-3 py-1', collapsed && 'flex-none justify-center')}>
          <span className="from-primary to-primary/60 flex size-9 shrink-0 items-center justify-center rounded-lg bg-linear-to-br text-primary-foreground shadow-sm">
            <ClapperboardIcon className="size-5" />
          </span>
          {!collapsed && (
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold">{t('app.title')}</span>
              <span className="text-muted-foreground block truncate text-xs">{t('app.tagline')}</span>
            </span>
          )}
        </Link>

        {onToggleCollapsed && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
                onClick={onToggleCollapsed}
              >
                {collapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{collapsed ? t('nav.expand') : t('nav.collapse')}</TooltipContent>
          </Tooltip>
        )}
      </div>

      <nav className={cn('flex-1 space-y-1', collapsed && 'space-y-4')}>
        {projectId && (
          collapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>{returnLink}</TooltipTrigger>
              <TooltipContent side="right">{t('nav.backToSpace')}</TooltipContent>
            </Tooltip>
          ) : (
            returnLink
          )
        )}
        <div>
          {!collapsed && (
            <p className="text-muted-foreground px-3 pb-1 text-xs font-medium tracking-wide uppercase">
              {t(projectId ? 'nav.group.project' : 'nav.group.space')}
            </p>
          )}
          {!collapsed && projectId && projectName && (
            <p className="min-w-0 px-3 pb-1"><span className="block truncate text-sm font-semibold">{projectName}</span></p>
          )}
          {items.map(item => {
            const active = defaultActive(item, pathname)
            const link = (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                aria-label={collapsed ? t(item.labelKey) : undefined}
                className={cn(
                  'group flex items-center gap-3 rounded-md py-2 text-sm font-medium transition-colors',
                  collapsed ? 'justify-center px-2' : 'px-3',
                  active
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <span className={cn('[&_svg]:size-4.5', active ? 'text-primary' : 'text-muted-foreground')}>
                  {item.icon}
                </span>
                {!collapsed && t(item.labelKey)}
              </Link>
            )
            // An icon with nothing to read is only navigable if it says what it is.
            if (!collapsed) return link
            return (
              <Tooltip key={item.href}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right">{t(item.labelKey)}</TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      </nav>

      {!collapsed && me && (
        <div className="space-y-2">
          <Separator />
          {/* 头像跨两行，用户名与角色各占一行；徽章跟在第二行末尾 —— 原来的
              justify-between 把它甩到容器右端，中间空出 150px，读起来像两个控件。 */}
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 px-2 pt-1">
            <span
              aria-hidden
              className="bg-primary/10 text-primary row-span-2 flex size-[26px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
            >
              {initials(me.user.email, me.user.name)}
            </span>
            <p className="truncate text-xs font-medium">{me.user.name || me.user.email}</p>
            <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-[11px]">
              {t('org.role')}
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">
                {t(`role.${role ?? 'VIEWER'}`)}
              </Badge>
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const [navOpen, setNavOpen] = useState(false)
  const [navCollapsed, setNavCollapsed] = useState(false)
  const pathname = usePathname()

  useEffect(() => setNavOpen(false), [pathname])
  // Reading the preference during render would ship server markup and hydrate a
  // different client tree, so the rail expands a frame late instead of flickering.
  useEffect(() => {
    setNavCollapsed(window.localStorage.getItem(NAV_COLLAPSED_KEY) === '1')
  }, [])

  function toggleNavCollapsed() {
    const next = !navCollapsed
    setNavCollapsed(next)
    window.localStorage.setItem(NAV_COLLAPSED_KEY, next ? '1' : '0')
  }

  return (
    <div className="bg-background min-h-dvh">
      <aside
        className={cn(
          'border-sidebar-border bg-sidebar fixed inset-y-0 left-0 z-40 hidden border-r lg:block',
          navCollapsed ? 'w-16' : 'w-64',
        )}
      >
        {/* SidebarContent reads the `project` query, so it needs a Suspense boundary. */}
        <Suspense fallback={null}>
          <SidebarContent collapsed={navCollapsed} onToggleCollapsed={toggleNavCollapsed} />
        </Suspense>
      </aside>

      {navOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="bg-foreground/40 absolute inset-0 backdrop-blur-sm"
            onClick={() => setNavOpen(false)}
            aria-hidden
          />
          <div className="bg-sidebar border-sidebar-border absolute inset-y-0 left-0 w-72 border-r shadow-overlay">
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-4 right-3"
              onClick={() => setNavOpen(false)}
              aria-label={t('common.close')}
            >
              <XIcon />
            </Button>
            <Suspense fallback={null}>
              <SidebarContent onNavigate={() => setNavOpen(false)} />
            </Suspense>
          </div>
        </div>
      )}

      <div className={cn('flex min-h-dvh flex-col', navCollapsed ? 'lg:pl-16' : 'lg:pl-64')}>
        <header className="bg-background/80 sticky top-0 z-30 flex h-14 items-center gap-3 border-b px-4 backdrop-blur-md lg:px-6">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setNavOpen(true)} aria-label={t('nav.projects')}>
            <MenuIcon />
          </Button>
          <div className="min-w-0 flex-1" />
          <OrgSwitcher />
          <div className="flex items-center gap-1">
            <LocaleSwitcher />
            <SkinSelector />
            <ThemeToggle />
            <Separator orientation="vertical" className="mx-1 h-6" />
            <UserMenu />
          </div>
        </header>
        <main className="w-full flex-1 space-y-6 px-4 py-6 lg:px-6 lg:py-8">{children}</main>
      </div>
    </div>
  )
}
