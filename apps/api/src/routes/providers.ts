import type { FastifyInstance } from 'fastify'
import { Prisma, type PrismaClient } from '@studio/db'
import { modelModalities, isModelModality, type ModelCapability as DomainCapability, type ModelModality } from '@studio/domain'
import { createAdapter, getCatalog, isKnownProvider, listCatalogs, type CatalogModel, type ProviderAdapter } from '@studio/providers'
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

  app.get('/providers/catalogs', { preHandler: requirePermission('read') }, async () => {
    return listCatalogs().map(catalog => ({
      provider: catalog.provider,
      label: catalog.label,
      defaultBaseUrl: catalog.defaultBaseUrl,
      catalogVersion: catalog.catalogVersion,
      requiresAccessKey: catalog.requiresAccessKey,
      models: catalog.models,
    }))
  })

  app.get('/providers/connections', { preHandler: requirePermission('read') }, async request => {
    const auth = request.auth!
    const connections = await app.db.providerConnection.findMany({
      where: { organizationId: auth.organizationId },
      orderBy: { createdAt: 'desc' },
      include: { capabilities: { orderBy: { model: 'asc' } } },
    })
    return connections.map(({ encryptedSecret, accessKeyEncrypted, ...rest }) => ({ ...rest, apiKeySet: encryptedSecret.length > 0, accessKeySet: Boolean(accessKeyEncrypted) }))
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

    const connection = await app.db.providerConnection.create({
      data: {
        organizationId: auth.organizationId,
        provider,
        name,
        baseUrl,
        encryptedSecret: encryptSecret(apiKey, app.config.masterKey),
        accessKeyEncrypted: accessKey ? encryptSecret(accessKey, app.config.masterKey) : null,
        capabilities: { create: catalog.models.map(toCapabilityData) },
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
            entitlementVerifiedAt: result.ok ? new Date() : null,
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

      const model = request.body?.model?.trim()
      if (!model) return reply.code(400).send({ error: 'model is required' })
      if (model.length > 120) return reply.code(400).send({ error: 'model must be 120 characters or fewer' })
      const modality = request.body?.modality
      if (!isModelModality(modality)) return reply.code(400).send({ error: `modality must be one of: ${modelModalities.join(', ')}` })

      const maxReferenceImages = request.body?.maxReferenceImages ?? 0
      if (!Number.isInteger(maxReferenceImages) || maxReferenceImages < 0 || maxReferenceImages > MAX_ENTERED_REFERENCE_IMAGES) {
        return reply.code(400).send({ error: `maxReferenceImages must be a whole number between 0 and ${MAX_ENTERED_REFERENCE_IMAGES}` })
      }
      const acceptsFirstFrame = Boolean(request.body?.acceptsFirstFrame)
      const acceptsReferenceImages = Boolean(request.body?.acceptsReferenceImages)
      // Refusing beats dropping: a row that quietly lost the flag the operator set would
      // fail at generation time with a message about reference media, far from here.
      if (modality !== 'i2v' && modality !== 'r2v' && (acceptsFirstFrame || acceptsReferenceImages || maxReferenceImages > 0)) {
        return reply.code(400).send({ error: `first-frame and reference input describe video models, not a "${modality}" one` })
      }
      const displayName = request.body?.displayName?.trim()
      if (displayName && displayName.length > 120) return reply.code(400).send({ error: 'displayName must be 120 characters or fewer' })

      try {
        const capability = await app.db.modelCapability.create({
          data: {
            connectionId: connection.id,
            model,
            displayName: displayName || null,
            modality,
            acceptsFirstFrame,
            acceptsReferenceImages,
            maxReferenceImages,
          },
        })
        await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'provider.model.add', entityType: 'ModelCapability', entityId: capability.id, payload: { connectionId: connection.id, provider: connection.provider, model, modality } })
        return reply.code(201).send(capability)
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          return reply.code(409).send({ error: `model "${model}" is already configured on this connection` })
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
        return reply.code(400).send({ error: `a "${capability.modality}" model cannot be probed without spending on it — one real generation will verify it` })
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
