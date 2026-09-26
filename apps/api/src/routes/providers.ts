import type { FastifyInstance } from 'fastify'
import { Prisma, type PrismaClient } from '@studio/db'
import { modelModalities, isModelModality, reduceCallEvidence, type ModelCapability as DomainCapability, type ModelModality } from '@studio/domain'
import { createAdapter, getCatalog, isKnownProvider, listCatalogs, type CatalogModel, type ProviderAdapter, type ProviderCatalog } from '@studio/providers'
import { decryptSecret, encryptSecret } from '@studio/security'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'
import { checkProviderBaseUrl } from '../lib/providerUrl.js'

interface ConnectionBody {
  provider?: string
  name?: string
  apiKey?: string
  accessKey?: string
  baseUrl?: string
  enabled?: boolean
}

interface ModelBody {
  model?: string
  displayName?: string
  modality?: string
  acceptsFirstFrame?: boolean
  acceptsReferenceImages?: boolean
  maxReferenceImages?: number
}

/** A hand-entered row is a claim about one model, so the claim stays as narrow as our own catalog's widest. */
const MAX_ENTERED_REFERENCE_IMAGES = 8

export async function providerRoutes(app: FastifyInstance): Promise<void> {
  /** Both probes speak to the same vendor with the same credentials; only the unit of verification differs. */
  async function adapterFor(connection: ConnectionSecrets): Promise<ProviderAdapter> {
    const apiKey = decryptSecret(connection.encryptedSecret, app.config.masterKey)
    const accessKey = connection.accessKeyEncrypted ? decryptSecret(connection.accessKeyEncrypted, app.config.masterKey) : undefined
    return createAdapter(connection.provider, { apiKey, accessKey, baseUrl: connection.baseUrl })
  }

  app.get('/providers/catalogs', { preHandler: requirePermission('read') }, async request => {
    const auth = request.auth!
    const overlay = await loadOverlay(app.db, auth.organizationId)
    return listCatalogs()
      .map(catalog => mergeCatalog(catalog, overlay))
      .filter((catalog): catalog is EffectiveCatalog => catalog !== null)
      .map(catalog => ({
        provider: catalog.provider,
        label: catalog.label,
        defaultBaseUrl: catalog.defaultBaseUrl,
        catalogVersion: catalog.catalogVersion,
        requiresAccessKey: catalog.requiresAccessKey,
        models: catalog.models,
      }))
  })

  /** The recycle bin for the overlay: what this org hid, so the UI can offer restore. */
  app.get('/providers/catalogs/hidden', { preHandler: requirePermission('read') }, async request => {
    const auth = request.auth!
    const overlay = await loadOverlay(app.db, auth.organizationId)
    const providers = overlay.hidden
      .filter(row => row.model === '')
      .map(row => ({ provider: row.provider, label: getCatalog(row.provider)?.label ?? row.provider }))
    const models = overlay.hidden
      .filter(row => row.model !== '')
      .map(row => {
        const catalog = getCatalog(row.provider)
        const official = catalog?.models.find(model => model.model === row.model)
        const custom = overlay.custom.find(entry => entry.provider === row.provider && entry.model === row.model)
        return { provider: row.provider, model: row.model, displayName: official?.displayName ?? custom?.displayName ?? row.model }
      })
    return { providers, models }
  })

  /**
   * Hides a vendor card (no model in the body) or every row filed under a model id.
   * Official rows re-ship with every release, so delete-by-hide is the only honest
   * semantics: a hard delete would silently return on the next deploy.
   */
  app.post<{ Params: { provider: string }; Body: { model?: string } }>(
    '/providers/catalogs/:provider/hide',
    { preHandler: requirePermission('providers:manage') },
    async (request, reply) => {
      const auth = request.auth!
      const provider = request.params.provider
      const catalog = getCatalog(provider)
      if (!catalog) return reply.code(400).send({ error: 'provider must be one of the known catalogs' })
      const model = request.body?.model?.trim() ?? ''
      if (model) {
        const known = catalog.models.some(entry => entry.model === model)
          || await app.db.catalogCustomModel.findFirst({ where: { organizationId: auth.organizationId, provider, model } })
        if (!known) return reply.code(404).send({ error: `model "${model}" is not in the ${provider} catalog` })
      }
      await app.db.catalogHidden.upsert({
        where: { organizationId_provider_model: { organizationId: auth.organizationId, provider, model } },
        create: { organizationId: auth.organizationId, provider, model },
        update: {},
      })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'catalog.hide', entityType: 'CatalogHidden', entityId: `${provider}:${model || '*'}`, payload: { provider, model: model || null } })
      return reply.code(204).send()
    },
  )

  app.delete<{ Params: { provider: string } }>(
    '/providers/catalogs/:provider/hide',
    { preHandler: requirePermission('providers:manage') },
    async (request, reply) => {
      const auth = request.auth!
      const provider = request.params.provider
      const model = (request.query as { model?: string }).model?.trim() ?? ''
      const removed = await app.db.catalogHidden.deleteMany({ where: { organizationId: auth.organizationId, provider, model } })
      if (removed.count === 0) return reply.code(404).send({ error: 'nothing hidden under this provider/model' })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'catalog.unhide', entityType: 'CatalogHidden', entityId: `${provider}:${model || '*'}`, payload: { provider, model: model || null } })
      return reply.code(204).send()
    },
  )

  /**
   * The org's own row for a model the code catalog does not carry yet — a release so
   * new we have not shipped it, or a gateway's checkpoint under the protocol entry.
   * Same (provider, model, modality) as an official row shadows it, so a stale
   * official flag can be corrected without waiting for a release.
   */
  app.post<{ Params: { provider: string }; Body: ModelBody }>(
    '/providers/catalogs/:provider/models',
    { preHandler: requirePermission('providers:manage') },
    async (request, reply) => {
      const auth = request.auth!
      const provider = request.params.provider
      if (!isKnownProvider(provider)) return reply.code(400).send({ error: 'provider must be one of the known catalogs' })
      const parsed = parseModelBody(request.body)
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error })
      try {
        const entry = await app.db.catalogCustomModel.create({
          data: { organizationId: auth.organizationId, provider, ...parsed.data },
        })
        await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'catalog.model.add', entityType: 'CatalogCustomModel', entityId: entry.id, payload: { provider, model: entry.model, modality: entry.modality } })
        return reply.code(201).send(entry)
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          return reply.code(409).send({ error: `model "${parsed.data.model}" is already in the ${provider} catalog for the "${parsed.data.modality}" modality` })
        }
        throw error
      }
    },
  )

  app.delete<{ Params: { entryId: string } }>(
    '/providers/catalogs/entries/:entryId',
    { preHandler: requirePermission('providers:manage') },
    async (request, reply) => {
      const auth = request.auth!
      const entry = await app.db.catalogCustomModel.findFirst({ where: { id: request.params.entryId, organizationId: auth.organizationId } })
      if (!entry) return reply.code(404).send({ error: 'catalog entry not found' })
      await app.db.catalogCustomModel.delete({ where: { id: entry.id } })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'catalog.model.delete', entityType: 'CatalogCustomModel', entityId: entry.id, payload: { provider: entry.provider, model: entry.model, modality: entry.modality } })
      return reply.code(204).send()
    },
  )

  app.get('/providers/connections', { preHandler: requirePermission('read') }, async request => {
    const auth = request.auth!
    const connections = await app.db.providerConnection.findMany({
      where: { organizationId: auth.organizationId },
      orderBy: { createdAt: 'desc' },
      include: { capabilities: { orderBy: { model: 'asc' } } },
    })
    return connections.map(({ encryptedSecret, accessKeyEncrypted, ...rest }) => ({ ...rest, apiKeySet: encryptedSecret.length > 0, accessKeySet: Boolean(accessKeyEncrypted) }))
  })

  /**
   * 探测时间戳只证明「曾经通过」：额度用尽、权限被收回之后它不会自己变红。
   * 就绪度面板要报「现在跑不跑得通」，只能对着真实调用履历算。
   */
  app.get('/providers/call-evidence', { preHandler: requirePermission('read') }, async request => {
    const auth = request.auth!
    const tasks = await app.db.generationTask.findMany({
      where: { organizationId: auth.organizationId, status: { in: ['SUCCEEDED', 'FAILED'] } },
      select: { provider: true, model: true, status: true, errorSnapshot: true, updatedAt: true },
    })
    return Object.fromEntries(reduceCallEvidence(tasks))
  })

  app.post<{ Body: ConnectionBody }>('/providers/connections', { preHandler: requirePermission('providers:manage') }, async (request, reply) => {
    const auth = request.auth!
    const provider = request.body?.provider?.trim()
    const name = request.body?.name?.trim()
    const apiKey = request.body?.apiKey
    const accessKey = request.body?.accessKey
    if (!provider || !isKnownProvider(provider)) return reply.code(400).send({ error: 'provider must be one of the known catalogs' })
    if (!name) return reply.code(400).send({ error: 'name is required' })
    if (!apiKey) return reply.code(400).send({ error: 'apiKey is required' })

    const catalog = getCatalog(provider)!
    // Half a key pair can never be probed or run, and the adapter only reports it at call time.
    if (catalog.requiresAccessKey && !accessKey) return reply.code(400).send({ error: `${provider} signs requests with an access key + secret key pair, so accessKey is required as well as apiKey` })

    const suppliedBaseUrl = request.body?.baseUrl?.trim()
    // Only a hand-typed address is checked; every catalog's own default is ours to
    // begin with, and refusing it would make the provider unusable rather than safe.
    if (suppliedBaseUrl) {
      const checked = checkBaseUrl(provider, suppliedBaseUrl, app.config.allowPrivateProviderUrls)
      if (!checked.ok) return reply.code(400).send({ error: checked.error })
    }
    const baseUrl = suppliedBaseUrl || catalog.defaultBaseUrl
    if (!baseUrl) return reply.code(400).send({ error: `${provider} is a protocol rather than a vendor, so baseUrl is required` })
    const existing = await app.db.providerConnection.findUnique({ where: { organizationId_name: { organizationId: auth.organizationId, name } } })
    if (existing) return reply.code(409).send({ error: 'a connection with this name already exists' })

    // Seed from what the org actually sees: hidden models stay out, custom rows ride
    // along. Curating the overlay once keeps every new connection from dragging in
    // the vendor's whole list of rows the org will never bind.
    const effectiveModels = mergeCatalog(catalog, await loadOverlay(app.db, auth.organizationId))?.models ?? []
    const connection = await app.db.providerConnection.create({
      data: {
        organizationId: auth.organizationId,
        provider,
        name,
        baseUrl,
        encryptedSecret: encryptSecret(apiKey, app.config.masterKey),
        accessKeyEncrypted: accessKey ? encryptSecret(accessKey, app.config.masterKey) : null,
        capabilities: { create: effectiveModels.map(toCapabilityData) },
      },
      include: { capabilities: true },
    })
    await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'provider.create', entityType: 'ProviderConnection', entityId: connection.id, payload: { provider, name, models: connection.capabilities.length } })
    return reply.code(201).send({ ...connection, encryptedSecret: undefined, accessKeyEncrypted: undefined, apiKeySet: true, accessKeySet: Boolean(accessKey) })
  })

  app.patch<{ Params: { connectionId: string }; Body: ConnectionBody }>(
    '/providers/connections/:connectionId',
    { preHandler: requirePermission('providers:manage') },
    async (request, reply) => {
      const auth = request.auth!
      const connection = await app.db.providerConnection.findFirst({ where: { id: request.params.connectionId, organizationId: auth.organizationId } })
      if (!connection) return reply.code(404).send({ error: 'connection not found' })

      const data: { name?: string; baseUrl?: string; encryptedSecret?: string; accessKeyEncrypted?: string; enabled?: boolean } = {}
      if (request.body?.name !== undefined) {
        const name = request.body.name.trim()
        if (!name) return reply.code(400).send({ error: 'name cannot be empty' })
        data.name = name
      }
      if (request.body?.baseUrl !== undefined) {
        const checked = checkBaseUrl(connection.provider, request.body.baseUrl, app.config.allowPrivateProviderUrls)
        if (!checked.ok) return reply.code(400).send({ error: checked.error })
        data.baseUrl = checked.url!
      }
      if (request.body?.enabled !== undefined) data.enabled = request.body.enabled
      if (request.body?.apiKey) data.encryptedSecret = encryptSecret(request.body.apiKey, app.config.masterKey)
      if (request.body?.accessKey) data.accessKeyEncrypted = encryptSecret(request.body.accessKey, app.config.masterKey)

      const updated = await app.db.providerConnection.update({ where: { id: connection.id }, data })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'provider.update', entityType: 'ProviderConnection', entityId: connection.id, payload: { fields: Object.keys(data), keyRotated: data.encryptedSecret !== undefined } })
      return { ...updated, encryptedSecret: undefined, accessKeyEncrypted: undefined }
    },
  )

  app.delete<{ Params: { connectionId: string } }>(
    '/providers/connections/:connectionId',
    { preHandler: requirePermission('providers:manage') },
    async (request, reply) => {
      const auth = request.auth!
      const connection = await app.db.providerConnection.findFirst({ where: { id: request.params.connectionId, organizationId: auth.organizationId } })
      if (!connection) return reply.code(404).send({ error: 'connection not found' })
      const bindings = await app.db.capabilityBinding.count({ where: { capability: { connectionId: connection.id } } })
      if (bindings > 0) return reply.code(409).send({ error: `connection still referenced by ${bindings} capability binding(s); unbind first` })
      await app.db.providerConnection.delete({ where: { id: connection.id } })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'provider.delete', entityType: 'ProviderConnection', entityId: connection.id, payload: { provider: connection.provider, name: connection.name } })
      return reply.code(204).send()
    },
  )

  app.post<{ Params: { connectionId: string } }>(
    '/providers/connections/:connectionId/probe',
    { preHandler: requirePermission('providers:manage') },
    async (request, reply) => {
      const auth = request.auth!
      const connection = await app.db.providerConnection.findFirst({
        where: { id: request.params.connectionId, organizationId: auth.organizationId },
        include: { capabilities: true },
      })
      if (!connection) return reply.code(404).send({ error: 'connection not found' })
      if (!connection.enabled) return reply.code(409).send({ error: 'connection is disabled' })

      const adapter = await adapterFor(connection)
      const results = []
      let anyFailure = false
      for (const capability of connection.capabilities) {
        const result = await adapter.probe(domainCapability(connection, capability))
        anyFailure = anyFailure || !result.ok
        await app.db.modelCapability.update({
          where: { id: capability.id },
          data: {
            probeStatus: result.ok ? 'verified' : 'failed',
            probeMessage: result.message ?? null,
            lastProbedAt: new Date(),
            // The credential probe never addresses this model — it pings a hardcoded
            // model name to prove the key. It must not claim model-level entitlement.
            credentialVerifiedAt: result.ok ? new Date() : null,
          },
        })
        results.push({ capabilityId: capability.id, model: capability.model, modality: capability.modality, ...result })
      }

      await app.db.providerConnection.update({ where: { id: connection.id }, data: { lastError: anyFailure ? results.find(r => !r.ok)?.message ?? 'probe failed' : null } })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'provider.probe', entityType: 'ProviderConnection', entityId: connection.id, payload: { probed: results.length, failures: results.filter(r => !r.ok).length } })
      return { connectionId: connection.id, results }
    },
  )

  /**
   * The catalogs describe vendors we can name. This is how an operator adds the model
   * we cannot: a fine-tune, a private checkpoint, or anything behind an
   * OpenAI-compatible gateway, whose catalog is empty by definition.
   */
  app.post<{ Params: { connectionId: string }; Body: ModelBody }>(
    '/providers/connections/:connectionId/models',
    { preHandler: requirePermission('providers:manage') },
    async (request, reply) => {
      const auth = request.auth!
      const connection = await app.db.providerConnection.findFirst({ where: { id: request.params.connectionId, organizationId: auth.organizationId } })
      if (!connection) return reply.code(404).send({ error: 'connection not found' })

      const parsed = parseModelBody(request.body)
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error })

      try {
        const capability = await app.db.modelCapability.create({
          data: { connectionId: connection.id, ...parsed.data },
        })
        await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'provider.model.add', entityType: 'ModelCapability', entityId: capability.id, payload: { connectionId: connection.id, provider: connection.provider, model: capability.model, modality: capability.modality } })
        return reply.code(201).send(capability)
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          return reply.code(409).send({ error: `model "${parsed.data.model}" is already configured on this connection for the "${parsed.data.modality}" modality` })
        }
        throw error
      }
    },
  )

  app.delete<{ Params: { capabilityId: string } }>(
    '/providers/capabilities/:capabilityId',
    { preHandler: requirePermission('providers:manage') },
    async (request, reply) => {
      const auth = request.auth!
      const capability = await findCapability(app.db, request.params.capabilityId, auth.organizationId)
      if (!capability) return reply.code(404).send({ error: 'capability not found' })
      const bindings = await app.db.capabilityBinding.count({ where: { capabilityId: capability.id } })
      if (bindings > 0) return reply.code(409).send({ error: `model "${capability.model}" is still bound to ${bindings} slot(s); unbind first` })
      await app.db.modelCapability.delete({ where: { id: capability.id } })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'provider.model.delete', entityType: 'ModelCapability', entityId: capability.id, payload: { connectionId: capability.connectionId, model: capability.model, modality: capability.modality } })
      return reply.code(204).send()
    },
  )

  /**
   * One named model, one call.
   *
   * Only the chat family can be verified this cheaply, so the rest is answered with a
   * refusal rather than a check mark: an image, video or audio endpoint has no request
   * that is both addressed to a model and free, and lighting up a row we have not earn-
   * ed is the exact failure this feature exists to prevent. Those rows are proven by the
   * first real generation, which the worker records on its own.
   */
  app.post<{ Params: { capabilityId: string } }>(
    '/providers/capabilities/:capabilityId/probe',
    { preHandler: requirePermission('providers:manage') },
    async (request, reply) => {
      const auth = request.auth!
      const capability = await findCapability(app.db, request.params.capabilityId, auth.organizationId)
      if (!capability) return reply.code(404).send({ error: 'capability not found' })
      const connection = await app.db.providerConnection.findFirst({ where: { id: capability.connectionId, organizationId: auth.organizationId } })
      if (!connection) return reply.code(404).send({ error: 'connection not found' })
      if (!connection.enabled) return reply.code(409).send({ error: 'connection is disabled' })

      if (capability.modality !== 'text' && capability.modality !== 'vlm') {
        // 生成类模态(图/视频/配音/音乐)没有"免费点名"请求,但用户需要能对单行
        // 做密钥级定向探测(比如手动新增一个视频模型后):发一条密钥测试消息,
        // 只盖 credentialVerifiedAt,不碰该模型的生成额度。模型权限仍由首次
        // 真实生成验证。
        const adapter = await adapterFor(connection)
        const result = await adapter.probe(domainCapability(connection, capability))
        await app.db.modelCapability.update({
          where: { id: capability.id },
          data: {
            probeStatus: result.ok ? 'verified' : 'failed',
            probeMessage: result.message ?? null,
            lastProbedAt: new Date(),
            credentialVerifiedAt: result.ok ? new Date() : null,
          },
        })
        await app.db.providerConnection.update({ where: { id: connection.id }, data: { lastError: result.ok ? null : result.message ?? 'probe failed' } })
        await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'provider.model.probe', entityType: 'ModelCapability', entityId: capability.id, payload: { model: capability.model, modality: capability.modality, ok: result.ok, status: result.status, tier: 'credential' } })
        return { capabilityId: capability.id, model: capability.model, modality: capability.modality, ...result }
      }

      const adapter = await adapterFor(connection)
      if (!adapter.verifyModel) {
        return reply.code(400).send({ error: `${connection.provider} offers no request that names a single model without generating from it — one real generation will verify it` })
      }

      const result = await adapter.verifyModel(domainCapability(connection, capability))
      await app.db.modelCapability.update({
        where: { id: capability.id },
        data: {
          probeStatus: result.ok ? 'verified' : 'failed',
          probeMessage: result.message ?? null,
          lastProbedAt: new Date(),
          // Success earns the stamp because this call was addressed to this model. A
          // failure removes it only where the endpoint proved the row wrong; a timeout
          // or a 429 says nothing about the model, and revoking on that would break a
          // working production line because of a bad minute.
          entitlementVerifiedAt: result.ok ? new Date() : result.modelMissing ? null : undefined,
        },
      })
      await app.db.providerConnection.update({ where: { id: connection.id }, data: { lastError: result.ok ? null : result.message ?? 'probe failed' } })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'provider.model.probe', entityType: 'ModelCapability', entityId: capability.id, payload: { model: capability.model, modality: capability.modality, ok: result.ok, status: result.status, modelMissing: result.modelMissing ?? false } })
      return { capabilityId: capability.id, model: capability.model, modality: capability.modality, ...result }
    },
  )
}

