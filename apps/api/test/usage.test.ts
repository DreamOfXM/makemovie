import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Stage, TaskStatus } from '@studio/db'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv

interface UsageBinding {
  slot: string
  connectionId: string
  connectionName: string
  scope: string
}

interface UsageRow {
  stage: string | null
  provider: string
  model: string
  modality: string
  taskCount: number
  entryCount: number
  retriedTaskCount: number
  inputUnits: number
  outputUnits: number
  binding: UsageBinding | null
}

interface UsageReport {
  rows: UsageRow[]
  total: { taskCount: number; entryCount: number; retriedTaskCount: number; inputUnits: number; outputUnits: number }
  units: { input: string; output: string }
}

interface Tenant {
  token: string
  organizationId: string
  projectId: string
  episodeId: string
  secondEpisodeId: string
  connectionName: string
}

const authHeaders = (token: string) => env.authHeaders(token)

// Fixed offsets keep the date-window cases stable inside one run.
const clock = Date.now()
const at = (secondsAgo: number): Date => new Date(clock - secondsAgo * 1000)
const iso = (secondsAgo: number): string => at(secondsAgo).toISOString()

async function createTenant(email: string, organizationName: string, connectionName: string): Promise<Tenant> {
  const owner = await env.register(email, organizationName)
  const token = owner.token
  const organizationId = owner.organization.id

  const project = await env.app.inject({ method: 'POST', url: '/projects', headers: authHeaders(token), payload: { name: `${organizationName} Project` } })
  expect(project.statusCode).toBe(201)

  const episode = await env.app.inject({ method: 'POST', url: `/projects/${project.json().id}/episodes`, headers: authHeaders(token), payload: { number: 1, title: 'EP1' } })
  expect(episode.statusCode).toBe(201)
  const secondEpisode = await env.app.inject({ method: 'POST', url: `/projects/${project.json().id}/episodes`, headers: authHeaders(token), payload: { number: 2, title: 'EP2' } })
  expect(secondEpisode.statusCode).toBe(201)

  const connection = await env.app.inject({ method: 'POST', url: '/providers/connections', headers: authHeaders(token), payload: { provider: 'mock', name: connectionName, apiKey: 'test-key' } })
  expect(connection.statusCode).toBe(201)
  const capabilities = (connection.json() as { capabilities: { id: string; model: string }[] }).capabilities
  const probe = await env.app.inject({ method: 'POST', url: `/providers/connections/${connection.json().id}/probe`, headers: authHeaders(token) })
  expect(probe.statusCode).toBe(200)
  for (const [slot, model] of [['script_text', 'mock-text'], ['video_t2v', 'mock-t2v'], ['tts_voice', 'mock-tts'], ['music_gen', 'mock-music']] as const) {
    const binding = await env.app.inject({
      method: 'POST', url: '/bindings', headers: authHeaders(token),
      payload: { slot, capabilityId: capabilities.find(capability => capability.model === model)!.id },
    })
    expect(binding.statusCode).toBe(201)
  }

  return {
    token,
    organizationId,
    projectId: project.json().id as string,
    episodeId: episode.json().id as string,
    secondEpisodeId: secondEpisode.json().id as string,
    connectionName,
  }
}

/**
 * One paid-for run, written the way the worker writes it: a batch under an episode, a
 * succeeded task under that batch, and exactly one ledger entry naming the task, the
 * winning provider and model, the prompt's character count and the artifact's byte count.
 */
async function seedRun(
  tenant: Tenant,
  options: {
    stage: Stage
    episodeId?: string
    provider?: string
    model: string
    modality: string
    inputUnits: number
    outputUnits: number
    attempts?: number
    createdAt?: Date
    /** Null or missing writes an entry whose task is gone, as a deleted project leaves it. */
    taskId?: string | null
  },
) {
  const batch = await env.db.generationBatch.create({
    data: { organizationId: tenant.organizationId, episodeId: options.episodeId ?? tenant.episodeId, stage: options.stage, plannedCount: 1 },
  })
  const task = await env.db.generationTask.create({
    data: {
      organizationId: tenant.organizationId,
      batchId: batch.id,
      stage: options.stage,
      status: 'SUCCEEDED' as TaskStatus,
      provider: options.provider ?? 'mock',
      model: options.model,
      attempts: options.attempts ?? 1,
    },
  })
  const entry = await env.db.usageLedger.create({
    data: {
      organizationId: tenant.organizationId,
      taskId: options.taskId === undefined ? task.id : options.taskId,
      provider: options.provider ?? 'mock',
      model: options.model,
      modality: options.modality,
      inputUnits: options.inputUnits,
      outputUnits: options.outputUnits,
      createdAt: options.createdAt ?? at(0),
    },
  })
  return { batch, task, entry }
}

