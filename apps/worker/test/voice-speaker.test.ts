import { describe, expect, it } from 'vitest'
import { resolveSpeakerAsset, type VoiceCandidate } from '../src/voice.js'

function character(name: string, voiceArtifactId: string | null): VoiceCandidate {
  return { id: `asset-${name}`, name, voiceArtifactId }
}

describe('resolveSpeakerAsset', () => {
  it('resolves a VO shot to the episode’s only bound character voice', () => {
    const resolved = resolveSpeakerAsset('VO', null, [character('陈默', 'voice-chen')])
    expect(resolved).toEqual({ kind: 'asset', asset: character('陈默', 'voice-chen') })
  })

  it('skips a VO shot when no character voice is bound, instead of treating VO as a name', () => {
    const resolved = resolveSpeakerAsset('VO', null, [])
    expect(resolved).toMatchObject({ kind: 'skip' })
    expect(resolved.kind === 'skip' && resolved.reason).toContain('no character voice bound')
  })

  it('skips a VO shot when several character voices are bound rather than guessing one', () => {
    const resolved = resolveSpeakerAsset('VO', null, [character('陈默', 'v1'), character('林岚', 'v2')])
    expect(resolved).toMatchObject({ kind: 'skip' })
    expect(resolved.kind === 'skip' && resolved.reason).toContain('multiple character voices')
  })

  it('prefers an exact character match when one exists', () => {
    const resolved = resolveSpeakerAsset('陈默', character('陈默', 'voice-chen'), [])
    expect(resolved).toEqual({ kind: 'asset', asset: character('陈默', 'voice-chen') })
  })

  it('does not fall back to a character voice for non-VO source labels', () => {
    for (const speaker of ['系统音', '创作者']) {
      const resolved = resolveSpeakerAsset(speaker, null, [character('陈默', 'voice-chen')])
      expect(resolved).toMatchObject({ kind: 'skip' })
    }
  })
})
