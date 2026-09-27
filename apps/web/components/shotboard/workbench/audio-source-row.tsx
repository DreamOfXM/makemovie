'use client'

import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { UploadIcon } from 'lucide-react'
import type { ShotAudioSource, ShotboardShot } from '@/lib/api'
import { audioModeWord, shotAudioMode, shotAudioSourceInEffect, shotOwesVoice, shotVoiceTrack } from '@/lib/shot-verdict'
import { useI18n } from '@/lib/i18n'
import { cn, formatDuration } from '@/lib/utils'
import { apiErrorMessage } from '@/lib/api-error'
import { useSession } from '@/lib/session'
import { Button } from '@/components/ui/button'
import { HelpHint } from '@/components/ui/help-hint'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePermission } from '@/components/permission'
import { AudioWaveform } from '../audio-waveform'

/** 声音来源的四档，按「这一档往成片里加多少东西」排，不按枚举字母序。 */
const AUDIO_MODES: ShotAudioSource[] = ['VOICE_NATIVE', 'VOICE', 'NATIVE', 'IMPORTED']

/**
 * 这一镜的声音来源。四档就是四种真相：选哪档，母带里就听到什么。
 * 从镜头详情弹窗原样搬进制作台右栏——控件与逻辑未动，只换了住处。
 */
