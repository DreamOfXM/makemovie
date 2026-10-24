import { it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { run } from '@studio/media'
import { startTestEnv } from './env.js'

it('exports a frozen no-edit master mix, independent disabled stems, CFR media and the rendered final-frame hold', async () => {
  const env = await startTestEnv()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nle-handoff-'))
  try {
    const user = await env.register('nle-frozen@example.com', 'NLE frozen')
    const organizationId = user.organization.id
    const headers = env.authHeaders(user.token)
    const project = await env.db.project.create({ data: { organizationId, name: 'Frozen NLE' } })
    const episode = await env.db.episode.create({ data: { projectId: project.id, number: 1, title: 'No edit' } })
    const shot = await env.db.storyboard.create({ data: { episodeId: episode.id, number: 1, title: 'Shot', description: 'x', durationMs: 1000, sourceExcerpt: '', continuityIn: '', continuityOut: '' } })
    const videoFile = path.join(dir, 'source.mp4')
    const masterFile = path.join(dir, 'master.mp4')
    const audioFile = path.join(dir, 'audio.wav')
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=30:duration=1', '-pix_fmt', 'yuv420p', videoFile])
    await run('ffmpeg', ['-y', '-v', 'error', '-i', videoFile, '-vf', 'tpad=stop_mode=clone:stop_duration=1', '-c:v', 'libx264', masterFile])
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'pcm_s16le', audioFile])
    async function artifact(stage: 'VIDEO' | 'COMPOSITION' | 'AUDIO' | 'MUSIC', file: string, name: string, durationMs: number) {
      const stored = await env.app.storage.put(name, new Uint8Array(await readFile(file)), stage === 'VIDEO' || stage === 'COMPOSITION' ? 'video/mp4' : 'audio/wav')
      return env.db.mediaArtifact.create({ data: { organizationId, stage, objectKey: name, mimeType: stored.mimeType, checksum: stored.checksum, version: 1, durationMs, ...(stage === 'VIDEO' ? { width: 160, height: 120 } : {}) } })
    }
    const video = await artifact('VIDEO', videoFile, 'source.mp4', 1000)
    const master = await artifact('COMPOSITION', masterFile, 'master.mp4', 2000)
    const mix = await artifact('AUDIO', audioFile, 'mix.wav', 2000)
    const stem = await artifact('AUDIO', audioFile, 'stem.wav', 2000)
    const score = await artifact('MUSIC', audioFile, 'score.wav', 2000)
    const composition = await env.db.composition.create({ data: { episodeId: episode.id, status: 'COMPLETED', artifactId: master.id, manifest: JSON.stringify({ resolved: { shots: [{ storyboardId: shot.id, videoArtifactId: video.id }], musicArtifactId: score.id }, nleAudio: [
      { name: 'Master mix (stems disabled)', artifactId: mix.id, startMs: 0, durationMs: 2000, gain: 1, muted: false },
      { name: 'Voice source', artifactId: stem.id, startMs: 0, durationMs: 60000, gain: 1, muted: true },
    ] }) } })
    expect(composition.editRevisionId).toBeNull()
    const delivery = await env.db.delivery.create({ data: { episodeId: episode.id, artifactId: master.id, manifest: JSON.stringify({ episode: { number: 1, title: 'No edit' }, storyboards: [], composition: { tracks: [score] } }) } })
    const get = (suffix: string) => env.app.inject({ method: 'GET', url: `/api/deliveries/${delivery.id}/${suffix}`, headers })
    const otio = await get('edit-list?format=otio')
    expect(otio.statusCode).toBe(200)
    const timeline = otio.json()
    const tracks = timeline.tracks.children
    expect(tracks).toHaveLength(3) // V1 + exact mix + disabled voice; no duplicate Score.
    expect(tracks[0].children).toHaveLength(2)
    expect(tracks[0].children.map((clip: any) => clip.source_range.duration.value)).toEqual([25, 25])
    expect(tracks[2].children[0].enabled).toBe(false)
    expect(tracks[2].children[0].source_range.duration.value).toBe(50) // long disabled source cannot extend the sequence
    const xml = await get('edit-list?format=xmeml')
    expect(xml.body.match(/<track>/g)).toHaveLength(3)
    expect(xml.body).toContain('<enabled>FALSE</enabled>')
    const fcpxml = await get('edit-list?format=fcpxml')
    expect(fcpxml.body).toContain('hasAudio="0"')
    const pkg = await get('media-package')
    expect(pkg.statusCode).toBe(200)
    const files = unzipSync(pkg.rawPayload)
    const packagedVideo = path.join(dir, 'packaged.mp4')
    await writeFile(packagedVideo, files[`media/${video.id}.mp4`]!)
    const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,nb_frames', '-of', 'json', packagedVideo])
    expect(JSON.parse(probe.stdout).streams[0]).toMatchObject({ r_frame_rate: '25/1', nb_frames: '25' })
    expect(files[`media/${master.id}-tail.mp4`]).toBeDefined()
    expect(files[`media/${mix.id}.wav`]).toBeDefined()
    expect(files[`media/${stem.id}.wav`]).toBeDefined()

    // Legacy edit revisions also receive real gain-baked media and source ranges.
    const edit = await env.db.episodeEdit.create({ data: { organizationId, episodeId: episode.id, headRevision: 1 } })
    const revision = await env.db.episodeEditRevision.create({ data: { editId: edit.id, revision: 1, fpsNum: 25, fpsDen: 1, clips: JSON.stringify([{ clipId: 'c1', storyboardId: shot.id, artifactId: video.id, sourceInFrame: 0, sourceOutFrame: 25 }]), tracks: JSON.stringify([{ elementId: 'range-gain', sourceArtifactId: stem.id, anchor: 'sequence', offsetFrame: -25, sourceInFrame: 0, sourceOutFrame: 50, gain: 0.5, muted: true, locked: false }]), outputSpec: '{}', fingerprint: 'legacy', author: 'test' } })
    await env.db.composition.update({ where: { id: composition.id }, data: { editRevisionId: revision.id, manifest: '{}' } })
    const legacyOtio = (await get('edit-list?format=otio')).json()
    const audioClip = legacyOtio.tracks.children.flatMap((track: any) => track.children).find((clip: any) => clip.name === 'range-gain')
    expect(audioClip.source_range.start_time.value).toBe(25)
    expect(audioClip.source_range.duration.value).toBe(25)
    expect(audioClip.enabled).toBe(false)
    const legacyPkg = await get('media-package')
    expect(legacyPkg.statusCode).toBe(200)
    const legacyFiles = unzipSync(legacyPkg.rawPayload)
    const gainFile = path.join(dir, 'gain.wav')
    await writeFile(gainFile, legacyFiles[`media/${stem.id}-track-0.wav`]!)
    const measure = async (file: string) => {
      const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'])
      return Number(/mean_volume: ([\d.-]+) dB/.exec(stderr)![1])
    }
    expect(await measure(gainFile) - await measure(audioFile)).toBeCloseTo(-6, 0)

  } finally { await env.stop(); await rm(dir, { recursive: true, force: true }) }
})