interface ConnectionSecrets {
  provider: string
  baseUrl: string
  encryptedSecret: string
  accessKeyEncrypted: string | null
}

interface CapabilityRow {
  model: string
  modality: string
  acceptsFirstFrame: boolean
  acceptsReferenceImages: boolean
  maxReferenceImages: number
}

/**
 * A capability is never addressed directly — ownership runs through its connection, so
 * one lookup cannot leak another organisation's row as a 404-vs-200 difference either.
 */
async function findCapability(db: PrismaClient, capabilityId: string, organizationId: string) {
  return db.modelCapability.findFirst({ where: { id: capabilityId, connection: { organizationId } } })
}

function domainCapability(connection: { provider: string }, capability: CapabilityRow): DomainCapability {
  return {
    provider: connection.provider,
    model: capability.model,
    modality: capability.modality as ModelModality,
    acceptsFirstFrame: capability.acceptsFirstFrame,
    acceptsReferenceImages: capability.acceptsReferenceImages,
    maxReferenceImages: capability.maxReferenceImages,
  }
}

/**
 * Which connections get their address checked. The adapter is picked by provider and
 * the mock one never opens a socket, so a mock baseUrl is a label rather than an
 * address — checking it would only reject the `mock://local` the catalog ships.
 */
function checkBaseUrl(provider: string, supplied: string, allowPrivate: boolean) {
  if (provider === 'mock') return { ok: true as const, url: supplied.trim() }
  return checkProviderBaseUrl(supplied, { allowPrivate })
}

