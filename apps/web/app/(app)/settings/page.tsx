import { Suspense } from 'react'
import { SettingsPage, SettingsSkeleton } from '@/components/settings/settings-page'

export default function Page() {
  return (
    <Suspense fallback={<SettingsSkeleton />}>
      <SettingsPage />
    </Suspense>
  )
}
