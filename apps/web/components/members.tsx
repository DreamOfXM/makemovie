'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { request, type Member, type MeResponse } from '../lib/api'
import { useI18n } from '../lib/i18n'

const assignableRoles = ['ADMIN', 'EDITOR', 'REVIEWER', 'VIEWER']

export function MembersPanel({ token }: { token: string }) {
  const { t } = useI18n()
  const [members, setMembers] = useState<Member[]>([])
  const [me, setMe] = useState<MeResponse | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('EDITOR')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const [memberList, meResponse] = await Promise.all([
        request<Member[]>('/members', { token }),
        request<MeResponse>('/auth/me', { token }),
      ])
      setMembers(memberList)
      setMe(meResponse)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.generic'))
    }
  }, [token, t])

  useEffect(() => { void load() }, [load])

  const canManage = me !== null && (me.organization.role === 'OWNER' || me.organization.role === 'ADMIN')

  async function addMember(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      await request('/members', { method: 'POST', token, body: JSON.stringify({ email, role }) })
      setEmail('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.generic'))
    }
  }

  async function changeRole(member: Member, nextRole: string) {
    setError('')
    try {
      await request(`/members/${member.userId}`, { method: 'PATCH', token, body: JSON.stringify({ role: nextRole }) })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.generic'))
    }
  }

  async function removeMember(member: Member) {
    if (!window.confirm(t('members.removeConfirm'))) return
    setError('')
    try {
      await request(`/members/${member.userId}`, { method: 'DELETE', token })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.generic'))
    }
  }

  return (
    <section className="card">
      <h2>{t('members.title')}</h2>
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>{t('members.email')}</th>
            <th>{t('members.role')}</th>
            <th>{t('common.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {members.map(member => {
            const isSelf = member.userId === me?.user.id
            return (
              <tr key={member.userId}>
                <td>
                  {member.email}
                  {isSelf && <small> ({t('members.you')})</small>}
                </td>
                <td>
                  {canManage && member.role !== 'OWNER' && !isSelf ? (
                    <select value={member.role} onChange={e => void changeRole(member, e.target.value)}>
                      {assignableRoles.map(value => <option key={value} value={value}>{value}</option>)}
                    </select>
                  ) : (
                    <span className="badge badge-modality">{member.role}</span>
                  )}
                </td>
                <td>
                  {canManage && member.role !== 'OWNER' && !isSelf && (
                    <button type="button" className="danger" onClick={() => void removeMember(member)}>{t('members.remove')}</button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {canManage && (
        <form onSubmit={addMember} className="form-grid">
          <label>
            {t('members.email')}
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required />
          </label>
          <label>
            {t('members.role')}
            <select value={role} onChange={e => setRole(e.target.value)}>
              {assignableRoles.map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <div className="row">
            <button type="submit">{t('members.add')}</button>
          </div>
          <p className="hint">{t('members.addHint')}</p>
        </form>
      )}
    </section>
  )
}
