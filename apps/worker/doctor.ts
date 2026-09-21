// 链路体检:只读,不改任何数据。跑一次就知道当前配置和数据能不能支撑
// "素材定妆 → 首帧 → 视频"的一致性链路,把配置漂移和静默断点在开跑前暴露。
// 用法:仓库根目录 pnpm doctor（自动读根 .env 的 DATABASE_URL）
import { readFileSync } from 'node:fs'
import { PrismaClient } from '@studio/db'
import { aigcBadgeCapability } from '@studio/media'
import { listCatalogs } from '@studio/providers'
import { usableFirstFrames } from '@studio/pipeline'

function rootEnvValue(key: string): string | undefined {
  try {
    const env = readFileSync(new URL('../../.env', import.meta.url), 'utf8')
    return new RegExp(`^${key}="?([^"\\n]+)"?`, 'm').exec(env)?.[1]
  } catch {
    return undefined
  }
}

function loadDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const match = rootEnvValue('DATABASE_URL')
  if (!match) throw new Error('DATABASE_URL not set and not found in root .env')
  return match
}

// The compliance check probes the ffmpeg that @studio/media would actually run,
// and that lookup reads process.env — fill it from the root .env like DATABASE_URL.
if (!process.env.STUDIO_FFMPEG_DIR) {
  const dir = rootEnvValue('STUDIO_FFMPEG_DIR')
  if (dir) process.env.STUDIO_FFMPEG_DIR = dir
}

const db = new PrismaClient({ datasources: { db: { url: loadDatabaseUrl() } } })

let failures = 0
let warnings = 0

function fail(message: string) {
  failures += 1
  process.stdout.write(`    ❌ ${message}\n`)
}

function warn(message: string) {
  warnings += 1
  process.stdout.write(`    ⚠️  ${message}\n`)
}

function ok(message: string) {
  process.stdout.write(`    ✅ ${message}\n`)
}

async function checkModelConfig(): Promise<void> {
  process.stdout.write('\n【模型配置】\n')
  const catalogs = listCatalogs()
  const capabilities = await db.modelCapability.findMany({
    include: { connection: true, bindings: { where: { enabled: true } } },
  })

  for (const capability of capabilities) {
    if (capability.bindings.length === 0) continue
    const slots = capability.bindings.map(binding => binding.slot).join(',')
    const verified = capability.entitlementVerifiedAt !== null || capability.credentialVerifiedAt !== null
    if (!verified) {
      fail(`${capability.model}（槽位 ${slots}）已绑定但从未探测成功——它不会被任何阶段选中,等于白绑。去模型配置里点探测。`)
    } else {
      ok(`${capability.model}（槽位 ${slots}）已验证`)
    }

    // 目录漂移:目录声明的能力与模型行不一致,就是 qwen-image-edit 参考图开关事故的形态。
    const catalog = catalogs
      .find(catalog => catalog.provider === capability.connection.provider)
      ?.models.find(model => model.model === capability.model)
    if (!catalog) continue
    if ((catalog.acceptsReferenceImages ?? false) && !capability.acceptsReferenceImages) {
      fail(`${capability.model} 目录声明支持参考图,但模型行开关是关的——绑定它画首帧时参考图会被静默丢弃。请在模型行打开参考图或删掉重加。`)
    }
    if ((catalog.maxReferenceImages ?? 0) > capability.maxReferenceImages) {
      warn(`${capability.model} 目录声明参考图上限 ${catalog.maxReferenceImages},模型行只配了 ${capability.maxReferenceImages}。`)
    }
  }

  for (const slot of ['VIDEO_I2V', 'IMAGE_GEN', 'SCRIPT_TEXT', 'STORYBOARD_TEXT', 'TTS_VOICE', 'MUSIC_GEN', 'VISUAL_AUDIT']) {
    const bound = capabilities.filter(capability => capability.bindings.some(binding => binding.slot === slot))
    if (bound.length === 0) {
      warn(`槽位 ${slot} 没有绑定任何模型——依赖它的阶段会被推进链跳过。`)
    }
  }
}

