'use client'

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

export type Locale = 'en' | 'zh'

const dictionaries: Record<Locale, Record<string, string>> = {
  en: {
    'app.title': 'Short Drama Studio',
    'app.tagline': 'AI short-drama production workspace',
    'nav.projects': 'Projects',
    'nav.models': 'Model Center',
    'nav.members': 'Members',
    'locale.label': 'Language',
    'auth.email': 'Email',
    'auth.password': 'Password',
    'auth.orgName': 'Organization name',
    'auth.register': 'Create workspace',
    'auth.login': 'Sign in',
    'auth.toLogin': 'Have an account? Sign in',
    'auth.toRegister': 'New here? Create a workspace',
    'auth.logout': 'Sign out',
    'auth.org': 'Organization',
    'auth.role': 'Your role',
    'common.actions': 'Actions',
    'common.cancel': 'Cancel',
    'common.close': 'Close',
    'common.create': 'Create',
    'common.delete': 'Delete',
    'common.enabled': 'Enabled',
    'common.disabled': 'Disabled',
    'common.name': 'Name',
    'common.none': 'None',
    'common.refresh': 'Refresh',
    'common.save': 'Save',
    'common.status': 'Status',
    'projects.title': 'Projects',
    'projects.new': 'New project',
    'projects.namePlaceholder': 'Project name',
    'projects.selectHint': 'Select a project to see episodes',
    'projects.episodes': 'Episodes',
    'projects.newEpisode': 'New episode',
    'projects.episodeTitlePlaceholder': 'Episode title',
    'models.subtitle': 'Configure provider connections, verify model entitlements, and bind the right model to each capability slot.',
    'models.catalogs': 'Provider catalogs',
    'models.catalogVersion': 'Catalog version',
    'models.catalogModels': 'Models',
    'models.connections': 'Provider connections',
    'models.noConnections': 'No connections yet. Add one to start configuring models.',
    'models.newConnection': 'New connection',
    'models.provider': 'Provider',
    'models.apiKey': 'API key',
    'models.baseUrl': 'Base URL (optional)',
    'models.capabilities': 'Capabilities',
    'models.model': 'Model',
    'models.modality': 'Modality',
    'models.probeStatus': 'Probe',
    'models.probe': 'Probe entitlements',
    'models.probing': 'Probing…',
    'models.lastProbed': 'Last probed',
    'models.neverProbed': 'never',
    'models.deleteConfirm': 'Delete this connection?',
    'models.bindings': 'Capability slot bindings',
    'models.bindingsHint': 'Bind verified models to the slots used by the production pipeline. Project bindings override organization bindings.',
    'models.slot': 'Slot',
    'models.scope': 'Scope',
    'models.scopeOrg': 'Organization',
    'models.project': 'Project',
    'models.priority': 'Priority',
    'models.bind': 'Bind',
    'models.unbind': 'Unbind',
    'models.currentBindings': 'Current bindings',
    'models.noBindings': 'No bindings for this slot yet.',
    'models.resolve': 'Resolve candidates',
    'models.resolved': 'Ordered fallback candidates',
    'models.noCandidates': 'No verified, enabled candidates resolve for this slot.',
    'models.capability': 'Model capability',
    'models.noVerifiedCapability': 'No verified capabilities available. Probe a connection first.',
    'probe.verified': 'verified',
    'probe.failed': 'failed',
    'probe.unverified': 'unverified',
    'slots.script_text': 'Script writing (text)',
    'slots.storyboard_text': 'Storyboard writing (text)',
    'slots.image_gen': 'Image generation',
    'slots.video_t2v': 'Video · text-to-video',
    'slots.video_i2v': 'Video · image-to-video',
    'slots.video_r2v': 'Video · reference-to-video',
    'slots.tts_voice': 'Voice / TTS',
    'slots.music_gen': 'Music generation',
    'slots.visual_audit': 'Visual audit (VLM)',
    'members.title': 'Members',
    'members.email': 'Email',
    'members.role': 'Role',
    'members.add': 'Add member',
    'members.addHint': 'The user must register first; then add them by email.',
    'members.remove': 'Remove',
    'members.you': 'you',
    'members.removeConfirm': 'Remove this member?',
    'error.generic': 'Request failed',
  },
  zh: {
    'app.title': '短剧工作室',
    'app.tagline': 'AI 短剧生产工作台',
    'nav.projects': '项目',
    'nav.models': '模型中心',
    'nav.members': '成员',
    'locale.label': '语言',
    'auth.email': '邮箱',
    'auth.password': '密码',
    'auth.orgName': '组织名称',
    'auth.register': '创建工作台',
    'auth.login': '登录',
    'auth.toLogin': '已有账号？去登录',
    'auth.toRegister': '第一次使用？创建工作台',
    'auth.logout': '退出登录',
    'auth.org': '组织',
    'auth.role': '我的角色',
    'common.actions': '操作',
    'common.cancel': '取消',
    'common.close': '关闭',
    'common.create': '创建',
    'common.delete': '删除',
    'common.enabled': '已启用',
    'common.disabled': '已停用',
    'common.name': '名称',
    'common.none': '无',
    'common.refresh': '刷新',
    'common.save': '保存',
    'common.status': '状态',
    'projects.title': '项目',
    'projects.new': '新建项目',
    'projects.namePlaceholder': '项目名称',
    'projects.selectHint': '选择一个项目以查看剧集',
    'projects.episodes': '剧集',
    'projects.newEpisode': '新建剧集',
    'projects.episodeTitlePlaceholder': '剧集标题',
    'models.subtitle': '配置 Provider 连接、验证模型可用性，并把合适的模型绑定到每个能力槽位。',
    'models.catalogs': 'Provider 目录',
    'models.catalogVersion': '目录版本',
    'models.catalogModels': '模型',
    'models.connections': 'Provider 连接',
    'models.noConnections': '还没有连接。新建一个连接开始配置模型。',
    'models.newConnection': '新建连接',
    'models.provider': 'Provider',
    'models.apiKey': 'API 密钥',
    'models.baseUrl': 'Base URL（可选）',
    'models.capabilities': '能力列表',
    'models.model': '模型',
    'models.modality': '模态',
    'models.probeStatus': '探测',
    'models.probe': '探测可用性',
    'models.probing': '探测中…',
    'models.lastProbed': '最近探测',
    'models.neverProbed': '从未',
    'models.deleteConfirm': '确定删除该连接？',
    'models.bindings': '能力槽位绑定',
    'models.bindingsHint': '把已验证的模型绑定到生产管线使用的槽位。项目级绑定优先于组织级绑定。',
    'models.slot': '槽位',
    'models.scope': '作用域',
    'models.scopeOrg': '组织',
    'models.project': '项目',
    'models.priority': '优先级',
    'models.bind': '绑定',
    'models.unbind': '解绑',
    'models.currentBindings': '当前绑定',
    'models.noBindings': '该槽位还没有绑定。',
    'models.resolve': '解析候选',
    'models.resolved': '有序回退候选',
    'models.noCandidates': '该槽位没有已验证且启用的候选模型。',
    'models.capability': '模型能力',
    'models.noVerifiedCapability': '没有已验证的能力。请先对连接执行探测。',
    'probe.verified': '已验证',
    'probe.failed': '失败',
    'probe.unverified': '未验证',
    'slots.script_text': '剧本写作（文本）',
    'slots.storyboard_text': '分镜写作（文本）',
    'slots.image_gen': '图片生成',
    'slots.video_t2v': '视频 · 文生视频',
    'slots.video_i2v': '视频 · 图生视频',
    'slots.video_r2v': '视频 · 参考生视频',
    'slots.tts_voice': '语音 / TTS',
    'slots.music_gen': '音乐生成',
    'slots.visual_audit': '视觉审核（VLM）',
    'members.title': '成员',
    'members.email': '邮箱',
    'members.role': '角色',
    'members.add': '添加成员',
    'members.addHint': '对方需要先注册账号，再通过邮箱添加。',
    'members.remove': '移除',
    'members.you': '我',
    'members.removeConfirm': '确定移除该成员？',
    'error.generic': '请求失败',
  },
}

export type TranslateFn = (key: string) => string

interface I18nContextValue {
  locale: Locale
  setLocale(locale: Locale): void
  t: TranslateFn
}

const I18nContext = createContext<I18nContextValue | null>(null)

const STORAGE_KEY = 'studio-locale'

function initialLocale(): Locale {
  if (typeof window === 'undefined') return 'en'
  const saved = window.localStorage.getItem(STORAGE_KEY)
  if (saved === 'en' || saved === 'zh') return saved
  return window.navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en')

  useEffect(() => {
    setLocaleState(initialLocale())
  }, [])

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    window.localStorage.setItem(STORAGE_KEY, next)
  }, [])

  const t = useCallback<TranslateFn>(key => dictionaries[locale][key] ?? dictionaries.en[key] ?? key, [locale])

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext)
  if (!context) throw new Error('useI18n must be used inside I18nProvider')
  return context
}

export function LocaleSwitcher() {
  const { locale, setLocale, t } = useI18n()
  return (
    <label className="locale-switcher">
      <span className="visually-hidden">{t('locale.label')}</span>
      <select value={locale} onChange={event => setLocale(event.target.value as Locale)}>
        <option value="en">English</option>
        <option value="zh">中文</option>
      </select>
    </label>
  )
}
