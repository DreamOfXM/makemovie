import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { run, probeDuration, hasAudioStream } from '@studio/media'
import type { PipelineDeps } from './deps.js'

/** Exact post-processed mix plus separate source stems for an editable handoff.
 * The mix is audible by default; stems are disabled so importing never doubles it.
 */
export async function saveNleAudio(deps: PipelineDeps, scope: { organizationId: string; compositionId: string }, workdir: string, mix: string, stems: Array<{ name: string; file: string; startMs: number; gain: number; durationMs?: number }>) {
  const tracks: Array<{ name: string; artifactId: string; startMs: number; durationMs: number; gain: number; muted: boolean }> = []
  const inputs = [...(await hasAudioStream(mix) ? [{ name: 'Master mix (stems disabled)', file: mix, startMs: 0, gain: 1, muted: false }] : []), ...stems.map(stem => ({ ...stem, muted: true }))]
  for (const [index, input] of inputs.entries()) {
    const file = path.join(workdir, `nle-audio-${index}.wav`)
    const durationMs = 'durationMs' in input ? input.durationMs : undefined
    await run('ffmpeg', ['-y', '-v', 'error', '-i', input.file, '-vn', '-af', `volume=${input.gain}${durationMs !== undefined ? `,apad,atrim=duration=${durationMs / 1000}` : ''}`, '-c:a', 'pcm_s16le', file])
    const objectKey = `nle/${scope.organizationId}/${scope.compositionId}/audio-${index}.wav`
    const stored = await deps.storage.put(objectKey, new Uint8Array(await readFile(file)), 'audio/wav')
    const measuredDurationMs = await probeDuration(file)
    const artifact = await deps.db.mediaArtifact.upsert({ where: { objectKey_version: { objectKey, version: 1 } }, create: { organizationId: scope.organizationId, stage: 'AUDIO', objectKey, checksum: stored.checksum, mimeType: 'audio/wav', version: 1, durationMs: measuredDurationMs }, update: {} })
    tracks.push({ name: input.name, artifactId: artifact.id, startMs: input.startMs, durationMs: measuredDurationMs, gain: 1, muted: input.muted })
  }
  return tracks
}
