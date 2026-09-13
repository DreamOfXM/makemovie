'use client'

import { useCallback, useEffect, useState } from 'react'
import { getToken, request, setToken as persistToken, type MeResponse } from '../lib/api'
import { I18nProvider, LocaleSwitcher, useI18n } from '../lib/i18n'
import { AuthPanel } from '../components/auth'
import { ProjectsPanel } from '../components/projects'
import { ModelsPanel } from '../components/models'
import { MembersPanel } from '../components/members'

type Tab = 'projects' | 'models' | 'members'

function Workspace() {
  const { t, locale } = useI18n()
  const [token, setTokenState] = useState<string | null>(null)
  const [me, setMe] = useState<MeResponse | null>(null)
  const [tab, setTab] = useState<Tab>('projects')
  const [booting, setBooting] = useState(true)

  const signOut = useCallback(async (current: string | null) => {
    if (current) {
      try { await request('/auth/logout', { method: 'POST', token: current }) } catch { /* session already gone */ }
    }
    persistToken(null)
    setTokenState(null)
    setMe(null)
  }, [])

  useEffect(() => {
    const saved = getToken()
    if (!saved) { setBooting(false); return }
    request<MeResponse>('/auth/me', { token: saved })
      .then(setMe)
      .then(() => setTokenState(saved))
      .catch(() => persistToken(null))
      .finally(() => setBooting(false))
  }, [])

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
  }, [locale])

  if (booting) return <main className="auth-page"><p>{t('app.title')}…</p></main>
  if (!token || !me) return <AuthPanel onAuthenticated={async nextToken => {
    persistToken(nextToken)
    const meResponse = await request<MeResponse>('/auth/me', { token: nextToken })
    setMe(meResponse)
    setTokenState(nextToken)
  }} />

  return (
    <div className="workspace">
      <header className="topbar">
        <div>
          <strong>{t('app.title')}</strong>
          <small> · {me.memberships.find(m => m.organizationId === me.organization.id)?.organizationName ?? ''} · {t('auth.role')}: {me.organization.role}</small>
        </div>
        <nav className="tabs">
          <button className={tab === 'projects' ? 'active' : ''} onClick={() => setTab('projects')}>{t('nav.projects')}</button>
          <button className={tab === 'models' ? 'active' : ''} onClick={() => setTab('models')}>{t('nav.models')}</button>
          <button className={tab === 'members' ? 'active' : ''} onClick={() => setTab('members')}>{t('nav.members')}</button>
        </nav>
        <div className="row">
          <LocaleSwitcher />
          <button type="button" className="secondary" onClick={() => void signOut(token)}>{t('auth.logout')}</button>
        </div>
      </header>
      <main className="content">
        {tab === 'projects' && <ProjectsPanel token={token} />}
        {tab === 'models' && <ModelsPanel token={token} />}
        {tab === 'members' && <MembersPanel token={token} />}
      </main>
    </div>
  )
}

export default function HomePage() {
  return (
    <I18nProvider>
      <Workspace />
    </I18nProvider>
  )
}
