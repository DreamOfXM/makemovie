'use client'

import { useCallback, useEffect, useState } from 'react'
import { LockIcon, LockOpenIcon, Settings2Icon } from 'lucide-react'
import { toast } from 'sonner'
import { fetchCreativeControls, getToken, patchCreativeControls, patchSelectionLocks, type ShotControls } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/api-error'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/**
 * US-017 镜头结构化控制面板:景别/机位/运动枚举下拉,情绪/动作/负面约束自由文本;
 * 三个锁定开关(视频选版/配音选版/参考版本)。CAS 保存——冲突时提示刷新。
 * 全部字段 null=自动(不注入 prompt)。
 */
const ENUMS = {
  framing: [
    { value: 'close_up', label: '特写' }, { value: 'medium', label: '中景' },
    { value: 'wide', label: '远全景' }, { value: 'extreme_close_up', label: '大特写' },
  ],
  cameraAngle: [
    { value: 'eye_level', label: '平视' }, { value: 'low', label: '低角度仰拍' },
    { value: 'high', label: '高角度俯拍' }, { value: 'dutch', label: '倾斜' },
    { value: 'over_shoulder', label: '过肩' },
  ],
  cameraMovement: [
    { value: 'static', label: '固定机位' }, { value: 'pan', label: '横摇' },
    { value: 'tilt', label: '纵摇' }, { value: 'dolly', label: '推拉' },
    { value: 'handheld', label: '手持' },
  ],
} as const

const TEXT_FIELDS = [
  { key: 'mood', labelKey: 'ctrl.mood' },
  { key: 'negativePrompt', labelKey: 'ctrl.negative' },
] as const

export function ShotControlPanel({ storyboardId }: { storyboardId: string }) {
  const { t } = useI18n()
  const [controls, setControls] = useState<ShotControls | null>(null)
  const [revision, setRevision] = useState(0)
  const [locks, setLocks] = useState({ video: false, voice: false, references: false })
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await fetchCreativeControls(getToken(), storyboardId)
      setControls(data.controls)
      setRevision(data.stateRevision)
      setDirty(false)
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    }
  }, [storyboardId, t])

  useEffect(() => { void load() }, [load])

  async function save() {
    if (!controls || !dirty) return
    setSaving(true)
    try {
      const data = await patchCreativeControls(getToken(), storyboardId, { ...controls, expectedStateRevision: revision })
      setRevision(data.stateRevision)
      setControls(data.controls)
      setDirty(false)
      toast.success(t('ctrl.saved'))
    } catch (error) {
      if (error instanceof Error && error.message.includes('409')) {
        toast.error(t('ctrl.conflict'))
        await load()
      } else {
        toast.error(apiErrorMessage(error, t))
      }
    } finally {
      setSaving(false)
    }
  }

  async function toggleLock(field: 'lockedVideoSelection' | 'lockedVoiceSelection' | 'lockedReferences') {
    try {
      const result = await patchSelectionLocks(getToken(), storyboardId, { [field]: !(field === 'lockedVideoSelection' ? locks.video : field === 'lockedVoiceSelection' ? locks.voice : locks.references), expectedStateRevision: revision })
      setRevision(result.stateRevision)
      setLocks({ video: result.lockedVideoSelection, voice: result.lockedVoiceSelection, references: result.lockedReferences })
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    }
  }

  if (controls === null) return null

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground flex items-center gap-1 text-xs font-medium">
          <Settings2Icon className="size-3.5" />
          {t('ctrl.title')}
        </span>
        {dirty && (
          <Button size="sm" variant="outline" disabled={saving} onClick={() => void save()}>
            {t('ctrl.save')}
          </Button>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {(Object.keys(ENUMS) as Array<keyof typeof ENUMS>).map(field => (
          <div key={field} className="space-y-1">
            <Label className="text-xs">{t(`ctrl.${field}`)}</Label>
            <Select
              value={controls[field] ?? '__auto__'}
              onValueChange={value => { setControls({ ...controls, [field]: value === '__auto__' ? null : value }); setDirty(true) }}
            >
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__auto__" className="text-xs">{t('ctrl.auto')}</SelectItem>
                {ENUMS[field].map(option => (
                  <SelectItem key={option.value} value={option.value} className="text-xs">{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {TEXT_FIELDS.map(({ key, labelKey }) => (
          <div key={key} className="space-y-1">
            <Label className="text-xs">{t(labelKey)}</Label>
            <Input
              className="h-8 text-xs"
              value={controls[key] ?? ''}
              placeholder={t('ctrl.auto')}
              onChange={event => { setControls({ ...controls, [key]: event.target.value.trim() === '' ? null : event.target.value }); setDirty(true) }}
            />
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 border-t pt-2">
        <span className="text-muted-foreground text-xs">{t('ctrl.locks')}</span>
        {([['video', 'lockedVideoSelection', locks.video], ['voice', 'lockedVoiceSelection', locks.voice], ['references', 'lockedReferences', locks.references]] as const).map(([key, field, locked]) => (
          <Badge
            key={key}
            variant={locked ? 'default' : 'outline'}
            className="cursor-pointer select-none"
            onClick={() => void toggleLock(field)}
          >
            {locked ? <LockIcon className="mr-1 size-3" /> : <LockOpenIcon className="mr-1 size-3" />}
            {t(`ctrl.lock_${key}`)}
          </Badge>
        ))}
      </div>
    </div>
  )
}