async function getUsage(token: string, query: Record<string, string> = {}): Promise<{ statusCode: number; body: UsageReport }> {
  const search = new URLSearchParams(query).toString()
  const res = await env.app.inject({ method: 'GET', url: `/usage${search ? `?${search}` : ''}`, headers: authHeaders(token) })
  return { statusCode: res.statusCode, body: res.json() as UsageReport }
}

const rowFor = (report: UsageReport, stage: string | null, model: string): UsageRow | undefined =>
  report.rows.find(row => row.stage === stage && row.model === model)

beforeAll(async () => {
  env = await startTestEnv()
}, 300_000)

afterAll(async () => {
  await env?.stop()
})

describe('GET /usage', () => {
  it('collapses every task of the same stage and model into one row', async () => {
    const tenant = await createTenant('usage-group@example.com', 'Usage Group Org', 'usage-group-main')
    await seedRun(tenant, { stage: 'VIDEO', model: 'mock-t2v', modality: 't2v', inputUnits: 120, outputUnits: 5000 })
    // The second run is the one the quality gate sent back once before passing.
    await seedRun(tenant, { stage: 'VIDEO', model: 'mock-t2v', modality: 't2v', inputUnits: 80, outputUnits: 4000, attempts: 2 })
    await seedRun(tenant, { stage: 'SCRIPT', model: 'mock-text', modality: 'text', inputUnits: 400, outputUnits: 2048 })

    const { statusCode, body } = await getUsage(tenant.token)
    expect(statusCode).toBe(200)
    expect(body.rows).toHaveLength(2)

    const video = rowFor(body, 'VIDEO', 'mock-t2v')!
    expect(video).toMatchObject({ stage: 'VIDEO', provider: 'mock', model: 'mock-t2v', modality: 't2v', taskCount: 2, entryCount: 2, retriedTaskCount: 1, inputUnits: 200, outputUnits: 9000 })
    // One entry per succeeded task, so the two counts agree here; what separates them is
    // that one of the two runs passed the quality gate only on its second attempt, which
    // the task's attempt count records and the ledger does not.
    expect(body.total).toEqual({ taskCount: 3, entryCount: 3, retriedTaskCount: 1, inputUnits: 600, outputUnits: 11048 })

    // The report names the connection the organization is bound to for that stage today.
    expect(video.binding).toEqual({ slot: 'video_t2v', connectionId: expect.any(String), connectionName: 'usage-group-main', scope: 'organization' })
    expect(rowFor(body, 'SCRIPT', 'mock-text')!.binding).toMatchObject({ slot: 'script_text', connectionName: 'usage-group-main' })
  })

  it('leaves the binding null for a model the organization is no longer bound to', async () => {
    const tenant = await createTenant('usage-rebound@example.com', 'Usage Rebind Org', 'usage-rebind-main')
    await seedRun(tenant, { stage: 'VIDEO', model: 'mock-i2v', modality: 'i2v', inputUnits: 60, outputUnits: 3000 })
    await seedRun(tenant, { stage: 'VIDEO', model: 'mock-t2v', modality: 't2v', inputUnits: 60, outputUnits: 3000 })

    const { body } = await getUsage(tenant.token)
    expect(rowFor(body, 'VIDEO', 'mock-i2v')!.binding).toBeNull()
    expect(rowFor(body, 'VIDEO', 'mock-t2v')!.binding).toMatchObject({ slot: 'video_t2v', connectionName: 'usage-rebind-main' })
  })

  it('resolves the binding at the scope the query implies', async () => {
    const tenant = await createTenant('usage-scope-binding@example.com', 'Usage Binding Scope Org', 'usage-binding-scope-main')
    const capability = await env.db.modelCapability.findFirstOrThrow({
      where: { connection: { organizationId: tenant.organizationId }, model: 'mock-i2v' },
    })
    const binding = await env.app.inject({
      method: 'POST', url: '/bindings', headers: authHeaders(tenant.token),
      payload: { slot: 'video_i2v', capabilityId: capability.id, projectId: tenant.projectId },
    })
    expect(binding.statusCode).toBe(201)
    await seedRun(tenant, { stage: 'VIDEO', model: 'mock-i2v', modality: 'i2v', inputUnits: 4, outputUnits: 40 })

    // An episode query is a project query one level down, so the project's binding answers it.
    const scoped = await getUsage(tenant.token, { episodeId: tenant.episodeId })
    expect(rowFor(scoped.body, 'VIDEO', 'mock-i2v')!.binding).toEqual({
      slot: 'video_i2v',
      connectionId: expect.any(String),
      connectionName: 'usage-binding-scope-main',
      scope: 'project',
    })
    // With no project or episode named there is no narrower scope to look at, and the
    // organization has no i2v binding of its own.
    const orgWide = await getUsage(tenant.token)
    expect(rowFor(orgWide.body, 'VIDEO', 'mock-i2v')!.binding).toBeNull()
  })

  it('never reports another organization rows', async () => {
    const mine = await createTenant('usage-mine@example.com', 'Usage Mine Org', 'usage-mine-main')
    const theirs = await createTenant('usage-theirs@example.com', 'Usage Theirs Org', 'usage-theirs-main')
    await seedRun(mine, { stage: 'MUSIC', model: 'mock-music', modality: 'music', inputUnits: 111, outputUnits: 700 })
    await seedRun(theirs, { stage: 'MUSIC', model: 'mock-music', modality: 'music', inputUnits: 88888, outputUnits: 99999 })

    const ours = await getUsage(mine.token)
    expect(ours.body.total).toEqual({ taskCount: 1, entryCount: 1, retriedTaskCount: 0, inputUnits: 111, outputUnits: 700 })
    expect(ours.body.rows.every(row => row.inputUnits !== 88888)).toBe(true)

    const theirsReport = await getUsage(theirs.token)
    expect(theirsReport.body.total.inputUnits).toBe(88888)
    expect(theirsReport.body.rows).toHaveLength(1)

    // An id from another tenant answers exactly as the other routes answer it: 404, and
    // no hint that the row exists at all.
    const foreignProject = await env.app.inject({ method: 'GET', url: `/usage?projectId=${theirs.projectId}`, headers: authHeaders(mine.token) })
    expect(foreignProject.statusCode).toBe(404)
    expect(foreignProject.json()).toEqual({ error: 'Project not found' })
    const foreignEpisode = await env.app.inject({ method: 'GET', url: `/usage?episodeId=${theirs.episodeId}`, headers: authHeaders(mine.token) })
    expect(foreignEpisode.statusCode).toBe(404)
    expect(foreignEpisode.json()).toEqual({ error: 'Episode not found' })

    // Narrowing to our own project keeps the other tenant out too.
    const scoped = await getUsage(mine.token, { projectId: mine.projectId })
    expect(scoped.body.total.inputUnits).toBe(111)
  })

  it('narrows to one project or one episode', async () => {
    const tenant = await createTenant('usage-scope@example.com', 'Usage Scope Org', 'usage-scope-main')
    await seedRun(tenant, { stage: 'AUDIO', model: 'mock-tts', modality: 'tts', inputUnits: 10, outputUnits: 100 })
    await seedRun(tenant, { stage: 'AUDIO', model: 'mock-tts', modality: 'tts', inputUnits: 20, outputUnits: 200, episodeId: tenant.secondEpisodeId })
    const rival = await createTenant('usage-scope-rival@example.com', 'Usage Scope Rival Org', 'usage-scope-rival-main')
    await seedRun(rival, { stage: 'AUDIO', model: 'mock-tts', modality: 'tts', inputUnits: 4000, outputUnits: 4000 })

    const all = await getUsage(tenant.token)
    expect(all.body.total.inputUnits).toBe(30)
    const episodeOne = await getUsage(tenant.token, { episodeId: tenant.episodeId })
    expect(episodeOne.body.rows).toHaveLength(1)
    expect(episodeOne.body.total).toEqual({ taskCount: 1, entryCount: 1, retriedTaskCount: 0, inputUnits: 10, outputUnits: 100 })
    const project = await getUsage(tenant.token, { projectId: tenant.projectId })
    expect(project.body.total.taskCount).toBe(2)
  })

  it('applies the date window to the moment the usage was recorded', async () => {
    const tenant = await createTenant('usage-window@example.com', 'Usage Window Org', 'usage-window-main')
    await seedRun(tenant, { stage: 'SCRIPT', model: 'mock-text', modality: 'text', inputUnits: 1000, outputUnits: 9000, createdAt: at(3 * 24 * 3600) })
    await seedRun(tenant, { stage: 'VIDEO', model: 'mock-t2v', modality: 't2v', inputUnits: 5, outputUnits: 50, createdAt: at(3600) })

    const sinceYesterday = await getUsage(tenant.token, { from: iso(24 * 3600) })
    expect(sinceYesterday.body.rows.map(row => row.model)).toEqual(['mock-t2v'])
    expect(sinceYesterday.body.total.inputUnits).toBe(5)

    const beforeYesterday = await getUsage(tenant.token, { to: iso(2 * 24 * 3600) })
    expect(beforeYesterday.body.rows.map(row => row.model)).toEqual(['mock-text'])

    const closed = await getUsage(tenant.token, { from: iso(4 * 24 * 3600), to: iso(2 * 24 * 3600) })
    expect(closed.body.rows).toHaveLength(1)
    expect(closed.body.total.inputUnits).toBe(1000)

    const open = await getUsage(tenant.token, { from: iso(60), to: iso(0) })
    expect(open.body.rows).toHaveLength(0)
    expect(open.body.total).toEqual({ taskCount: 0, entryCount: 0, retriedTaskCount: 0, inputUnits: 0, outputUnits: 0 })

    const malformed = await env.app.inject({ method: 'GET', url: '/usage?from=last-tuesday', headers: authHeaders(tenant.token) })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json()).toEqual({ error: 'from must be an ISO date' })
    const reversed = await env.app.inject({ method: 'GET', url: `/usage?from=${iso(0)}&to=${iso(3600)}`, headers: authHeaders(tenant.token) })
    expect(reversed.statusCode).toBe(400)
    expect(reversed.json()).toEqual({ error: 'from must not be after to' })
  })

  it('keeps ledger entries whose task is gone out of a project filter but in the totals', async () => {
    const tenant = await createTenant('usage-orphan@example.com', 'Usage Orphan Org', 'usage-orphan-main')
    // Deleting a project cascades its batches and tasks; the usage entries stay with the
    // organization and no longer carry a stage, an episode or a project.
    const orphaned = await seedRun(tenant, { stage: 'VIDEO', model: 'mock-t2v', modality: 't2v', inputUnits: 7, outputUnits: 70 })
    await env.db.generationTask.delete({ where: { id: orphaned.task.id } })
    await seedRun(tenant, { stage: 'VIDEO', model: 'mock-t2v', modality: 't2v', inputUnits: 3, outputUnits: 30 })

    const all = await getUsage(tenant.token)
    expect(all.body.rows).toHaveLength(2)
    // The live run reads as a stage row; the entry whose task is gone cannot be
    // attributed to any stage, so it stands apart instead of silently borrowing one.
    expect(all.body.rows[0]).toMatchObject({ stage: 'VIDEO', taskCount: 1, entryCount: 1, inputUnits: 3, outputUnits: 30 })
    expect(all.body.rows[1]).toMatchObject({ stage: null, taskCount: 0, entryCount: 1, inputUnits: 7, outputUnits: 70 })
    expect(all.body.total).toEqual({ taskCount: 1, entryCount: 2, retriedTaskCount: 0, inputUnits: 10, outputUnits: 100 })

    const scoped = await getUsage(tenant.token, { projectId: tenant.projectId })
    expect(scoped.body.rows).toHaveLength(1)
    expect(scoped.body.total).toEqual({ taskCount: 1, entryCount: 1, retriedTaskCount: 0, inputUnits: 3, outputUnits: 30 })
  })

  it('requires a session', async () => {
    const anonymous = await env.app.inject({ method: 'GET', url: '/usage' })
    expect(anonymous.statusCode).toBe(401)
    expect(anonymous.json()).toEqual({ error: 'Missing bearer token' })
  })

  it('reports units and nothing else: no price, currency, or cost column exists', async () => {
    const tenant = await createTenant('usage-boundary@example.com', 'Usage Boundary Org', 'usage-boundary-main')
    await seedRun(tenant, { stage: 'VIDEO', model: 'mock-t2v', modality: 't2v', inputUnits: 12, outputUnits: 34 })
    const res = await env.app.inject({ method: 'GET', url: '/usage', headers: authHeaders(tenant.token) })
    expect(res.statusCode).toBe(200)
    assertNoPriceTags(res.payload)
    const body = res.json() as UsageReport
    expect(body.units).toEqual({ input: 'prompt_characters', output: 'bytes' })
    expect(body.rows[0]).toMatchObject({ inputUnits: 12, outputUnits: 34 })
  })
})

