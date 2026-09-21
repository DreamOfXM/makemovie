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
  // Chrome page-translation rewrites text nodes behind React's back, which crashes
  // every later re-render with NotFoundError: removeChild. The app ships its own i18n.
  other: { google: 'notranslate' },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // I18nProvider rewrites <html lang> once the stored locale is known.
    <html lang="en" translate="no" suppressHydrationWarning>
      <body className="bg-background text-foreground font-sans antialiased">
        {/* Dark by default: reviewers judge cut colors on these pages, and a light
            chrome biases perceived color — every video tool in the market ships dark. */}
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
          <I18nProvider>
            <SessionProvider>{children}</SessionProvider>
            <Toaster />
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