function toCapabilityData(model: CatalogModel) {
  return {
    model: model.model,
    displayName: model.displayName,
    modality: model.modality,
    acceptsFirstFrame: model.acceptsFirstFrame ?? false,
    acceptsReferenceImages: model.acceptsReferenceImages ?? false,
    maxReferenceImages: model.maxReferenceImages ?? 0,
    spec: model.spec === undefined ? undefined : (model.spec as Prisma.InputJsonValue),
  }
}

interface Overlay {
  hidden: Array<{ provider: string; model: string }>
  custom: Array<{ id: string; provider: string; model: string; displayName: string | null; modality: string; acceptsFirstFrame: boolean; acceptsReferenceImages: boolean; maxReferenceImages: number }>
}

/** The org's edits to the code-shipped catalogs, in one read. */
async function loadOverlay(db: PrismaClient, organizationId: string): Promise<Overlay> {
  const [hidden, custom] = await Promise.all([
    db.catalogHidden.findMany({ where: { organizationId }, select: { provider: true, model: true } }),
    db.catalogCustomModel.findMany({
      where: { organizationId },
      select: { id: true, provider: true, model: true, displayName: true, modality: true, acceptsFirstFrame: true, acceptsReferenceImages: true, maxReferenceImages: true },
    }),
  ])
  return { hidden, custom }
}

