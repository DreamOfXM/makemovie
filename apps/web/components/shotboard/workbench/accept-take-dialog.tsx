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

interface AcceptTakeDialogProps {
  /** 被裁决的那一次生成任务——只有生成产物有任务行，延长/定向编辑与本机产物没有。 */
  taskId: string
  /** 弹窗里点名收的是哪一版（#8 视频片段 v3 · 4.0s）：不点名，「收下」就落在人记住的那一版上。 */
  label: string
  onClose(): void
  /** 与选版同一刷新链：收下后任务转成功，候选行/钦定钮/队列计数全部回读。 */
  onChanged(): void
}

/**
 * 「收下这版」的落点（SD-120）。后端把这次收下做成真动作：任务判成功、下游放行。
 * 理由选填——收下这个动作本身就是裁决，理由只是让人事后多一条线索，不该挡住决定。
 */
export function AcceptTakeDialog({ taskId, label, onClose, onChanged }: AcceptTakeDialogProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    try {
      await api(`/generations/tasks/${taskId}/review`, {
        method: 'POST',
        body: JSON.stringify({ action: 'waive', reason: reason.trim() }),
      })
      toast.success(t('generations.review.waived'))
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
          <DialogTitle>{t('generations.review.waiveTitle')}</DialogTitle>
          <DialogDescription>{t('generations.review.waiveHint')}</DialogDescription>
        </DialogHeader>
        <p className="text-muted-foreground text-xs tabular-nums">{label}</p>
        <Textarea
          autoFocus
          rows={4}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={t('generations.review.waivePlaceholder')}
          aria-label={t('generations.review.waivePlaceholder')}
        />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void submit()}>
            {busy && <LoaderCircleIcon data-slot="icon" className="animate-spin" />}
            {t('generations.review.waiveConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
