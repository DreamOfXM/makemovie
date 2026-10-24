'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { LoaderCircleIcon, NotebookPenIcon, SparklesIcon } from 'lucide-react'
import { toast } from 'sonner'
import { contentLocales, type ContentLocale } from '@studio/domain'
import {
  createProjectFromStory, getToken, listRecipes, listStoryDrafts, request, saveStoryDraft,
  type RecipeInfo, type StoryDraft,
} from '@/lib/api'
import { translateEnum, useI18n } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/api-error'
import { useSession } from '@/lib/session'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { HelpHint } from '@/components/ui/help-hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'

/**
 * US-007 新建作品:故事 → 配方/画幅/风格 → 建项。输入即时进草稿(自动保存),
 * 刷新/断网回来原样恢复;建项走 US-006 幂等服务,失败时输入仍在。原项目页的
 * 快捷新建弹窗保留——两条入口并存,这个页面承载长表单。
 */
export default function NewProjectPage() {
  const { t } = useI18n()
  const router = useRouter()
  const { api } = useSession()
  const [recipes, setRecipes] = useState<RecipeInfo[] | null>(null)
  const [draftId, setDraftId] = useState<string | null>(null)
  const [restored, setRestored] = useState<StoryDraft | null>(null)
  const [title, setTitle] = useState('')
  const [storyText, setStoryText] = useState('')
  const [recipeKey, setRecipeKey] = useState<string>('drama-serial')
  const [format, setFormat] = useState<string>('short_drama')
  const [contentLocale, setContentLocale] = useState<ContentLocale>('zh')
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const dirty = useRef(false)
  const localeTouched = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 空间默认语言只作预填：用户改过或草稿自带语言后，这条响应不再覆盖。
  useEffect(() => {
    void api<{ defaultContentLocale?: string | null }>('/organization')
      .then(org => {
        if (!localeTouched.current) setContentLocale(org.defaultContentLocale === 'en' ? 'en' : 'zh')
      })
      .catch(() => undefined)
  }, [api])

  useEffect(() => {
    const token = getToken()
    void listRecipes(token).then(setRecipes).catch(() => setRecipes([]))
    // 恢复最近一份未消费草稿——「继续创作」而不是从零开始。
    void listStoryDrafts(token)
      .then(async drafts => {
        const open = drafts.find(draft => draft.consumedProjectId === null)
        if (open) {
          const detailResponse = await request<{ draft: StoryDraft }>(`/story-drafts/${open.id}`, { token }).catch(() => null)
          const detail = detailResponse?.draft ?? null
          setRestored(detail ?? ({ id: open.id, title: open.title, storyText: '', recipeKey: open.recipeKey, styleId: null, contentLocale: null, targetDurationMs: null, consumedProjectId: null, updatedAt: open.updatedAt } as StoryDraft))
        }
      })
      .catch(() => undefined)
  }, [])

  const adoptRestored = useCallback(() => {
    if (!restored) return
    setDraftId(restored.id)
    if (restored.title) setTitle(restored.title)
    if (restored.recipeKey) setRecipeKey(restored.recipeKey)
    if (restored.storyText) setStoryText(restored.storyText)
    if (restored.contentLocale === 'zh' || restored.contentLocale === 'en') {
      localeTouched.current = true
      setContentLocale(restored.contentLocale)
    }
    setRestored(null)
  }, [restored])

  const persist = useCallback(async (values: { title: string; storyText: string; recipeKey: string; contentLocale: ContentLocale }) => {
    if (values.storyText.trim() === '') return
    setSaving(true)
    try {
      const draft = await saveStoryDraft(getToken(), { title: values.title || null, storyText: values.storyText, recipeKey: values.recipeKey, contentLocale: values.contentLocale }, draftId ?? undefined)
      setDraftId(draft.id)
      setSavedAt(new Date().toLocaleTimeString())
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setSaving(false)
    }
  }, [draftId, t])

  // 自动保存:输入停 1.5s 落一次草稿;正在建项时不再抢写。
  useEffect(() => {
    if (!dirty.current || creating) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void persist({ title, storyText, recipeKey, contentLocale }) }, 1500)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [title, storyText, recipeKey, contentLocale, persist, creating])

  async function create() {
    if (storyText.trim() === '') {
      toast.error(t('newStory.storyRequired'))
      return
    }
    setCreating(true)
    try {
      // 先把最后一版输入落进草稿,再消费——失败时输入在草稿里,不丢。
      const draft = await saveStoryDraft(getToken(), { title: title || null, storyText, recipeKey, contentLocale }, draftId ?? undefined)
      const result = await createProjectFromStory(getToken(), draft.id, format)
      dirty.current = false
      toast.success(result.idempotentReplay ? t('newStory.replayUsed') : t('newStory.created'))
      // P06 建项即进创作:故事建项的终点是首集的创作现场,不是项目管理页——
      // 用户刚写完故事,下一步是确认剧本,不是管理项目。重放路径同样带首集。
      router.push(result.firstEpisodeId
        ? `/projects/${result.project.id}/episodes/${result.firstEpisodeId}`
        : `/projects/${result.project.id}`)
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <NotebookPenIcon className="text-muted-foreground size-4" />
            {t('newStory.title')}
          </CardTitle>
          <CardDescription>{t('newStory.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {restored && (
            <div className="flex items-center justify-between rounded-md border border-warning/50 bg-warning/5 px-3 py-2 text-sm">
              <span>{t('newStory.hasDraft')}</span>
              <Button size="sm" variant="outline" onClick={adoptRestored}>{t('newStory.resumeDraft')}</Button>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="story">{t('newStory.storyLabel')}</Label>
            <Textarea
              id="story" rows={10} value={storyText}
              placeholder={t('newStory.storyPlaceholder')}
              onChange={event => { dirty.current = true; setStoryText(event.target.value) }}
            />
            <p className="text-muted-foreground text-xs">
              {saving ? t('newStory.saving') : savedAt ? t('newStory.savedAt', { time: savedAt }) : t('newStory.autosaveHint')}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="title">{t('newStory.titleLabel')}</Label>
              <Input id="title" value={title} placeholder={t('newStory.titlePlaceholder')} onChange={event => { dirty.current = true; setTitle(event.target.value) }} />
            </div>
            <div className="space-y-2">
              <Label>{t('newStory.recipeLabel')}</Label>
              {recipes === null ? <Skeleton className="h-9 w-full" /> : (
                <Select value={recipeKey} onValueChange={value => { dirty.current = true; setRecipeKey(value) }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {recipes.map(recipe => (
                      <SelectItem key={recipe.recipeKey} value={recipe.recipeKey}>
                        {recipe.spec.aspect} · {recipe.recipeKey === 'drama-serial' ? t('newStory.recipeSerial') : t('newStory.recipeShort')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>{t('newStory.formatLabel')}</Label>
              <Select value={format} onValueChange={setFormat}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="short_drama">{t('newStory.formatShortDrama')}</SelectItem>
                  <SelectItem value="series">{t('newStory.formatSeries')}</SelectItem>
                  <SelectItem value="film">{t('newStory.formatFilm')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-1">
                <Label>{t('projects.contentLanguageLabel')}</Label>
                <HelpHint text={t('projects.contentLanguageHint')} />
              </div>
              <Select
                value={contentLocale}
                onValueChange={value => {
                  localeTouched.current = true
                  dirty.current = true
                  setContentLocale(value as ContentLocale)
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {contentLocales.map(item => (
                    <SelectItem key={item} value={item}>
                      {translateEnum(t, 'projects.contentLocale', item)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-muted-foreground text-xs">{t('newStory.noModelCall')}</p>
            <Button onClick={() => void create()} disabled={creating || storyText.trim() === ''}>
              {creating ? <LoaderCircleIcon className="animate-spin" /> : <SparklesIcon />}
              {t('newStory.create')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