/**
 * The shape of this response is where the open core stops.
 *
 * `UsageLedger` records what a generation consumed — prompt characters in, bytes out — and
 * `GET /usage` is allowed to say exactly that and nothing more. Pricing, invoicing, quotas,
 * refunds and top-ups are a separate commercial product in a separate repository, so a
 * contributor who adds a money column here (or a per-unit cost, or a balance) breaks this
 * assertion, and that break is deliberate: it is the boundary, written as a test. Fixing it
 * by editing this file is the wrong answer; the right answer is to put the number in the
 * commercial repository and read it back over the network.
 */
function assertNoPriceTags(payload: string): void {
  const body = JSON.parse(payload) as Record<string, unknown>
  const boundary = [
    'OPEN-CORE BOUNDARY: GET /usage is a read-only report of units consumed (prompt characters, bytes).',
    'Pricing, currency, invoices, quotas, refunds, balances and seats do not belong in this repository.',
    'Move the number to the commercial repository instead of extending this response.',
  ].join(' ')

  const topLevel = Object.keys(body).sort().join(',')
  if (topLevel !== 'rows,total,units') {
    throw new Error(`${boundary} — top-level keys changed to "${topLevel}" (expected "rows,total,units").`)
  }

  const rows = body.rows as Record<string, unknown>[]
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`${boundary} — the report carried no rows, so its shape went unverified.`)
  }
  const rowKeys = Object.keys(rows[0] ?? {}).sort().join(',')
  const expectedRows = 'binding,entryCount,inputUnits,modality,model,outputUnits,provider,retriedTaskCount,stage,taskCount'
  if (rowKeys !== expectedRows) {
    throw new Error(`${boundary} — usage row keys changed to "${rowKeys}".`)
  }

  const totalKeys = Object.keys(body.total as Record<string, unknown>).sort().join(',')
  if (totalKeys !== 'entryCount,inputUnits,outputUnits,retriedTaskCount,taskCount') {
    throw new Error(`${boundary} — usage total keys changed to "${totalKeys}".`)
  }

  const moneyKey = /pric|cost|amount|currenc|billing|invoice|quota|refund|charge|fee|payment|money|balance|topup|top-up|seat|usd|eur|gbp|jpy|cny/i
  const offenders: string[] = []
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) walk(item, `${path}[${index}]`)
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      if (moneyKey.test(key)) offenders.push(`${path}.${key}`)
      walk(item, `${path}.${key}`)
    }
  }
  walk(body, '')
  if (offenders.length > 0) {
    throw new Error(`${boundary} — money-shaped field names found at ${offenders.join(', ')}.`)
  }

  const symbols = /[$¥€£₹₩]/
  if (symbols.test(payload)) {
    throw new Error(`${boundary} — a currency symbol appeared in the response body.`)
  }
}
