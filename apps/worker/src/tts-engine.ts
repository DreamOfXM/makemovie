import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 内嵌语音引擎（r10 音频体系·路径 2）：MakeMovie 自己的 Qwen3-TTS MLX 推理。
 *
 * 组成（都在引擎目录下，默认 <repo>/var/tts-engine，可用 STUDIO_TTS_ENGINE_DIR 覆盖）：
 *   venv/         Python 3.12 + mlx-audio（安装流程建）
 *   hf/           模型的隔离 HF 缓存（安装流程下载 8bit 量化版 ~2.4GB）
 *   model.ready   安装完成标记（内容=模型快照的绝对路径；mlx_audio 见本地路径直连，不碰 hub）
 *
 * sidecar 进程：engine/qwen3_tts_server.py，spawn 时读它 stdout 的
 * MAKEMOVIE_TTS_PORT=<port> 行拿端口；模型常驻内存，单句推理秒级。
 */

const DEFAULT_MODEL_ID = 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit'

const workerDir = path.dirname(fileURLToPath(import.meta.url))
// tsx 开发态 import.meta.url 在 src/，编译后在 dist/——engine 目录始终是
// apps/worker/engine，两处候选都探测，别让路径推断决定能不能出声。
function resolveServerScript(): string {
  const candidates = [path.join(workerDir, 'engine'), path.join(workerDir, '..', 'engine')]
  for (const dir of candidates) {
    const script = path.join(dir, 'qwen3_tts_server.py')
    if (existsSync(script)) return script
  }
  return path.join(workerDir, 'engine', 'qwen3_tts_server.py')
}
const serverScript = resolveServerScript()

export interface EmbeddedEngineStatus {
  venvReady: boolean
  modelReady: boolean
  /** model.ready 的内容：本地快照的绝对路径（mlx_audio 拿到路径会直连本地，不碰 hub）。 */
  modelPath: string | null
}

export function engineDir(): string {
  return process.env.STUDIO_TTS_ENGINE_DIR || path.resolve(workerDir, '../../..', 'var', 'tts-engine')
}

/** 从快照路径还原可读的模型标签（metadata/日志用）。 */
export function modelLabel(modelPath: string | null): string {
  if (!modelPath) return 'qwen3-tts'
  const segment = modelPath.split('/').find(part => part.startsWith('models--'))
  if (!segment) return 'qwen3-tts'
  return segment.replace(/^models--/, '').replaceAll('--', '/') || 'qwen3-tts'
}

export function embeddedEngineStatus(): EmbeddedEngineStatus {
  const dir = engineDir()
  const venvPython = path.join(dir, 'venv', 'bin', 'python')
  const ready = path.join(dir, 'model.ready')
  let modelPath: string | null = null
  if (existsSync(ready)) {
    try {
      modelPath = readFileSync(ready, 'utf8').trim() || null
    } catch {
      modelPath = null
    }
  }
  return { venvReady: existsSync(venvPython), modelReady: modelPath !== null, modelPath }
}

let sidecar: { port: number; child: ReturnType<typeof spawn> } | null = null

interface SidecarHandle {
  port: number
}

