import type { ReactNode } from 'react'
import type { Metadata, Viewport } from 'next'
import { I18nProvider } from '@/lib/i18n'
import { SessionProvider } from '@/lib/session'
import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import './globals.css'

export const metadata: Metadata = {
  title: { default: 'MakeMovie', template: '%s · MakeMovie' },
  description: 'AI film & video production line — from text to finished cut',
  applicationName: 'MakeMovie',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // I18nProvider rewrites <html lang> once the stored locale is known.
    <html lang="en" suppressHydrationWarning>
      <body className="bg-background text-foreground font-sans antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <I18nProvider>
            <SessionProvider>{children}</SessionProvider>
            <Toaster />
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
