import type { FastifyInstance } from 'fastify'
import { Prisma } from '@studio/db'
import { createAdapter, getCatalog, isKnownProvider, listCatalogs, type CatalogModel } from '@studio/providers'
import { decryptSecret, encryptSecret } from '@studio/security'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'

interface ConnectionBody {
  provider?: string
  name?: string
  apiKey?: string
  baseUrl?: string
}

export async function providerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/providers/catalogs', { preHandler: requirePermission('read') }, async () => {
    return listCatalogs().map(catalog => ({
      provider: catalog.provider,
      label: catalog.label,
      defaultBaseUrl: catalog.defaultBaseUrl,
      catalogVersion: catalog.catalogVersion,
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
    return connections.map(({ encryptedSecret, ...rest }) => ({ ...rest, apiKeySet: encryptedSecret.length > 0 }))
  })

  app.post<{ Body: ConnectionBody }>('/providers/connections', { preHandler: requirePermission('providers:manage') }, async (request, reply) => {
    const auth = request.auth!
    const provider = request.body?.provider?.trim()
    const name = request.body?.name?.trim()
    const apiKey = request.body?.apiKey
    if (!provider || !isKnownProvider(provider)) return reply.code(400).send({ error: 'provider must be one of the known catalogs' })
    if (!name) return reply.code(400).send({ error: 'name is required' })
    if (!apiKey) return reply.code(400).send({ error: 'apiKey is required' })

    const existing = await app.db.providerConnection.findUnique({ where: { organizationId_name: { organizationId: auth.organizationId, name } } })
    if (existing) return reply.code(409).send({ error: 'a connection with this name already exists' })

    const catalog = getCatalog(provider)!
    const baseUrl = request.body?.baseUrl?.trim() || catalog.defaultBaseUrl
    const connection = await app.db.providerConnection.create({
      data: {
        organizationId: auth.organizationId,
        provider,
        name,
        baseUrl,
        encryptedSecret: encryptSecret(apiKey, app.config.masterKey),
        capabilities: { create: catalog.models.map(toCapabilityData) },
      },
      include: { capabilities: true },
    })
    await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'provider.create', entityType: 'ProviderConnection', entityId: connection.id, payload: { provider, name, models: connection.capabilities.length } })
    return reply.code(201).send({ ...connection, encryptedSecret: undefined, apiKeySet: true })
  })

  app.patch<{ Params: { connectionId: string }; Body: ConnectionBody }>(
    '/providers/connections/:connectionId',
    { preHandler: requirePermission('providers:manage') },
    async (request, reply) => {
      const auth = request.auth!
      const connection = await app.db.providerConnection.findFirst({ where: { id: request.params.connectionId, organizationId: auth.organizationId } })
      if (!connection) return reply.code(404).send({ error: 'connection not found' })

      const data: { name?: string; baseUrl?: string; encryptedSecret?: string } = {}
      if (request.body?.name !== undefined) {
        const name = request.body.name.trim()
        if (!name) return reply.code(400).send({ error: 'name cannot be empty' })
        data.name = name
      }
      if (request.body?.baseUrl !== undefined) {
        const baseUrl = request.body.baseUrl.trim()
        if (!baseUrl) return reply.code(400).send({ error: 'baseUrl cannot be empty' })
        data.baseUrl = baseUrl
      }
      if (request.body?.apiKey) data.encryptedSecret = encryptSecret(request.body.apiKey, app.config.masterKey)

      const updated = await app.db.providerConnection.update({ where: { id: connection.id }, data })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'provider.update', entityType: 'ProviderConnection', entityId: connection.id, payload: { fields: Object.keys(data), keyRotated: data.encryptedSecret !== undefined } })
      return { ...updated, encryptedSecret: undefined }
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
      const adapter = createAdapter(connection.provider, { apiKey, baseUrl: connection.baseUrl })
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
