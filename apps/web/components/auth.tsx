'use client'

import { useState, type FormEvent } from 'react'
import { request } from '../lib/api'
import { useI18n } from '../lib/i18n'

export function AuthPanel({ onAuthenticated }: { onAuthenticated(token: string): void }) {
  const { t } = useI18n()
  const [mode, setMode] = useState<'login' | 'register'>('register')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [organizationName, setOrganizationName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (mode === 'register') {
        const data = await request<{ token: string }>('/auth/register', {
          method: 'POST',
          body: JSON.stringify({ email, password, organizationName }),
        })
        onAuthenticated(data.token)
      } else {
        const data = await request<{ token: string }>('/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        })
        onAuthenticated(data.token)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.generic'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <h1>{t('app.title')}</h1>
      <p className="tagline">{t('app.tagline')}</p>
      <form onSubmit={submit} className="card auth-form">
        <label>
          {t('auth.email')}
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        <label>
          {t('auth.password')}
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} autoComplete="current-password" />
        </label>
        {mode === 'register' && (
          <label>
            {t('auth.orgName')}
            <input value={organizationName} onChange={e => setOrganizationName(e.target.value)} required />
          </label>
        )}
        <button type="submit" disabled={busy}>
          {mode === 'register' ? t('auth.register') : t('auth.login')}
        </button>
        {error && <p className="error">{error}</p>}
        <button type="button" className="link" onClick={() => setMode(mode === 'register' ? 'login' : 'register')}>
          {mode === 'register' ? t('auth.toLogin') : t('auth.toRegister')}
        </button>
      </form>
    </main>
  )
}
