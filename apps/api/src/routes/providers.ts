import type { FastifyInstance } from 'fastify'
import { Prisma } from '@studio/db'
import { createAdapter, getCatalog, isKnownProvider, listCatalogs, type CatalogModel } from '@studio/providers'
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

export async function providerRoutes(app: FastifyInstance): Promise<void> {
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

    const baseUrl = request.body?.baseUrl?.trim()
    // Only a hand-typed address is checked; every catalog's own default is ours to
    // begin with, and refusing it would make the provider unusable rather than safe.
    if (baseUrl) {
      const checked = checkBaseUrl(provider, baseUrl, app.config.allowPrivateProviderUrls)
      if (!checked.ok) return reply.code(400).send({ error: checked.error })
    }
    const existing = await app.db.providerConnection.findUnique({ where: { organizationId_name: { organizationId: auth.organizationId, name } } })
    if (existing) return reply.code(409).send({ error: 'a connection with this name already exists' })

    const connection = await app.db.providerConnection.create({
      data: {
        organizationId: auth.organizationId,
        provider,
        name,
        baseUrl: baseUrl || catalog.defaultBaseUrl,
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

      const apiKey = decryptSecret(connection.encryptedSecret, app.config.masterKey)
      const accessKey = connection.accessKeyEncrypted ? decryptSecret(connection.accessKeyEncrypted, app.config.masterKey) : undefined
      const adapter = createAdapter(connection.provider, { apiKey, accessKey, baseUrl: connection.baseUrl })
      const results = []
      let anyFailure = false
      for (const capability of connection.capabilities) {
        const result = await adapter.probe({
          provider: connection.provider,
          model: capability.model,
          modality: capability.modality as never,
          acceptsFirstFrame: capability.acceptsFirstFrame,
          acceptsReferenceImages: capability.acceptsReferenceImages,
          maxReferenceImages: capability.maxReferenceImages,
        })
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
