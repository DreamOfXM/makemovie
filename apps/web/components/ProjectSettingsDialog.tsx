'use client'

import { useEffect, useState } from 'react'
import { Settings2Icon } from 'lucide-react'
import { toast } from 'sonner'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { StyleSelector } from '@/components/StyleSelector'

interface ProjectSettingsDialogProps {
  open: boolean
  projectId: string
  currentStyleId: string | null
  onOpenChange: (open: boolean) => void
  onStyleChanged: () => void
}

export function ProjectSettingsDialog({
  open,
  projectId,
  currentStyleId,
  onOpenChange,
  onStyleChanged,
}: ProjectSettingsDialogProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const [selectedStyleId, setSelectedStyleId] = useState<string | undefined>(currentStyleId ?? undefined)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setSelectedStyleId(currentStyleId ?? undefined)
  }, [currentStyleId])

  async function handleSave() {
    setSaving(true)
    try {
      await api(`/projects/${projectId}/apply-style`, {
        method: 'POST',
        body: JSON.stringify({ styleId: selectedStyleId }),
      })
      toast.success(t('settings.saved'))
      onStyleChanged()
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('settings.title')}</DialogTitle>
          <DialogDescription>{t('settings.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          <div>
            <h3 className="text-sm font-medium mb-3">{t('settings.style')}</h3>
            <StyleSelector
              value={selectedStyleId}
              onChange={setSelectedStyleId}
              disabled={saving}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving || selectedStyleId === currentStyleId}>
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// Settings button for project page
interface SettingsButtonProps {
  onClick: () => void
  disabled?: boolean
}

export function SettingsButton({ onClick, disabled }: SettingsButtonProps) {
  const { t } = useI18n()

  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={disabled}>
      <Settings2Icon className="size-4" />
      {t('settings.open')}
    </Button>
  )
}
