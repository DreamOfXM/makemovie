'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  Building2Icon,
  CheckIcon,
  ChevronDownIcon,
  ClapperboardIcon,
  CpuIcon,
  LogOutIcon,
  MenuIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  ScrollTextIcon,
  UsersIcon,
  XIcon,
} from 'lucide-react'
import type { Action } from '@studio/domain'
import { cn, initials } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
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
import { ThemeToggle } from '@/components/theme-toggle'

/** Which way the rail sits is a per-device habit, not account data. */
const NAV_COLLAPSED_KEY = 'studio.nav.collapsed'

interface NavItem {
  href: string
  labelKey: string
  icon: ReactNode
  action?: Action
}

const navGroups: { labelKey: string; items: NavItem[] }[] = [
  {
    labelKey: 'nav.group.production',
    items: [{ href: '/projects', labelKey: 'nav.projects', icon: <ClapperboardIcon /> }],
  },
  {
    labelKey: 'nav.group.platform',
    items: [
      { href: '/models', labelKey: 'nav.models', icon: <CpuIcon /> },
      { href: '/members', labelKey: 'nav.members', icon: <UsersIcon /> },
      { href: '/audit', labelKey: 'nav.audit', icon: <ScrollTextIcon />, action: 'audit:read' },
    ],
  },
]

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
        <Button variant="outline" size="sm" className="gap-2" disabled={busy}>
          <Building2Icon className="text-muted-foreground" />
          <span className="max-w-40 truncate">{current?.organizationName ?? '—'}</span>
          <ChevronDownIcon className="text-muted-foreground" />
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
                toast.error(error instanceof Error ? error.message : t('error.generic'))
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
  const { role, can: canPerform } = useSession()
  const pathname = usePathname()

  return (
    <div className={cn('flex h-full flex-col gap-6 p-4', collapsed && 'items-center gap-4 px-2')}>
      <Link href="/projects" onClick={onNavigate} className={cn('flex items-center gap-3 py-1', collapsed && 'justify-center')}>
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
              className={cn('self-end', collapsed && 'self-center')}
              aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
              onClick={onToggleCollapsed}
            >
              {collapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{collapsed ? t('nav.expand') : t('nav.collapse')}</TooltipContent>
        </Tooltip>
      )}

      <nav className={cn('flex-1 space-y-6', collapsed && 'space-y-4')}>
        {navGroups.map(group => {
          const items = group.items.filter(item => !item.action || canPerform(item.action))
          if (items.length === 0) return null
          return (
            <div key={group.labelKey} className="space-y-1">
              {!collapsed && (
                <p className="text-muted-foreground px-3 pb-1 text-xs font-medium tracking-wide uppercase">
                  {t(group.labelKey)}
                </p>
              )}
              {items.map(item => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
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
          )
        })}
      </nav>

      {!collapsed && (
        <div className="space-y-2">
          <Separator />
          <div className="flex items-center justify-between gap-2 px-2 pt-1">
            <span className="text-muted-foreground text-xs">{t('org.role')}</span>
            <Badge variant="outline">{t(`role.${role ?? 'VIEWER'}`)}</Badge>
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
        <SidebarContent collapsed={navCollapsed} onToggleCollapsed={toggleNavCollapsed} />
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
            <SidebarContent onNavigate={() => setNavOpen(false)} />
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
