'use client'

import { FormEvent, useEffect, useState } from 'react'

const api = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4010'

type Project = { id: string; name: string; status: string }

type Episode = { id: string; number: number; title: string; status: string }

async function request<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(`${api}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Request failed')
  return data as T
}

export default function HomePage() {
  const [token, setToken] = useState('')
  const [email, setEmail] = useState('owner@example.com')
  const [password, setPassword] = useState('password123')
  const [organizationName, setOrganizationName] = useState('Demo Studio')
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProject, setSelectedProject] = useState<Project | null>(null)
  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [projectName, setProjectName] = useState('My First Drama')
  const [episodeTitle, setEpisodeTitle] = useState('Episode 1')
  const [message, setMessage] = useState('')

  const loadProjects = async (nextToken: string) => {
    const data = await request<Project[]>('/projects', { headers: { authorization: `Bearer ${nextToken}` } })
    setProjects(data)
  }

  const register = async (event: FormEvent) => {
    event.preventDefault()
    try {
      const data = await request<{ token: string }>('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, organizationName }) })
      setToken(data.token)
      await loadProjects(data.token)
      setMessage('Registered and signed in')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Registration failed') }
  }

  const createProject = async (event: FormEvent) => {
    event.preventDefault()
    try {
      const project = await request<Project>('/projects', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: projectName }) })
      setProjects(current => [project, ...current])
      setMessage('Project created')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Project creation failed') }
  }

  const selectProject = async (project: Project) => {
    setSelectedProject(project)
    const data = await request<Episode[]>(`/projects/${project.id}/episodes`, { headers: { authorization: `Bearer ${token}` } })
    setEpisodes(data)
  }

  const createEpisode = async (event: FormEvent) => {
    event.preventDefault()
    if (!selectedProject) return
    try {
      const episode = await request<Episode>(`/projects/${selectedProject.id}/episodes`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ number: episodes.length + 1, title: episodeTitle }) })
      setEpisodes(current => [...current, episode])
      setMessage('Episode created')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Episode creation failed') }
  }

  useEffect(() => {
    const saved = window.localStorage.getItem('studio-token')
    if (saved) { setToken(saved); loadProjects(saved).catch(() => window.localStorage.removeItem('studio-token')) }
  }, [])

  useEffect(() => { if (token) window.localStorage.setItem('studio-token', token) }, [token])

  if (!token) return (
    <main style={{ maxWidth: 560, margin: '80px auto', padding: 24, fontFamily: 'sans-serif' }}>
      <h1>Short Drama Studio</h1>
      <p>AI short-drama production workspace</p>
      <form onSubmit={register} style={{ display: 'grid', gap: 12 }}>
        <input value={email} onChange={event => setEmail(event.target.value)} placeholder="Email" type="email" />
        <input value={password} onChange={event => setPassword(event.target.value)} placeholder="Password" type="password" />
        <input value={organizationName} onChange={event => setOrganizationName(event.target.value)} placeholder="Organization" />
        <button type="submit">Create workspace</button>
      </form>
      <p>{message}</p>
    </main>
  )

  return (
    <main style={{ maxWidth: 960, margin: '40px auto', padding: 24, fontFamily: 'sans-serif' }}>
      <h1>Short Drama Studio</h1>
      <p>{message || 'Workspace dashboard'}</p>
      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        <div>
          <h2>Projects</h2>
          <form onSubmit={createProject} style={{ display: 'flex', gap: 8 }}><input value={projectName} onChange={event => setProjectName(event.target.value)} /><button type="submit">New project</button></form>
          <ul>{projects.map(project => <li key={project.id}><button onClick={() => selectProject(project)}>{project.name}</button> <small>{project.status}</small></li>)}</ul>
        </div>
        <div>
          <h2>{selectedProject ? selectedProject.name : 'Select a project'}</h2>
          {selectedProject && <><form onSubmit={createEpisode} style={{ display: 'flex', gap: 8 }}><input value={episodeTitle} onChange={event => setEpisodeTitle(event.target.value)} /><button type="submit">New episode</button></form><ul>{episodes.map(episode => <li key={episode.id}>{episode.number}. {episode.title} <small>{episode.status}</small></li>)}</ul></>}
        </div>
      </section>
    </main>
  )
}