async function startSidecar(): Promise<SidecarHandle> {
  const dir = engineDir()
  const status = embeddedEngineStatus()
  if (!status.venvReady || !status.modelReady) throw new Error('embedded tts engine is not installed')
  const child = spawn(path.join(dir, 'venv', 'bin', 'python'), [serverScript, '--port', '0', '--model', status.modelPath!], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // 模型由安装流程预下载；推理进程绝不隐式拉网。
      HF_HOME: path.join(dir, 'hf'),
      HF_HUB_OFFLINE: '1',
    },
  })
  let settled: ((value: SidecarHandle) => void) | null = null
  let failed: ((error: Error) => void) | null = null
  const portLine = new Promise<SidecarHandle>((resolve, reject) => {
    settled = resolve
    failed = reject
  })
  let buffer = ''
  let timer: NodeJS.Timeout | null = setTimeout(() => {
    timer = null
    failed?.(new Error('tts sidecar did not report a port within 15s'))
  }, 15_000)
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    const match = /MAKEMOVIE_TTS_PORT=(\d+)/.exec(buffer)
    if (match && settled) {
      if (timer) { clearTimeout(timer); timer = null }
      settled({ port: Number(match[1]) })
    }
  })
  child.stderr!.on('data', (chunk: Buffer) => process.stderr.write(`[tts-sidecar] ${chunk}`))
  child.on('exit', (code) => {
    sidecar = null
    if (timer) {
      clearTimeout(timer)
      timer = null
      failed?.(new Error(`tts sidecar exited early (code ${code})`))
    }
  })
  const handle = await portLine
  sidecar = { port: handle.port, child }
  return handle
}

async function ensureSidecar(): Promise<number> {
  if (sidecar) return sidecar.port
  const handle = await startSidecar()
  // 等模型就绪（首次加载 ~20-30s，之后常驻）。
  const deadline = Date.now() + 120_000
  for (;;) {
    const res = await fetch(`http://127.0.0.1:${handle.port}/health`).catch(() => null)
    const body = res && res.ok ? await res.json().catch(() => null) : null
    if (body && body.status === 'ready') return handle.port
    if (body && body.status === 'error') throw new Error(`tts sidecar model error: ${String(body.error).slice(0, 200)}`)
    if (Date.now() > deadline) throw new Error('tts sidecar did not become ready within 120s')
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
}

export interface EmbeddedSpeechRequest {
  text: string
  /** 角色声音参考音频（字节）——worker 存储里的 artifact。 */
  refBytes: Uint8Array
  refMimeType: string
  refText: string
}

export interface EmbeddedSpeechResult {
  bytes: Uint8Array
  generationMs: number
}

/** 用内嵌引擎克隆生成。调用方负责 ref 音频落临时文件之外的一切（入库/QC）。 */
export async function embeddedGenerateSpeech(request: EmbeddedSpeechRequest): Promise<EmbeddedSpeechResult> {
  const port = await ensureSidecar()
  const workdir = await mkdtemp(path.join(tmpdir(), 'mm-ref-'))
  try {
    const ext = request.refMimeType.includes('mpeg') ? '.mp3'
      : request.refMimeType.includes('mp4') ? '.m4a'
        : request.refMimeType.includes('webm') ? '.webm'
          : '.wav'
    const refPath = path.join(workdir, `ref${ext}`)
    await writeFile(refPath, request.refBytes)
    const res = await fetch(`http://127.0.0.1:${port}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: request.text, ref_audio_path: refPath, ref_text: request.refText }),
      signal: AbortSignal.timeout(300_000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`embedded tts generate: HTTP ${res.status} ${detail.slice(0, 200)}`)
    }
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.byteLength === 0) throw new Error('embedded tts generate: empty audio')
    const generationMs = Number(res.headers.get('x-generation-ms') ?? '0')
    return { bytes, generationMs }
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
}

export async function stopEmbeddedEngine(): Promise<void> {
  if (!sidecar) return
  const child = sidecar.child
  sidecar = null
  await new Promise<void>(resolve => {
    child.once('exit', () => resolve())
    child.kill('SIGTERM')
    setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000).unref?.()
  })
}

/** 预留：安装流程跑完后由 API 侧调用不了这里——worker 重启即重新探测。 */
export async function embeddedEngineHealthy(): Promise<boolean> {
  const status = embeddedEngineStatus()
  if (!status.venvReady || !status.modelReady) return false
  try {
    const port = await ensureSidecar()
    const res = await fetch(`http://127.0.0.1:${port}/health`)
    const body = await res.json() as { status?: string }
    return body.status === 'ready'
  } catch {
    return false
  }
}

export const EMBEDDED_DEFAULT_MODEL_ID = DEFAULT_MODEL_ID