export function AudioSourceRow({ shot, onChanged }: { shot: ShotboardShot; onChanged: () => void }) {
  const { t } = useI18n()
  const { api } = useSession()
  const { can } = usePermission()
  const [busy, setBusy] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const ambienceRef = useRef<HTMLInputElement>(null)
  const editable = can('storyboard:write')

  const mode = shotAudioMode(shot)
  // 亮哪一格看「生效值」，不看「有人点过没有」：没人钦定时镜型默认那一格也是在生效的，
  // 四格全灭等于让控件否认下面那行说的话。
  const effectiveSource = shotAudioSourceInEffect(shot)
  const imported = shot.importedVoice
  // 「配音」这一路必须有声音可放：本镜写的台词，或人导入的那条音频。两者都没有时
  // 含配音的三档都是空选择——后端同样拒，界面先把它按住。
  const canVoice = Boolean(shot.dialogue) || Boolean(imported)
  const track = shotVoiceTrack(shot)
  // 画面的长度优先用实测的成片时长；还没有片段可探时才退回分镜里写的计划时长，
  // 那种情况下读数要标成「约」，不能拿计划值冒充量出来的数。
  const pictureMs = shot.video?.durationMs ?? shot.durationMs
  const pictureLabel = shot.video?.durationMs
    ? formatDuration(pictureMs)
    : t('shotboard.audio.approx', { value: formatDuration(pictureMs) })
  const audioMs = imported?.durationMs ?? null
  const lengthNote = audioMs && Math.abs(audioMs - pictureMs) > 200
    ? t(audioMs < pictureMs ? 'shotboard.audio.shorter' : 'shotboard.audio.longer', {
      audio: formatDuration(audioMs),
      picture: pictureLabel,
      gap: formatDuration(Math.abs(audioMs - pictureMs)),
    })
    : null
  const ambience = shot.importedAmbience ?? null
  const ambienceMs = ambience?.durationMs ?? null
  // 环境音在混音时被切到这一镜的画面长度（apad + atrim），不会像配音那样压到下一镜，
  // 所以这两条话与上面那两条不同：短了是尾巴空，长了是末尾被切掉。
  const ambienceNote = ambienceMs && Math.abs(ambienceMs - pictureMs) > 200
    ? t(ambienceMs < pictureMs ? 'shotboard.audio.ambienceShorter' : 'shotboard.audio.ambienceLonger', {
      audio: formatDuration(ambienceMs),
      picture: pictureLabel,
      gap: formatDuration(Math.abs(ambienceMs - pictureMs)),
    })
    : null
  // 这一档本来要放模型原声，但导进来的环境音占的就是那一格——原声已经不播了，
  // 界面必须说出来，否则「配音 + 原声」那枚药丸在骗人。
  const ambienceReplacesNative = Boolean(ambience) && (mode === 'native' || mode === 'voice_native')
  const customSubtitle = shot.subtitleText !== null
  const subtitleNote = mode !== 'imported' || customSubtitle
    ? null
    : shot.dialogue === ''
      ? t('shotboard.audio.subtitleNone')
      : t('shotboard.audio.subtitleUnverified')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  async function pick(next: ShotAudioSource | null) {
    setBusy(next ?? 'clear')
    try {
      await api(`/storyboards/${shot.id}/audio-source`, { method: 'POST', body: JSON.stringify({ audioSource: next }) })
      toast.success(t('shotboard.audio.setToast'))
      onChanged()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setBusy(null)
    }
  }

  async function upload(file: File, role: 'voice' | 'ambience') {
    setBusy(role === 'voice' ? 'import' : 'import-ambience')
    const body = new FormData()
    body.append('file', file)
    try {
      await api(`/storyboards/${shot.id}/${role}-import`, { method: 'POST', body })
      toast.success(t(role === 'voice' ? 'shotboard.audio.importToast' : 'shotboard.audio.ambienceToast'))
      onChanged()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setBusy(null)
    }
  }

  async function removeImport(role: 'voice' | 'ambience') {
    setBusy(`remove-${role}`)
    try {
      await api(`/storyboards/${shot.id}/${role}-import`, { method: 'DELETE' })
      toast.success(t(role === 'voice' ? 'shotboard.audio.removeToast' : 'shotboard.audio.ambienceRemoveToast'))
      onChanged()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setBusy(null)
    }
  }

  // 字幕文本只有合成前改才有效：字幕是硬烧的，成片一旦交付那行字就焊死在画面里。
  async function saveSubtitle(text: string | null) {
    setBusy('subtitle')
    try {
      await api(`/storyboards/${shot.id}/subtitle`, { method: 'POST', body: JSON.stringify({ subtitleText: text }) })
      toast.success(t('shotboard.audio.subtitleSaved'))
      setEditing(false)
      onChanged()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="border-border/60 rounded-md border px-3 py-2">
      <div className="mb-2 flex items-center gap-1.5">
        <p className="text-muted-foreground text-xs">{t('shotboard.audio.title')}</p>
        <HelpHint text={t('shotboard.audio.hint')} />
        {editable && shot.audioSource !== null && (
          <Button variant="ghost" size="sm" className="ml-auto h-6 text-xs" disabled={busy !== null} onClick={() => void pick(null)}>
            {t('shotboard.audio.restoreDefault')}
          </Button>
        )}
      </div>

      {/* 一格一形状：整排是一条分段控件（muted 轨道 + 生效格实心），不是四个各说各话的按钮。
          「导入音频」在还没有文件时是动作而不是档位，所以它不带描边——之前它比选中态还抢眼。 */}
      <div
        role="group"
        aria-label={t('shotboard.audio.title')}
        className="border-border/70 bg-muted/40 inline-flex flex-wrap items-center gap-0.5 rounded-lg border p-0.5"
      >
        {AUDIO_MODES.map(item => {
          const picked = shot.audioSource === item
          const byDefault = shot.audioSource === null && effectiveSource === item
          const blocked = (item === 'VOICE' || item === 'VOICE_NATIVE') && !canVoice
          // 还没导入文件时，这一档不是「选它」而是「去选文件」——点击直接开选择框，
          // 传完自动落到这一档，不再逼人补点一次。
          if (item === 'IMPORTED' && !imported) {
            return (
              <Tooltip key={item}>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 rounded-md px-2.5 text-xs font-normal text-muted-foreground whitespace-nowrap hover:text-foreground"
                    disabled={!editable || busy !== null}
                    onClick={() => fileRef.current?.click()}
                  >
                    <UploadIcon className="size-3.5" />
                    {t(`shotboard.audio.${item}`)}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('shotboard.audio.pickHint')}</TooltipContent>
              </Tooltip>
            )
          }
          const modeButton = (
            <Button
              key={item}
              variant="ghost"
              size="sm"
              aria-pressed={picked || byDefault}
              className={cn(
                'h-7 rounded-md border px-2.5 text-xs font-medium whitespace-nowrap transition-colors',
                picked && 'border-primary/70 bg-primary/15 text-foreground',
                byDefault && 'border-dashed border-primary/55 text-foreground/85',
                !picked && !byDefault && 'border-transparent text-muted-foreground hover:text-foreground',
              )}
              disabled={!editable || busy !== null || blocked}
              onClick={() => void pick(item)}
            >
              {t(`shotboard.audio.${item}`)}
            </Button>
          )
          const blockHint = editable && blocked ? t('shotboard.audio.noDialogueHint') : null
          if (!blockHint) return modeButton
          return (
            <Tooltip key={item}>
              {/* 禁用按钮自身不触发 hover，提示必须挂在它外面这层 span 上才弹得出来 */}
              <TooltipTrigger asChild>
                <span className="inline-flex">{modeButton}</span>
              </TooltipTrigger>
              <TooltipContent>{blockHint}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void upload(file, 'voice')
        }}
      />
      <input
        ref={ambienceRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void upload(file, 'ambience')
        }}
      />

      {shot.audioSource === null && (
        <p className="text-faint-foreground mt-2 text-[11px]">{t('shotboard.audio.defaultLine', { mode: audioModeWord(t, mode) })}</p>
      )}

      {imported && (
        <div className="border-border/60 mt-2 rounded-md border px-3 py-2">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
              {t('shotboard.audio.file')}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-foreground ml-1.5 font-mono">
                    {imported.filename ?? imported.objectKey.split('/').pop()}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="break-all">{imported.filename ?? imported.objectKey}</TooltipContent>
              </Tooltip>
            </span>
            {editable && (
              <span className="flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="sm" className="h-6 text-xs" disabled={busy !== null} onClick={() => fileRef.current?.click()}>
                  {t('shotboard.audio.replace')}
                </Button>
                <Button variant="ghost" size="sm" className="h-6 text-xs" disabled={busy !== null} onClick={() => void removeImport('voice')}>
                  {t('shotboard.audio.remove')}
                </Button>
              </span>
            )}
          </div>
          <AudioWaveform artifact={imported} pictureMs={pictureMs} />

          {mode === 'imported' && lengthNote && (
            <p className="border-warning/40 bg-warning/10 text-warning-ink mt-2 rounded-md border px-2.5 py-1.5 text-[11px] leading-relaxed">
              {lengthNote}
            </p>
          )}
          {mode === 'imported' && subtitleNote && (
            <p className="border-warning/40 bg-warning/10 text-warning-ink mt-1.5 rounded-md border px-2.5 py-1.5 text-[11px] leading-relaxed">
              {subtitleNote}
            </p>
          )}
        </div>
      )}

      {/* 环境音与声音来源正交：来源决定人声从哪来，这一条决定配音底下垫什么。
          它给的是「配音 + 环境音」这条路——不必赌模型原声里有没有它自己念的词。 */}
      <div className="mt-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="text-muted-foreground text-xs">{t('shotboard.audio.ambience')}</p>
          <HelpHint text={t('shotboard.audio.ambienceHint')} />
          {editable && !ambience && (
            <Button variant="outline" size="sm" className="ml-auto h-7 text-xs" disabled={busy !== null} onClick={() => ambienceRef.current?.click()}>
              {t('shotboard.audio.ambienceImport')}
            </Button>
          )}
        </div>
        {ambience ? (
          <div className="border-border/60 mt-1.5 rounded-md border px-3 py-2">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-foreground font-mono">
                      {ambience.filename ?? ambience.objectKey.split('/').pop()}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="break-all">{ambience.filename ?? ambience.objectKey}</TooltipContent>
                </Tooltip>
              </span>
              {editable && (
                <span className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="sm" className="h-6 text-xs" disabled={busy !== null} onClick={() => ambienceRef.current?.click()}>
                    {t('shotboard.audio.replace')}
                  </Button>
                  <Button variant="ghost" size="sm" className="h-6 text-xs" disabled={busy !== null} onClick={() => void removeImport('ambience')}>
                    {t('shotboard.audio.remove')}
                  </Button>
                </span>
              )}
            </div>
            <AudioWaveform artifact={ambience} pictureMs={pictureMs} />

            {ambienceNote && (
              <p className="border-warning/40 bg-warning/10 text-warning-ink mt-2 rounded-md border px-2.5 py-1.5 text-[11px] leading-relaxed">
                {ambienceNote}
              </p>
            )}
            {ambienceReplacesNative && (
              <p className="text-faint-foreground mt-1.5 text-[11px] leading-relaxed">
                {t('shotboard.audio.ambienceReplacesNative', { mode: audioModeWord(t, mode) })}
              </p>
            )}
          </div>
        ) : (
          <p className="text-faint-foreground mt-1 text-[11px] leading-relaxed">{t('shotboard.audio.ambienceEmpty', { mode: audioModeWord(t, mode) })}</p>
        )}
      </div>

      {(imported || shot.subtitleText !== null) && (
        <div className="mt-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-muted-foreground text-xs">{t('shotboard.audio.subtitle')}</p>
            <HelpHint text={t('shotboard.audio.subtitleHint')} />
            <div role="group" aria-label={t('shotboard.audio.subtitle')} className="ml-auto flex items-center gap-1">
              <Button
                variant={customSubtitle ? 'ghost' : 'secondary'}
                size="sm"
                aria-pressed={!customSubtitle}
                className={cn('h-7 text-xs', !customSubtitle && 'text-foreground font-medium')}
                disabled={!editable || busy !== null}
                // 已经是「沿用台词」时再点一次不该发请求，也不该因此把选中的那枚
                // 灰成 disabled 的样子——灰了以后它比右边可点的「改为本镜」更弱，
                // 选中态反而看不出来。
                onClick={() => {
                  if (customSubtitle) void saveSubtitle(null)
                }}
              >
                {t('shotboard.audio.subtitleDialogue')}
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={customSubtitle ? 'secondary' : 'ghost'}
                    size="sm"
                    aria-pressed={customSubtitle}
                    className={cn('h-7 text-xs', customSubtitle && 'text-foreground font-medium')}
                    disabled={!editable || busy !== null}
                    onClick={() => {
                      setDraft(shot.subtitleText ?? shot.dialogue)
                      setEditing(true)
                    }}
                  >
                    {t('shotboard.audio.subtitleCustom')}
                  </Button>
                </TooltipTrigger>
                {/* 没改之前这一格实际吃的是台词，只有提示能说明白；原生 title 看不见 */}
                {!customSubtitle && <TooltipContent>{t('shotboard.audio.subtitleFromDialogue')}</TooltipContent>}
              </Tooltip>
            </div>
          </div>

          {(editing || customSubtitle) && (
            <div className="mt-1.5 space-y-1.5">
              <textarea
                value={draft}
                rows={2}
                disabled={!editable || busy !== null}
                placeholder={t('shotboard.audio.subtitlePlaceholder')}
                aria-label={t('shotboard.audio.subtitle')}
                onChange={event => setDraft(event.target.value)}
                className="border-input bg-background focus-visible:ring-ring w-full resize-y rounded-md border px-2 py-1.5 text-sm"
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  disabled={!editable || busy !== null || draft.trim() === (shot.subtitleText ?? '').trim()}
                  onClick={() => void saveSubtitle(draft)}
                >
                  {t('shotboard.audio.subtitleSave')}
                </Button>
                {editing && !customSubtitle && (
                  <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={busy !== null} onClick={() => setEditing(false)}>
                    {t('common.cancel')}
                  </Button>
                )}
                <span className="text-faint-foreground text-[11px]">{t('shotboard.audio.subtitleNeedsCompose')}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {shotOwesVoice(shot) && !track && <p className="text-warning-ink mt-2 text-[11px]">{t('shotboard.audio.waitingVoice')}</p>}

      {track && track.id !== imported?.id && (
        <div className="mt-2">
          <p className="text-muted-foreground mb-1 text-xs">{t('shotboard.voiceRow')}</p>
          <AudioWaveform artifact={track} pictureMs={pictureMs} />
        </div>
      )}
    </div>
  )
}
