import type { FastifyInstance } from 'fastify'
import type { SlotCandidate, Stage } from '@studio/db'
import { resolveSlotCandidates } from '@studio/db'
import type { CapabilitySlot } from '@studio/domain'
import { toApiStage, type GenerationStage } from '@studio/pipeline'
import { requirePermission } from '../plugins/auth.js'

/**
 * Read-only usage reporting over `UsageLedger`.
 *
 * The ledger is the record of what a generation attempt consumed: the worker writes one
 * entry per **succeeded** task, carrying the prompt's character count as `inputUnits` and
 * the stored artifact's byte count as `outputUnits`. Both are physical quantities, and this
 * endpoint reports them as such — it deliberately has no price, no currency, and no
 * derived cost. Turning characters and bytes into money is a commercial concern and lives
 * outside this repository; nothing here may grow a column that pretends otherwise.
 */

interface UsageBindingDto {
  slot: CapabilitySlot
  connectionId: string
  connectionName: string
  scope: 'project' | 'organization'
}

interface UsageRowDto {
  /** The stage of the task that spent it, in the API's stage vocabulary. Null when the
   * task is gone: deleting a project cascades its batches, tasks and artifacts, while the
   * usage entries stay with the organization, and a ledger row carries no project of its
   * own to fall back on. Such rows still count toward the totals — the consumption
   * happened — but they belong to no project filter. */
  stage: GenerationStage | null
  provider: string
  model: string
  modality: string
  /** Distinct generation tasks behind the row; `1` for a normal stage run. */
  taskCount: number
  /** Ledger rows aggregated here. Normally equal to `taskCount`; the gap is the rows
   * whose task no longer exists, which cannot be counted as tasks. */
  entryCount: number
  /** Tasks that needed more than one attempt to pass the quality gate. Failures are not
   * reportable from the ledger at all — a failed task never writes an entry — so they
   * belong to the task listing, not here. */
  retriedTaskCount: number
  inputUnits: number
  outputUnits: number
  /** What the organization is bound to for this stage right now, which is not necessarily
   * what it was bound to when the usage was spent. Null when the model has since been
   * unbound, unverified or disabled, or when the stage has no slot to look at. */
  binding: UsageBindingDto | null
}

interface UsageReportDto {
  rows: UsageRowDto[]
  total: { taskCount: number; entryCount: number; retriedTaskCount: number; inputUnits: number; outputUnits: number }
  /** What the unit columns mean. The only unit statement this API makes; there is no
   * second one anywhere, and a reader that needs a price has come to the wrong repository. */
  units: { input: 'prompt_characters'; output: 'bytes' }
}

// Stage → slot, mirroring the pipeline's own (unexported) `stageSlots`. Drift here only
// ever mislabels the `binding` column of a report; it cannot spend anything.
const stageSlots: Partial<Record<Stage, CapabilitySlot>> = {
  SCRIPT: 'script_text',
  STORYBOARD: 'storyboard_text',
  ASSET: 'image_gen',
  FIRST_FRAME: 'image_gen',
  AUDIO: 'tts_voice',
  MUSIC: 'music_gen',
}

// `VIDEO` is the one stage whose slot depends on what the model was handed — text, a first
// frame, or reference images — so it is read off the entry's own modality rather than
// pinned to a single slot here.
const videoSlots: Partial<Record<string, CapabilitySlot>> = {
  t2v: 'video_t2v',
  i2v: 'video_i2v',
  r2v: 'video_r2v',
}

function slotFor(stage: Stage | null, modality: string): CapabilitySlot | null {
  if (stage === null) return null
  if (stage === 'VIDEO') return videoSlots[modality] ?? null
  return stageSlots[stage] ?? null
}

type DateFilter = { ok: true; value: Date | null } | { ok: false; error: string }

function parseDate(value: string | undefined, field: string): DateFilter {
  if (value === undefined || value === '') return { ok: true, value: null }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return { ok: false, error: `${field} must be an ISO date` }
  return { ok: true, value: parsed }
}

interface TaskUsage {
  id: string
  stage: Stage
  attempts: number
  episodeId: string
  projectId: string
}

/** One stage × provider × model bucket, accumulated over the ledger rows that fall in it. */
interface Group {
  stage: Stage | null
  provider: string
  model: string
  modality: string
  taskIds: Set<string>
  retriedTaskIds: Set<string>
  entryCount: number
  inputUnits: number
  outputUnits: number
}

