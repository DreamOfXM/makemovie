import type { FastifyInstance } from 'fastify'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { requirePermission } from '../plugins/auth.js'

/**
 * System-level TTS capability check (r10 audio system).
 *
 * The voice cloning path needs to know, before it promises anything:
 *   1. Is the embedded Qwen3-TTS engine installed? (product main path)
 *   2. Is Voicebox already running? (opportunistic free-ride)
 *   3. Does this machine meet the minimum specs for local inference?
 *   4. What fallback should the UI offer?
 *
 * Every check is cheap (< 2s) and none of them touch the user's data.
 * The endpoint is read-only and requires no special permission beyond login.
 *
 * The response shape:
 *   { embedded: {installed, installing, modelId},
 *     voiceboxOnline: boolean,
 *     localInference: { supported: boolean, memoryGB: number, diskFreeGB: number,
 *                       chip: 'apple_silicon' | 'cuda' | 'unsupported', reasons: string[] },
 *     recommendation: 'embedded' | 'voicebox' | 'download' | 'cloud_only' }
 */
export function systemRoutes(app: FastifyInstance): void {
  app.get(
    '/system/tts-capability',
    { preHandler: requirePermission('read') },
    async (_request, reply) => {
      const voiceboxOnline = await checkVoicebox()
      const caps = checkLocalInference()
      const embedded = embeddedStatus()

      const recommendation = embedded.installed
        ? 'embedded'
        : voiceboxOnline
          ? 'voicebox'
          : caps.supported
            ? 'download'
            : 'cloud_only'

      return reply.send({
        embedded,
        voiceboxOnline,
        localInference: caps,
        recommendation,
      })
    },
  )

  // ── 内嵌引擎安装（r10 路径 2 的下载引导）──
  // 触发条件由 UI 按定稿矩阵把关（要用角色声音+无引擎+系统检测过）；
  // API 侧只做物理校验：系统支持才允许启动，防手滑。
  app.get(
    '/system/tts-engine/install-status',
    { preHandler: requirePermission('read') },
    async (_request, reply) => {
      return reply.send(readInstallState())
    },
  )

  app.post(
    '/system/tts-engine/install',
    { preHandler: requirePermission('providers:manage') },
    async (_request, reply) => {
      const state = readInstallState()
      if (state.phase !== 'done' && state.phase !== 'error' && state.running) {
        return reply.code(409).send({ error: 'install already in progress' })
      }
      if (embeddedStatus().installed) {
        return reply.code(409).send({ error: 'engine already installed' })
      }
      if (!checkLocalInference().supported) {
        return reply.code(409).send({ error: 'system does not meet local inference requirements' })
      }
      const dir = engineDir()
      const installer = resolveInstallerScript()
      if (!installer) return reply.code(500).send({ error: 'installer script not found' })
      const child = spawn('/usr/bin/python3', [installer, '--engine-dir', dir], {
        cwd: dir,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, HF_ENDPOINT: process.env.HF_ENDPOINT ?? 'https://hf-mirror.com' },
      })
      child.unref()
      return reply.code(202).send({ started: true, pid: child.pid })
    },
  )
}

// ── 引擎目录与安装状态（与 worker 的 tts-engine.ts 同一套布局约定）──

const apiDir = path.dirname(fileURLToPath(import.meta.url))

function engineDir(): string {
  return process.env.STUDIO_TTS_ENGINE_DIR || path.resolve(apiDir, '../../../..', 'var', 'tts-engine')
}

function resolveInstallerScript(): string | null {
  const candidates = [
    path.resolve(apiDir, '../../../worker/engine/install_tts_engine.py'),
    path.resolve(apiDir, '../../../../apps/worker/engine/install_tts_engine.py'),
  ]
  for (const script of candidates) {
    if (existsSync(script)) return script
  }
  return null
}

interface InstallState {
  phase: 'idle' | 'venv' | 'model' | 'done' | 'error'
  detail: string
  error: string | null
  pid: number | null
  updatedAt: number
  running: boolean
}

