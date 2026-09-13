'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { CheckIcon, CircleAlertIcon, ClapperboardIcon, SparklesIcon } from 'lucide-react'
import { request } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { BootScreen } from '@/components/boot-screen'
import { LocaleSwitcher } from '@/components/locale-switcher'
import { ThemeToggle } from '@/components/theme-toggle'

type Mode = 'login' | 'register'

const heroPoints = ['auth.heroPoint1', 'auth.heroPoint2', 'auth.heroPoint3'] as const

export default function LoginPage() {
  const { t } = useI18n()
  const { status, signIn } = useSession()
  const router = useRouter()

  const [mode, setMode] = useState<Mode>('register')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [organizationName, setOrganizationName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (status === 'authenticated') router.replace('/projects')
  }, [status, router])

  if (status !== 'anonymous') return <BootScreen />

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const data =
        mode === 'register'
          ? await request<{ token: string }>('/auth/register', {
              method: 'POST',
              body: JSON.stringify({ email, password, organizationName, name: name.trim() || undefined }),
            })
          : await request<{ token: string }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
      await signIn(data.token)
      toast.success(t('auth.welcome'))
      router.replace('/projects')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.generic'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-background grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <section className="bg-sidebar relative hidden flex-col justify-between overflow-hidden border-r p-10 lg:flex">
        <div
          className="from-primary/12 pointer-events-none absolute -top-32 -right-24 size-96 rounded-full bg-radial to-transparent blur-2xl"
          aria-hidden
        />
        <div className="relative flex items-center gap-3">
          <span className="from-primary to-primary/60 flex size-10 items-center justify-center rounded-xl bg-linear-to-br text-primary-foreground shadow-raised">
            <ClapperboardIcon className="size-5" />
          </span>
          <span>
            <span className="block text-sm font-semibold">{t('app.title')}</span>
            <span className="text-muted-foreground block text-xs">{t('app.tagline')}</span>
          </span>
        </div>

        <div className="relative max-w-md space-y-6">
          <h1 className="text-3xl leading-tight font-semibold tracking-tight text-balance">{t('auth.heroTitle')}</h1>
          <p className="text-muted-foreground text-sm leading-relaxed">{t('auth.heroBody')}</p>
          <ul className="space-y-3">
            {heroPoints.map(point => (
              <li key={point} className="flex items-start gap-3 text-sm">
                <span className="bg-primary/12 text-primary mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full">
                  <CheckIcon className="size-3" />
                </span>
                {t(point)}
              </li>
            ))}
          </ul>
        </div>

        <p className="text-muted-foreground relative flex items-center gap-2 text-xs">
          <SparklesIcon className="size-3.5" />
          Apache-2.0
        </p>
      </section>

      <section className="flex flex-col">
        <div className="flex items-center justify-end gap-1 p-4">
          <LocaleSwitcher />
          <ThemeToggle />
        </div>
        <div className="flex flex-1 items-center justify-center px-4 pb-10">
          <Card className="w-full max-w-md shadow-raised">
            <CardHeader>
              <CardTitle>{mode === 'register' ? t('auth.register') : t('auth.login')}</CardTitle>
              <CardDescription>{mode === 'register' ? t('auth.registerHint') : t('auth.welcome')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs
                value={mode}
                onValueChange={value => {
                  setMode(value as Mode)
                  setError('')
                }}
                className="mb-6"
              >
                <TabsList className="w-full">
                  <TabsTrigger value="register" className="flex-1">
                    {t('auth.register')}
                  </TabsTrigger>
                  <TabsTrigger value="login" className="flex-1">
                    {t('auth.login')}
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              <form onSubmit={submit} className="space-y-4">
                {mode === 'register' && (
                  <>
                    <Field label={t('auth.orgName')} htmlFor="organizationName" required hint={t('auth.orgHint')}>
                      <Input
                        id="organizationName"
                        value={organizationName}
                        onChange={event => setOrganizationName(event.target.value)}
                        required
                        autoComplete="organization"
                      />
                    </Field>
                    <Field label={t('auth.name')} htmlFor="name">
                      <Input
                        id="name"
                        value={name}
                        onChange={event => setName(event.target.value)}
                        autoComplete="name"
                        placeholder={t('common.optional')}
                      />
                    </Field>
                  </>
                )}

                <Field label={t('auth.email')} htmlFor="email" required>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={event => setEmail(event.target.value)}
                    required
                    autoComplete="email"
                  />
                </Field>

                <Field label={t('auth.password')} htmlFor="password" required hint={t('auth.passwordHint')}>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                    required
                    minLength={8}
                    autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  />
                </Field>

                {error && (
                  <Alert variant="destructive">
                    <CircleAlertIcon />
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                <Button type="submit" className="w-full" size="lg" disabled={busy}>
                  {busy && t('auth.signingIn')}
                  {!busy && (mode === 'register' ? t('auth.register') : t('auth.login'))}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  )
}