export async function usageRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { projectId?: string; episodeId?: string; from?: string; to?: string } }>(
    '/usage',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const projectId = request.query.projectId
      const episodeId = request.query.episodeId

      const from = parseDate(request.query.from, 'from')
      const to = parseDate(request.query.to, 'to')
      if (!from.ok) return reply.code(400).send({ error: from.error })
      if (!to.ok) return reply.code(400).send({ error: to.error })
      if (from.value && to.value && from.value.getTime() > to.value.getTime()) {
        return reply.code(400).send({ error: 'from must not be after to' })
      }

      // An id is checked against the caller's organization before it narrows anything, so
      // another tenant's project answers exactly as it does on every other route.
      let bindingProjectId: string | null = projectId ?? null
      if (projectId) {
        const project = await app.db.project.findFirst({ where: { id: projectId, organizationId: auth.organizationId }, select: { id: true } })
        if (!project) return reply.code(404).send({ error: 'Project not found' })
      }
      if (episodeId) {
        const episode = await app.db.episode.findFirst({ where: { id: episodeId, project: { organizationId: auth.organizationId } }, select: { id: true, projectId: true } })
        if (!episode) return reply.code(404).send({ error: 'Episode not found' })
        // An episode query is a project query one level down: the binding that would have
        // served it is the project's, not the organization's.
        bindingProjectId ??= episode.projectId
      }

      // `(organizationId, createdAt)` is the ledger's only index, and this is the query it
      // was made for: the window bounds the read, and the join to the task side is done in
      // memory because a ledger entry deliberately carries no project of its own.
      const entries = await app.db.usageLedger.findMany({
        where: {
          organizationId: auth.organizationId,
          ...(from.value || to.value
            ? { createdAt: { ...(from.value ? { gte: from.value } : {}), ...(to.value ? { lte: to.value } : {}) } }
            : {}),
        },
        select: { taskId: true, provider: true, model: true, modality: true, inputUnits: true, outputUnits: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })

      const taskIds = [...new Set(entries.map(entry => entry.taskId).filter((id): id is string => id !== null))]
      const taskRows = taskIds.length === 0
        ? []
        : await app.db.generationTask.findMany({
            where: { id: { in: taskIds }, organizationId: auth.organizationId },
            select: { id: true, stage: true, attempts: true, batch: { select: { episode: { select: { id: true, projectId: true } } } } },
          })
      const taskById = new Map<string, TaskUsage>(
        taskRows.map(task => [task.id, {
          id: task.id,
          stage: task.stage,
          attempts: task.attempts,
          episodeId: task.batch.episode.id,
          projectId: task.batch.episode.projectId,
        }]),
      )

      const groups = new Map<string, Group>()
      for (const entry of entries) {
        const task = entry.taskId ? taskById.get(entry.taskId) ?? null : null
        if (projectId && task?.projectId !== projectId) continue
        if (episodeId && task?.episodeId !== episodeId) continue
        const stage = task?.stage ?? null
        const key = `${stage ?? '-'}\u0000${entry.provider}\u0000${entry.model}`
        let group = groups.get(key)
        if (!group) {
          group = { stage, provider: entry.provider, model: entry.model, modality: entry.modality, taskIds: new Set(), retriedTaskIds: new Set(), entryCount: 0, inputUnits: 0, outputUnits: 0 }
          groups.set(key, group)
        }
        group.entryCount += 1
        group.inputUnits += entry.inputUnits
        group.outputUnits += entry.outputUnits
        if (!task) continue
        group.taskIds.add(task.id)
        // `attempts` is the attempt number the task last ran as, so anything above 1 is a
        // run the quality gate sent back for a rework before it passed.
        if (task.attempts > 1) group.retriedTaskIds.add(task.id)
      }

      const candidateCache = new Map<CapabilitySlot, SlotCandidate[]>()
      async function candidatesFor(slot: CapabilitySlot): Promise<SlotCandidate[]> {
        const cached = candidateCache.get(slot)
        if (cached) return cached
        const candidates = await resolveSlotCandidates(app.db, auth.organizationId, bindingProjectId, slot)
        candidateCache.set(slot, candidates)
        return candidates
      }

      const ordered = [...groups.values()].sort(
        (a, b) =>
          (a.stage === null ? 1 : b.stage === null ? -1 : 0) ||
          String(a.stage ?? '').localeCompare(String(b.stage ?? '')) ||
          a.provider.localeCompare(b.provider) ||
          a.model.localeCompare(b.model),
      )

      const rows: UsageRowDto[] = []
      for (const group of ordered) {
        const slot = slotFor(group.stage, group.modality)
        // Only the connection's public identity is read out of the candidate; the resolver
        // never returns a secret, and nothing here asks for one.
        const match = slot
          ? (await candidatesFor(slot)).find(candidate => candidate.provider === group.provider && candidate.model === group.model)
          : undefined
        rows.push({
          stage: group.stage === null ? null : toApiStage(group.stage),
          provider: group.provider,
          model: group.model,
          modality: group.modality,
          taskCount: group.taskIds.size,
          entryCount: group.entryCount,
          retriedTaskCount: group.retriedTaskIds.size,
          inputUnits: group.inputUnits,
          outputUnits: group.outputUnits,
          binding: match && slot ? { slot, connectionId: match.connectionId, connectionName: match.connectionName, scope: match.scope } : null,
        })
      }

      const report: UsageReportDto = {
        rows,
        total: {
          taskCount: rows.reduce((sum, row) => sum + row.taskCount, 0),
          entryCount: rows.reduce((sum, row) => sum + row.entryCount, 0),
          retriedTaskCount: rows.reduce((sum, row) => sum + row.retriedTaskCount, 0),
          inputUnits: rows.reduce((sum, row) => sum + row.inputUnits, 0),
          outputUnits: rows.reduce((sum, row) => sum + row.outputUnits, 0),
        },
        units: { input: 'prompt_characters', output: 'bytes' },
      }
      return report
    },
  )
}