interface OverlayRow extends CatalogModel {
  source: 'official' | 'custom'
  entryId?: string
}

interface EffectiveCatalog {
  provider: string
  label: string
  defaultBaseUrl?: string
  catalogVersion: string
  requiresAccessKey?: boolean
  models: OverlayRow[]
}

/**
 * The view an org sees of one vendor catalog: official rows minus what was hidden,
 * plus custom rows — a custom (provider, model, modality) shadows the official row
 * it matches, so a stale official flag yields to the org's correction. Returns null
 * when the org hid the vendor card itself.
 */
function mergeCatalog(catalog: ProviderCatalog, overlay: Overlay): EffectiveCatalog | null {
  if (overlay.hidden.some(row => row.provider === catalog.provider && row.model === '')) return null
  const hiddenModels = new Set(overlay.hidden.filter(row => row.provider === catalog.provider).map(row => row.model))
  const customs = overlay.custom.filter(row => row.provider === catalog.provider)
  const shadowed = new Set(customs.map(row => `${row.model}:${row.modality}`))
  const official = catalog.models
    .filter(model => !hiddenModels.has(model.model) && !shadowed.has(`${model.model}:${model.modality}`))
    .map(model => ({ ...model, source: 'official' as const }))
  const customRows = customs
    .filter(row => !hiddenModels.has(row.model))
    .map(row => ({
      model: row.model,
      displayName: row.displayName ?? row.model,
      modality: row.modality as ModelModality,
      acceptsFirstFrame: row.acceptsFirstFrame,
      acceptsReferenceImages: row.acceptsReferenceImages,
      maxReferenceImages: row.maxReferenceImages,
      source: 'custom' as const,
      entryId: row.id,
    }))
  return { ...catalog, models: [...official, ...customRows] }
}

