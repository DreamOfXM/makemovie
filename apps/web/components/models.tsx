'use client'

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  capabilitySlots,
  request,
  type Binding,
  type Catalog,
  type Connection,
  type ProbeResult,
  type Project,
  type ResolvedCandidate,
} from '../lib/api'
import { useI18n, type TranslateFn } from '../lib/i18n'

function ProbeBadge({ status, t }: { status: string; t: TranslateFn }) {
  const key = status === 'verified' || status === 'failed' ? status : 'unverified'
  return <span className={`badge badge-${key}`}>{t(`probe.${key}`)}</span>
}

export function ModelsPanel({ token }: { token: string }) {
  const { t } = useI18n()
  const [catalogs, setCatalogs] = useState<Catalog[]>([])
  const [connections, setConnections] = useState<Connection[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const [catalogList, connectionList, projectList] = await Promise.all([
        request<Catalog[]>('/providers/catalogs', { token }),
        request<Connection[]>('/providers/connections', { token }),
        request<Project[]>('/projects', { token }),
      ])
      setCatalogs(catalogList)
      setConnections(connectionList)
      setProjects(projectList)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.generic'))
    }
  }, [token, t])

  useEffect(() => { void load() }, [load])

  return (
    <div className="stack">
      {error && <p className="error">{error}</p>}
      <p className="tagline">{t('models.subtitle')}</p>
      <ConnectionsSection token={token} catalogs={catalogs} connections={connections} onChange={load} onError={setError} />
      <BindingsSection token={token} connections={connections} projects={projects} onError={setError} />
      <CatalogsSection catalogs={catalogs} t={t} />
    </div>
  )
}

