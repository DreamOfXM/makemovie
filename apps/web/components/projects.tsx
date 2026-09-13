'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { request, type Episode, type Project } from '../lib/api'
import { useI18n } from '../lib/i18n'

export function ProjectsPanel({ token }: { token: string }) {
  const { t } = useI18n()
  const [projects, setProjects] = useState<Project[]>([])
  const [selected, setSelected] = useState<Project | null>(null)
  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [projectName, setProjectName] = useState('')
  const [episodeTitle, setEpisodeTitle] = useState('')
  const [error, setError] = useState('')

  const loadProjects = useCallback(async () => {
    try {
      setProjects(await request<Project[]>('/projects', { token }))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.generic'))
    }
  }, [token, t])

  useEffect(() => { void loadProjects() }, [loadProjects])

  async function selectProject(project: Project) {
    setSelected(project)
    setError('')
    try {
      setEpisodes(await request<Episode[]>(`/projects/${project.id}/episodes`, { token }))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.generic'))
    }
  }

  async function createProject(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      const project = await request<Project>('/projects', { method: 'POST', token, body: JSON.stringify({ name: projectName }) })
      setProjects(current => [project, ...current])
      setProjectName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.generic'))
    }
  }

  async function createEpisode(event: FormEvent) {
    event.preventDefault()
    if (!selected) return
    setError('')
    try {
      const episode = await request<Episode>(`/projects/${selected.id}/episodes`, {
        method: 'POST', token,
        body: JSON.stringify({ number: episodes.length + 1, title: episodeTitle }),
      })
      setEpisodes(current => [...current, episode])
      setEpisodeTitle('')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.generic'))
    }
  }

  return (
    <div className="columns">
      <section className="card">
        <h2>{t('projects.title')}</h2>
        <form onSubmit={createProject} className="row">
          <input value={projectName} onChange={e => setProjectName(e.target.value)} placeholder={t('projects.namePlaceholder')} required />
          <button type="submit">{t('projects.new')}</button>
        </form>
        <ul className="list">
          {projects.map(project => (
            <li key={project.id}>
              <button className={`list-item${selected?.id === project.id ? ' active' : ''}`} onClick={() => void selectProject(project)}>
                {project.name}
              </button>
              <small>{project.status}</small>
            </li>
          ))}
        </ul>
      </section>
      <section className="card">
        <h2>{selected ? selected.name : t('projects.selectHint')}</h2>
        {selected && (
          <>
            <form onSubmit={createEpisode} className="row">
              <input value={episodeTitle} onChange={e => setEpisodeTitle(e.target.value)} placeholder={t('projects.episodeTitlePlaceholder')} required />
              <button type="submit">{t('projects.newEpisode')}</button>
            </form>
            <ul className="list">
              {episodes.map(episode => (
                <li key={episode.id}>{episode.number}. {episode.title} <small>{episode.status}</small></li>
              ))}
            </ul>
          </>
        )}
      </section>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