type ParsedModelBody =
  | { ok: false; error: string }
  | { ok: true; data: { model: string; displayName: string | null; modality: ModelModality; acceptsFirstFrame: boolean; acceptsReferenceImages: boolean; maxReferenceImages: number } }

/**
 * One validator for every hand-entered model row, whether it lands on a connection
 * or in the org's catalog overlay — the claims must stay equally narrow in both.
 */
function parseModelBody(body: ModelBody | undefined): ParsedModelBody {
  const model = body?.model?.trim()
  if (!model) return { ok: false, error: 'model is required' }
  if (model.length > 120) return { ok: false, error: 'model must be 120 characters or fewer' }
  const modality = body?.modality
  if (!isModelModality(modality)) return { ok: false, error: `modality must be one of: ${modelModalities.join(', ')}` }

  const maxReferenceImages = body?.maxReferenceImages ?? 0
  if (!Number.isInteger(maxReferenceImages) || maxReferenceImages < 0 || maxReferenceImages > MAX_ENTERED_REFERENCE_IMAGES) {
    return { ok: false, error: `maxReferenceImages must be a whole number between 0 and ${MAX_ENTERED_REFERENCE_IMAGES}` }
  }
  const acceptsFirstFrame = Boolean(body?.acceptsFirstFrame)
  const acceptsReferenceImages = Boolean(body?.acceptsReferenceImages)
  // Refusing beats dropping: a row that quietly lost the flag the operator set would
  // fail at generation time with a message about reference media, far from here.
  // First frames stay a video dialect, but reference images are not: qwen-image-edit
  // is an image model that draws its subject from approved asset sheets, so an image
  // row may declare references — it just may not take a video's starting frame.
  if (modality !== 'i2v' && modality !== 'r2v' && modality !== 'image' && (acceptsFirstFrame || acceptsReferenceImages || maxReferenceImages > 0)) {
    return { ok: false, error: `first-frame and reference input describe video or image models, not a "${modality}" one` }
  }
  if (modality !== 'i2v' && modality !== 'r2v' && acceptsFirstFrame) {
    return { ok: false, error: `a first frame is video conditioning, not something a "${modality}" model takes` }
  }
  const displayName = body?.displayName?.trim()
  if (displayName && displayName.length > 120) return { ok: false, error: 'displayName must be 120 characters or fewer' }
  return { ok: true, data: { model, displayName: displayName || null, modality, acceptsFirstFrame, acceptsReferenceImages, maxReferenceImages } }
}