function CatalogsSection({ catalogs, t }: { catalogs: Catalog[]; t: TranslateFn }) {
  return (
    <section className="card">
      <h2>{t('models.catalogs')}</h2>
      {catalogs.map(catalog => (
        <details key={catalog.provider} className="catalog">
          <summary>
            {catalog.label} <small>({catalog.provider} · {t('models.catalogVersion')} {catalog.catalogVersion} · {catalog.models.length} {t('models.catalogModels')})</small>
          </summary>
          <table>
            <thead>
              <tr><th>{t('models.model')}</th><th>{t('common.name')}</th><th>{t('models.modality')}</th></tr>
            </thead>
            <tbody>
              {catalog.models.map(model => (
                <tr key={model.model}>
                  <td><code>{model.model}</code></td>
                  <td>{model.displayName}</td>
                  <td><span className="badge badge-modality">{model.modality}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}
    </section>
  )
}

interface SectionProps {
  token: string
  catalogs: Catalog[]
  connections: Connection[]
  onChange(): Promise<void> | void
  onError(message: string): void
}

function ConnectionsSection({ token, catalogs, connections, onChange, onError }: SectionProps) {
  const { t } = useI18n()
  const [showForm, setShowForm] = useState(false)
  const [provider, setProvider] = useState(catalogs[0]?.provider ?? '')
  const [name, setName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [probingId, setProbingId] = useState<string | null>(null)
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult[]>>({})

  useEffect(() => {
    if (!provider && catalogs.length > 0) setProvider(catalogs[0].provider)
  }, [catalogs, provider])

  const defaultBaseUrl = useMemo(
    () => catalogs.find(c => c.provider === provider)?.defaultBaseUrl ?? '',
    [catalogs, provider],
  )

  async function createConnection(event: FormEvent) {
    event.preventDefault()
    try {
      await request('/providers/connections', {
        method: 'POST', token,
        body: JSON.stringify({ provider, name, apiKey, baseUrl: baseUrl || undefined }),
      })
      setName(''); setApiKey(''); setBaseUrl(''); setShowForm(false)
      await onChange()
    } catch (err) {
      onError(err instanceof Error ? err.message : t('error.generic'))
    }
  }

  async function probe(connection: Connection) {
    setProbingId(connection.id)
    try {
      const result = await request<{ results: ProbeResult[] }>(`/providers/connections/${connection.id}/probe`, { method: 'POST', token })
      setProbeResults(current => ({ ...current, [connection.id]: result.results }))
      await onChange()
    } catch (err) {
      onError(err instanceof Error ? err.message : t('error.generic'))
    } finally {
      setProbingId(null)
    }
  }

  async function removeConnection(connection: Connection) {
    if (!window.confirm(t('models.deleteConfirm'))) return
    try {
      await request(`/providers/connections/${connection.id}`, { method: 'DELETE', token })
      await onChange()
    } catch (err) {
      onError(err instanceof Error ? err.message : t('error.generic'))
    }
  }

  return (
    <section className="card">
      <div className="row space-between">
        <h2>{t('models.connections')}</h2>
        <button type="button" onClick={() => setShowForm(show => !show)}>{t('models.newConnection')}</button>
      </div>

      {showForm && (
        <form onSubmit={createConnection} className="form-grid">
          <label>
            {t('models.provider')}
            <select value={provider} onChange={e => setProvider(e.target.value)}>
              {catalogs.map(catalog => <option key={catalog.provider} value={catalog.provider}>{catalog.label}</option>)}
            </select>
          </label>
          <label>
            {t('common.name')}
            <input value={name} onChange={e => setName(e.target.value)} required />
          </label>
          <label>
            {t('models.apiKey')}
            <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} required autoComplete="off" />
          </label>
          <label>
            {t('models.baseUrl')}
            <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder={defaultBaseUrl} />
          </label>
          <div className="row">
            <button type="submit">{t('common.create')}</button>
            <button type="button" className="secondary" onClick={() => setShowForm(false)}>{t('common.cancel')}</button>
          </div>
        </form>
      )}

      {connections.length === 0 && <p>{t('models.noConnections')}</p>}

      {connections.map(connection => (
        <div key={connection.id} className="connection">
          <div className="row space-between">
            <div>
              <strong>{connection.name}</strong>{' '}
              <span className="badge badge-modality">{connection.provider}</span>{' '}
              <small><code>{connection.baseUrl}</code></small>
              {connection.lastError && <p className="error small">{connection.lastError}</p>}
            </div>
            <div className="row">
              <button type="button" onClick={() => void probe(connection)} disabled={probingId === connection.id}>
                {probingId === connection.id ? t('models.probing') : t('models.probe')}
              </button>
              <button type="button" className="danger" onClick={() => void removeConnection(connection)}>{t('common.delete')}</button>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>{t('models.model')}</th>
                <th>{t('models.modality')}</th>
                <th>{t('models.probeStatus')}</th>
                <th>{t('models.lastProbed')}</th>
              </tr>
            </thead>
            <tbody>
              {connection.capabilities.map(capability => {
                const lastResult = probeResults[connection.id]?.find(r => r.capabilityId === capability.id)
                return (
                  <tr key={capability.id}>
                    <td><code>{capability.model}</code>{capability.displayName ? <small> · {capability.displayName}</small> : null}</td>
                    <td><span className="badge badge-modality">{capability.modality}</span></td>
                    <td>
                      <ProbeBadge status={capability.probeStatus} t={t} />
                      {lastResult && !lastResult.ok && lastResult.message && <small className="error"> {lastResult.message}</small>}
                      {capability.probeStatus === 'failed' && !lastResult && capability.probeMessage && <small className="error"> {capability.probeMessage}</small>}
                    </td>
                    <td><small>{capability.lastProbedAt ? new Date(capability.lastProbedAt).toLocaleString() : t('models.neverProbed')}</small></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  )
}

interface BindingsSectionProps {
  token: string
  connections: Connection[]
  projects: Project[]
  onError(message: string): void
}

function BindingsSection({ token, connections, projects, onError }: BindingsSectionProps) {
  const { t } = useI18n()
  const [slot, setSlot] = useState<string>(capabilitySlots[0])
  const [projectId, setProjectId] = useState('')
  const [bindings, setBindings] = useState<Binding[]>([])
  const [capabilityId, setCapabilityId] = useState('')
  const [priority, setPriority] = useState(0)
  const [resolved, setResolved] = useState<ResolvedCandidate[] | null>(null)

  const verifiedCapabilities = useMemo(
    () => connections.flatMap(connection =>
      connection.capabilities
        .filter(capability => capability.entitlementVerifiedAt && connection.enabled)
        .map(capability => ({ capability, connection })),
    ),
    [connections],
  )

  const loadBindings = useCallback(async () => {
    try {
      const query = new URLSearchParams({ slot })
      setBindings(await request<Binding[]>(`/bindings?${query}`, { token }))
      setResolved(null)
    } catch (err) {
      onError(err instanceof Error ? err.message : t('error.generic'))
    }
  }, [slot, token, onError, t])

  useEffect(() => { void loadBindings() }, [loadBindings])

  async function bind(event: FormEvent) {
    event.preventDefault()
    try {
      await request('/bindings', {
        method: 'POST', token,
        body: JSON.stringify({ slot, capabilityId, projectId: projectId || undefined, priority }),
      })
      setCapabilityId('')
      await loadBindings()
    } catch (err) {
      onError(err instanceof Error ? err.message : t('error.generic'))
    }
  }

  async function unbind(binding: Binding) {
    try {
      await request(`/bindings/${binding.id}`, { method: 'DELETE', token })
      await loadBindings()
    } catch (err) {
      onError(err instanceof Error ? err.message : t('error.generic'))
    }
  }

  async function resolve() {
    try {
      const query = new URLSearchParams({ slot })
      if (projectId) query.set('projectId', projectId)
      const data = await request<{ candidates: ResolvedCandidate[] }>(`/bindings/resolve?${query}`, { token })
      setResolved(data.candidates)
    } catch (err) {
      onError(err instanceof Error ? err.message : t('error.generic'))
    }
  }

  const scopedBindings = bindings.filter(binding => (projectId ? binding.projectId === projectId : binding.projectId === null))

  return (
    <section className="card">
      <h2>{t('models.bindings')}</h2>
      <p className="hint">{t('models.bindingsHint')}</p>
      <div className="row">
        <label>
          {t('models.slot')}
          <select value={slot} onChange={e => setSlot(e.target.value)}>
            {capabilitySlots.map(value => <option key={value} value={value}>{t(`slots.${value}`)}</option>)}
          </select>
        </label>
        <label>
          {t('models.project')}
          <select value={projectId} onChange={e => setProjectId(e.target.value)}>
            <option value="">{t('models.scopeOrg')}</option>
            {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
      </div>

      <h3>{t('models.currentBindings')}</h3>
      {scopedBindings.length === 0 && <p>{t('models.noBindings')}</p>}
      <table>
        <tbody>
          {scopedBindings.map(binding => (
            <tr key={binding.id}>
              <td><code>{binding.capability?.model ?? binding.capabilityId}</code></td>
              <td><span className="badge badge-modality">{binding.capability?.modality}</span></td>
              <td><small>{binding.capability?.connection?.name}</small></td>
              <td>{t('models.priority')}: {binding.priority}</td>
              <td>{binding.enabled ? t('common.enabled') : t('common.disabled')}</td>
              <td><button type="button" className="danger" onClick={() => void unbind(binding)}>{t('models.unbind')}</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      <form onSubmit={bind} className="form-grid">
        <label>
          {t('models.capability')}
          <select value={capabilityId} onChange={e => setCapabilityId(e.target.value)} required>
            <option value="" disabled>{verifiedCapabilities.length === 0 ? t('models.noVerifiedCapability') : t('models.capability')}</option>
            {verifiedCapabilities.map(({ capability, connection }) => (
              <option key={capability.id} value={capability.id}>
                {connection.name} · {capability.model} ({capability.modality})
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('models.priority')}
          <input type="number" value={priority} onChange={e => setPriority(Number(e.target.value))} />
        </label>
        <div className="row">
          <button type="submit" disabled={!capabilityId}>{t('models.bind')}</button>
          <button type="button" className="secondary" onClick={() => void resolve()}>{t('models.resolve')}</button>
        </div>
      </form>

      {resolved && (
        <div>
          <h3>{t('models.resolved')}</h3>
          {resolved.length === 0 && <p>{t('models.noCandidates')}</p>}
          <ol>
            {resolved.map((candidate, index) => (
              <li key={candidate.bindingId}>
                {index + 1}. <code>{candidate.model}</code>{' '}
                <small>{candidate.connectionName} · {candidate.scope === 'project' ? t('models.project') : t('models.scopeOrg')} · {t('models.priority')} {candidate.priority}</small>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}
