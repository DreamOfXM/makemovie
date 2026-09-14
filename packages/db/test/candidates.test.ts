import { describe, expect, it } from 'vitest'
import { capabilitySlots } from '@studio/domain'
import { resolveSlotCandidates, toDbSlot, type PrismaClient } from '../src/index.js'

interface BindingRow {
  id: string
  projectId: string | null
  priority: number
  capabilityId: string
  capability: {
    id: string
    connectionId: string
    model: string
    displayName: string | null
    modality: string
    entitlementVerifiedAt: Date | null
    connection: { id: string; name: string; provider: string; enabled: boolean }
  }
}

interface FindManyArgs {
  where: { organizationId: string; slot: string; enabled: boolean }
  orderBy: { priority: string }
  include: { capability: { include: { connection: boolean } } }
}

const VERIFIED = new Date('2026-01-01T00:00:00.000Z')

/** One binding, with the capability and connection named after it by default. */
function binding(
  id: string,
  overrides: { capabilityId?: string; projectId?: string | null; priority?: number; verified?: boolean; connectionEnabled?: boolean } = {},
): BindingRow {
  const capabilityId = overrides.capabilityId ?? id
  return {
    id,
    projectId: overrides.projectId ?? null,
    priority: overrides.priority ?? 0,
    capabilityId,
    capability: {
      id: capabilityId,
      connectionId: `conn-${capabilityId}`,
      model: capabilityId,
      displayName: `Display ${capabilityId}`,
      modality: 't2v',
      entitlementVerifiedAt: overrides.verified === false ? null : VERIFIED,
      connection: {
        id: `conn-${capabilityId}`,
        name: `Connection ${capabilityId}`,
        provider: 'mock',
        enabled: overrides.connectionEnabled !== false,
      },
    },
  }
}

/**
 * `findMany` stands in for PostgreSQL: rows come back already ordered by priority
 * descending, exactly as the query asks, so these tests exercise only the
 * filtering and dedupe the function does itself.
 */
function stubDb(rows: BindingRow[], captured: FindManyArgs[]): PrismaClient {
  return {
    capabilityBinding: {
      async findMany(args: FindManyArgs) {
        captured.push(args)
        return rows
      },
    },
  } as unknown as PrismaClient
}

async function resolve(rows: BindingRow[], projectId: string | null = null) {
  const captured: FindManyArgs[] = []
  const candidates = await resolveSlotCandidates(stubDb(rows, captured), 'org-1', projectId, 'video_t2v')
  return { candidates, captured }
}

describe('toDbSlot', () => {
  it('spells every domain slot the way the schema enum does', () => {
    for (const slot of capabilitySlots) expect(toDbSlot(slot)).toBe(slot.toUpperCase())
    expect(toDbSlot('visual_audit')).toBe('VISUAL_AUDIT')
  })
})

describe('resolveSlotCandidates', () => {
  it('queries enabled bindings for the enum slot, ordered by priority descending', async () => {
    const { captured } = await resolve([])
    expect(captured).toEqual([
      {
        where: { organizationId: 'org-1', slot: 'VIDEO_T2V', enabled: true },
        orderBy: { priority: 'desc' },
        include: { capability: { include: { connection: true } } },
      },
    ])
  })

  it('puts project scope first regardless of priority, then org scope by priority', async () => {
    const { candidates } = await resolve(
      [
        binding('org-high', { priority: 90 }),
        binding('proj-low', { projectId: 'p1', priority: 1 }),
        binding('org-low', { priority: 5 }),
      ],
      'p1',
    )
    expect(candidates.map(candidate => [candidate.bindingId, candidate.scope, candidate.priority])).toEqual([
      ['proj-low', 'project', 1],
      ['org-high', 'organization', 90],
      ['org-low', 'organization', 5],
    ])
  })

  it('keeps one candidate per capability when the same model is bound at both scopes', async () => {
    const { candidates } = await resolve(
      [
        binding('dup-org', { capabilityId: 'shared', priority: 99 }),
        binding('dup-proj', { capabilityId: 'shared', projectId: 'p1', priority: 1 }),
        binding('other', { priority: 50 }),
      ],
      'p1',
    )
    expect(candidates.map(candidate => candidate.bindingId)).toEqual(['dup-proj', 'other'])
  })

  it('drops capabilities that lost their entitlement and connections that were disabled', async () => {
    const { candidates } = await resolve([
      binding('unverified', { verified: false, priority: 100 }),
      binding('dark', { connectionEnabled: false, priority: 80 }),
      binding('good', { priority: 10 }),
    ])
    expect(candidates.map(candidate => candidate.bindingId)).toEqual(['good'])
  })

  it('returns organization scope only when no project is given', async () => {
    const { candidates } = await resolve([
      binding('proj', { projectId: 'p1', priority: 90 }),
      binding('org', { priority: 1 }),
    ])
    expect(candidates.map(candidate => [candidate.bindingId, candidate.scope])).toEqual([['org', 'organization']])
  })

  it('returns nothing when every binding is filtered out', async () => {
    const { candidates } = await resolve([binding('dark', { connectionEnabled: false })])
    expect(candidates).toEqual([])
  })

  it('carries every field the worker and the console each need', async () => {
    const { candidates } = await resolve([binding('b-1', { capabilityId: 'cap-1', priority: 7 })])
    expect(candidates).toHaveLength(1)
    const [candidate] = candidates
    expect(Object.keys(candidate).sort()).toEqual([
      'bindingId', 'capabilityId', 'connectionId', 'connectionName', 'displayName', 'modality', 'model', 'priority', 'provider', 'scope',
    ])
    expect(candidate).toEqual({
      bindingId: 'b-1',
      scope: 'organization',
      priority: 7,
      capabilityId: 'cap-1',
      connectionId: 'conn-cap-1',
      connectionName: 'Connection cap-1',
      provider: 'mock',
      model: 'cap-1',
      displayName: 'Display cap-1',
      modality: 't2v',
    })
  })
})