async function checkEpisode(episodeId: string, label: string): Promise<void> {
  process.stdout.write(`\n【${label}】\n`)
  const shots = await db.storyboard.findMany({
    where: { episodeId, supersededAt: null },
    orderBy: { number: 'asc' },
    select: { id: true, number: true, title: true, _count: { select: { assets: true } } },
  })
  if (shots.length === 0) {
    process.stdout.write('    （还没有分镜,跳过链路检查）\n')
    return
  }
  ok(`活镜头 ${shots.length} 个`)

  const zeroBound = shots.filter(shot => shot._count.assets === 0)
  if (zeroBound.length > 0) {
    warn(`镜头 ${zeroBound.map(shot => `#${shot.number}`).join('、')} 零素材绑定——这些镜头的首帧没有一致性锚点。手动点卡片上的素材标签绑定,或重新生成分镜让自动绑定补齐。`)
  } else {
    ok(`全部镜头都有素材绑定`)
  }

  // 被引用素材的档案健康:已审批 + 有已审批定妆照。缺后者 = 参考图静默缺失。
  const links = await db.storyboardAsset.findMany({
    where: { storyboard: { episodeId, supersededAt: null } },
    include: {
      asset: {
        include: { versions: { where: { status: 'APPROVED', artifactId: { not: null } }, select: { version: true } } },
      },
    },
  })
  const byAsset = new Map<number, { name: string; status: string; approvedArtifact: boolean; usedBy: Set<string> }>()
  for (const link of links) {
    const entry = byAsset.get(link.assetId) ?? {
      name: `${link.asset.kind}·${link.asset.name}`,
      status: link.asset.status,
      approvedArtifact: link.asset.versions.length > 0,
      usedBy: new Set<string>(),
    }
    entry.usedBy.add(`#${(link as unknown as { storyboard?: { number?: number } }).storyboard?.number ?? '?'}`)
    byAsset.set(link.assetId, entry)
  }
  let assetProblems = 0
  for (const [assetId, entry] of byAsset) {
    void assetId
    if (entry.status !== 'APPROVED') {
      fail(`素材 ${entry.name} 未审批（镜头 ${[...entry.usedBy].join(',')}）——首帧门禁会拒绝生成。`)
      assetProblems += 1
    } else if (!entry.approvedArtifact) {
      fail(`素材 ${entry.name} 已审批但没有已审批的定妆照版本——参考图会静默缺失,首帧退化为纯文生图。请重新生成定妆照并审批。`)
      assetProblems += 1
    }
  }
  if (assetProblems === 0) ok(`被引用素材 ${byAsset.size} 个,全部已审批且有定妆照`)

  // 首帧覆盖:视频门禁(绑定了图生视频时)要求每个镜头都有可用首帧。
  const episode = await db.episode.findUniqueOrThrow({
    where: { id: episodeId },
    select: { project: { select: { organizationId: true } } },
  })
  const frames = await usableFirstFrames(db, episode.project.organizationId, episodeId, shots.map(shot => shot.id))
  const missingFrames = shots.filter(shot => !frames.has(shot.id))
  if (missingFrames.length > 0) {
    warn(`${missingFrames.length}/${shots.length} 个镜头没有可用首帧（${missingFrames.map(shot => `#${shot.number}`).join('、')}）——生成视频会被门禁拦下。`)
  } else {
    ok(`全部镜头都有可用首帧`)
  }

  // 最近的失败:额度类错误值得单独点名,它意味着"配置是对的,钱没了"。
  const recentFailed = await db.generationTask.findMany({
    where: { batch: { episodeId }, status: 'FAILED' },
    orderBy: { createdAt: 'desc' },
    take: 3,
    select: { stage: true, model: true, errorSnapshot: true, createdAt: true },
  })
  for (const task of recentFailed) {
    const quota = task.errorSnapshot?.includes('FreeTierOnly') || task.errorSnapshot?.includes('quota')
    const headline = quota ? '额度耗尽' : (task.errorSnapshot ?? '').slice(0, 80)
    warn(`最近失败: ${task.stage} · ${task.model ?? '?'} · ${headline}`)
  }
}

// 合规能力:GB 45438-2025 要求成片带显式+隐式双标识。隐式是纯打包元数据,任何
// ffmpeg 都能写;显式角标要 drawtext(文字烧录)+ CJK 字体。缺任何一块,母带的
// 角标会被记为 skipped——这是红线级缺口,按必须修复报。
async function checkCompliance(): Promise<void> {
  process.stdout.write('\n【合规能力(GB 45438 双标识)】\n')
  try {
    const capability = await aigcBadgeCapability()
    if (!capability.drawtext) fail('ffmpeg 无 drawtext 滤镜:显式角标烧不上,母带只会带隐式元数据。可装完整构建(如 brew install ffmpeg-full)并把 STUDIO_FFMPEG_DIR 指向其 bin 目录')
    else if (!capability.fontFile) fail('ffmpeg 有 drawtext 但找不到 CJK 字体:设置 STUDIO_AIGC_LABEL_FONT_FILE 指向含中文字形的 .ttf/.ttc')
    else ok(`显式角标可烧录(drawtext + ${capability.fontFile})`)
  } catch (error) {
    fail(`ffmpeg 探测失败:${error instanceof Error ? error.message : String(error)}`)
  }
}

async function main() {
  process.stdout.write(`== 链路体检 ${new Date().toISOString()}\n`)
  const episodes = await db.episode.findMany({
    select: { id: true, title: true, number: true, project: { select: { name: true } } },
    orderBy: { id: 'asc' },
  })
  for (const episode of episodes) {
    await checkEpisode(episode.id, `${episode.project.name} / 第${episode.number}集 ${episode.title}`)
  }
  await checkModelConfig()
  await checkCompliance()
  process.stdout.write(`\n== 结果: ${failures} 个必须修复, ${warnings} 个提醒\n`)
  if (failures > 0) process.exitCode = 1
}

main()
  .catch(error => {
    process.stderr.write(`${error}\n`)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
