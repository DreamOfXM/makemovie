import type { FastifyInstance } from 'fastify'
import os from 'node:os'
import { createRequire } from 'node:module'
import { requirePermission } from '../plugins/auth.js'

/**
 * System-level TTS capability check (r10 audio system).
 *
 * The voice cloning path needs to know, before it promises anything:
 *   1. Is Voicebox already running? (then we skip the download entirely)
 *   2. Does this machine meet the minimum specs for local inference?
 *   3. What fallback should the UI offer?
 *
 * Every check is cheap (< 2s) and none of them touch the user's data.
 * The endpoint is read-only and requires no special permission beyond login.
 *
 * The response shape:
 *   { voiceboxOnline: boolean,
 *     localInference: { supported: boolean, memoryGB: number, diskFreeGB: number,
 *                       chip: 'apple_silicon' | 'cuda' | 'unsupported', reasons: string[] },
 *     recommendation: 'voicebox' | 'download' | 'cloud_only' }
 */
export function systemRoutes(app: FastifyInstance): void {
  app.get(
    '/system/tts-capability',
    { preHandler: requirePermission('read') },
    async (_request, reply) => {
      const voiceboxOnline = await checkVoicebox()
      const caps = checkLocalInference()

      const recommendation = voiceboxOnline
        ? 'voicebox'
        : caps.supported
          ? 'download'
          : 'cloud_only'

      return reply.send({
        voiceboxOnline,
        localInference: caps,
        recommendation,
      })
    },
  )
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