function readInstallState(): InstallState {
  const file = path.join(engineDir(), 'install-state.json')
  const idle: InstallState = { phase: 'idle', detail: '', error: null, pid: null, updatedAt: 0, running: false }
  if (!existsSync(file)) return idle
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<InstallState>
    let running = false
    if (typeof raw.pid === 'number' && raw.pid > 0) {
      try {
        process.kill(raw.pid, 0)
        running = true
      } catch {
        running = false
      }
    }
    return {
      phase: (raw.phase ?? 'idle') as InstallState['phase'],
      detail: raw.detail ?? '',
      error: raw.error ?? null,
      pid: raw.pid ?? null,
      updatedAt: raw.updatedAt ?? 0,
      running,
    }
  } catch {
    return idle
  }
}

function embeddedStatus(): { installed: boolean; installing: boolean; modelId: string | null; phase: string } {
  const dir = engineDir()
  const venvReady = existsSync(path.join(dir, 'venv', 'bin', 'python'))
  const modelReady = existsSync(path.join(dir, 'model.ready'))
  const state = readInstallState()
  return {
    installed: venvReady && modelReady,
    installing: state.running && (state.phase === 'venv' || state.phase === 'model'),
    modelId: 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit',
    phase: state.phase,
  }
}

async function checkVoicebox(): Promise<boolean> {
  try {
    const res = await fetch('http://127.0.0.1:17493/profiles', {
      signal: AbortSignal.timeout(2000),
    })
    return res.ok
  } catch {
    return false
  }
}

function checkLocalInference(): {
  supported: boolean
  memoryGB: number
  diskFreeGB: number
  chip: 'apple_silicon' | 'cuda' | 'unsupported'
  reasons: string[]
} {
  const memoryGB = Math.round(os.totalmem() / 1024 / 1024 / 1024)
  const diskFreeGB = Math.round(os.freemem() > 0 ? getDiskFreeGB() : 0)
  const chip = detectChip()
  const reasons: string[] = []

  if (memoryGB < 8) reasons.push(`内存 ${memoryGB}GB（需 ≥8GB）`)
  if (diskFreeGB > 0 && diskFreeGB < 3) reasons.push(`磁盘可用 ${diskFreeGB}GB（需 ≥3GB）`)
  if (chip === 'unsupported') {
    reasons.push(
      os.platform() === 'darwin'
        ? `芯片不支持本地推理（需 Apple Silicon M1+，当前 ${os.cpus()[0]?.model ?? 'unknown'}）`
        : `需要 NVIDIA GPU（CUDA）或 Apple Silicon（当前 ${os.platform()}/${os.arch()}）`,
    )
  }

  return {
    supported: reasons.length === 0,
    memoryGB,
    diskFreeGB,
    chip,
    reasons,
  }
}

function detectChip(): 'apple_silicon' | 'cuda' | 'unsupported' {
  if (os.platform() === 'darwin') {
    // Apple Silicon: arm64 on macOS
    return os.arch() === 'arm64' ? 'apple_silicon' : 'unsupported'
  }
  // Linux/Windows: check for NVIDIA GPU via nvidia-smi
  if (os.platform() === 'linux' || os.platform() === 'win32') {
    try {
      const require = createRequire(import.meta.url)
      const { execSync } = require('node:child_process') as typeof import('node:child_process')
      execSync('nvidia-smi --query-gpu=name --format=csv,noheader', { timeout: 2000, stdio: 'pipe' })
      return 'cuda'
    } catch {
      return 'unsupported'
    }
  }
  return 'unsupported'
}

/** os.freemem() is RAM not disk; we approximate disk free from statfs/fstatfs via a spawn. */
function getDiskFreeGB(): number {
  try {
    const require = createRequire(import.meta.url)
    const { execSync } = require('node:child_process') as typeof import('node:child_process')
    const output = os.platform() === 'darwin'
      ? execSync('df -g / | tail -1 | awk "{print \\$4}"', { timeout: 2000, encoding: 'utf8' }).trim()
      : execSync('df -BG / | tail -1 | awk "{print \\$4}"', { timeout: 2000, encoding: 'utf8' }).trim()
    const gb = parseInt(output.replace(/[^0-9]/g, ''), 10)
    return Number.isFinite(gb) ? gb : 0
  } catch {
    return 0
  }
}
