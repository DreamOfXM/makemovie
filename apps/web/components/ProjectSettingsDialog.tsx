'use client'

import { useEffect, useState } from 'react'
import { Settings2Icon } from 'lucide-react'
import { toast } from 'sonner'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { StyleSelector } from '@/components/StyleSelector'
import { apiErrorMessage } from '@/lib/api-error'
import { cn } from '@/lib/utils'

interface ProjectSettingsDialogProps {
  open: boolean
  projectId: string
  currentStyleId: string | null
  /** 审计重抽上限（1-3）；null=默认 2。花用户的钱，次数由项目主人定。 */
  qcMaxAttempts: number | null
  onOpenChange: (open: boolean) => void
  onStyleChanged: () => void
}

export function ProjectSettingsDialog({
  open,
  projectId,
  currentStyleId,
  qcMaxAttempts,
  onOpenChange,
  onStyleChanged,
}: ProjectSettingsDialogProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const [selectedStyleId, setSelectedStyleId] = useState<string | undefined>(currentStyleId ?? undefined)
  const [attempts, setAttempts] = useState<number>(qcMaxAttempts ?? 2)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setSelectedStyleId(currentStyleId ?? undefined)
    setAttempts(qcMaxAttempts ?? 2)
  }, [currentStyleId, qcMaxAttempts, open])

  async function handleSave() {
    setSaving(true)
    try {
      await api(`/projects/${projectId}/apply-style`, {
        method: 'POST',
        body: JSON.stringify({ styleId: selectedStyleId }),
      })
      await api(`/projects/${projectId}`, {
        method: 'PATCH',
        body: JSON.stringify({ qcMaxAttempts: attempts }),
      })
      toast.success(t('settings.saved'))
      onStyleChanged()
      onOpenChange(false)
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle>{t('settings.title')}</DialogTitle>
          <DialogDescription>{t('settings.description')}</DialogDescription>
        </DialogHeader>

        {/* Only the grid scrolls; the footer actions stay reachable no matter how
            many styles the organization has. */}
        <div className="min-h-0 flex-1 overflow-y-auto py-4">
          <h3 className="text-sm font-medium mb-1">{t('settings.qcAttempts')}</h3>
          <p className="text-muted-foreground mb-2.5 text-xs leading-relaxed">{t('settings.qcAttemptsHint')}</p>
          <div className="mb-2 flex items-center gap-1.5">
            {[1, 2, 3].map(value => (
              <button
                key={value}
                type="button"
                aria-pressed={attempts === value}
                onClick={() => setAttempts(value)}
                disabled={saving}
                className={cn(
                  'h-7 rounded-md border px-3 text-xs font-medium transition-colors',
                  attempts === value ? 'border-primary bg-primary/15 text-primary' : 'border-control-line hover:bg-accent/50',
                )}
              >
                {t('settings.qcAttemptsOption', { count: value })}
              </button>
            ))}
          </div>
          <h3 className="text-sm font-medium mb-3">{t('settings.style')}</h3>
          <StyleSelector
            value={selectedStyleId}
            onChange={setSelectedStyleId}
            disabled={saving}
          />
        </div>

        <div className="flex justify-end gap-2 border-t pt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving || (selectedStyleId === (currentStyleId ?? undefined) && attempts === (qcMaxAttempts ?? 2))}>
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
