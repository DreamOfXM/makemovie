'use client'

import { useState } from 'react'
import { LoaderCircleIcon } from 'lucide-react'
import { toast } from 'sonner'
import { useI18n } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/api-error'
import { useSession } from '@/lib/session'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

interface VetoTakeDialogProps {
  /** 被否决的那一件产物版本：否决落在版本上，不落在那一镜上——同镜其他版不受影响。 */
  artifactId: string
  /** 弹窗点名否的是哪一版（#20 视频片段 v2 · 5.4s）：不点名，「不可用」就落在人记住的那一版上。 */
  label: string
  onClose(): void
  onChanged(): void
}

/**
 * SD-172｜机器过了、人不认：这里给的就是「人说不」的那一刀。
 *
 * 没有这一格之前，过了质检的版本会被「自动取最新」直接取走，人手上只剩「切版本」与
 * 「重跑」——切版本不解释为什么不要它，重跑又要再花一次钱。否决写进产物自己的元数据
 * （后端 resolveShotTake 与合成共用同一条口径），生效版随即换回上一版可用的，
 * 而这一版仍留在履历里带着它的理由：否决不是删除。
 *
 * 理由必填：一次付费出片被人判不可用，却没人知道为什么，下一步就只能靠猜。
 */
export function VetoTakeDialog({ artifactId, label, onClose, onChanged }: VetoTakeDialogProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const trimmed = reason.trim()

  async function submit() {
    setBusy(true)
    try {
      await api(`/artifacts/${artifactId}/veto`, { method: 'POST', body: JSON.stringify({ reason: trimmed }) })
      toast.success(t('preview.veto.done'))
      onChanged()
      onClose()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('preview.veto.title')}</DialogTitle>
          <DialogDescription>{t('preview.vetoHint')}</DialogDescription>
        </DialogHeader>
        <p className="text-muted-foreground text-xs tabular-nums">{label}</p>
        <Textarea
          autoFocus
          rows={4}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={t('preview.veto.placeholder')}
          aria-label={t('preview.veto.placeholder')}
        />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {/* 没填理由就不许按下：静默的否决与一版凭空消失长得一模一样。 */}
          <Button variant="outline" disabled={busy || trimmed === ''} onClick={() => void submit()}>
            {busy && <LoaderCircleIcon data-slot="icon" className="animate-spin" />}
            {t('preview.veto.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
