import { describe, expect, it } from 'vitest'
import { actions, can, isRole, minRoleFor, roles } from '../src/index.js'

describe('rbac', () => {
  it('owner can do everything', () => {
    for (const action of actions) expect(can('OWNER', action)).toBe(true)
  })

  it('viewer is read-only', () => {
    expect(can('VIEWER', 'read')).toBe(true)
    expect(can('VIEWER', 'project:create')).toBe(false)
    expect(can('VIEWER', 'review:decide')).toBe(false)
    expect(can('VIEWER', 'members:manage')).toBe(false)
  })

  it('reviewer can decide reviews but not edit content', () => {
    expect(can('REVIEWER', 'review:decide')).toBe(true)
    expect(can('REVIEWER', 'storyboard:write')).toBe(false)
    expect(can('REVIEWER', 'providers:manage')).toBe(false)
  })

  it('editor writes content and triggers generation but not administration', () => {
    expect(can('EDITOR', 'project:create')).toBe(true)
    expect(can('EDITOR', 'generation:trigger')).toBe(true)
    expect(can('EDITOR', 'review:decide')).toBe(true)
    expect(can('EDITOR', 'members:manage')).toBe(false)
    expect(can('EDITOR', 'providers:manage')).toBe(false)
    expect(can('EDITOR', 'project:delete')).toBe(false)
  })

  it('admin manages members and providers but the matrix stays total', () => {
    expect(can('ADMIN', 'members:manage')).toBe(true)
    expect(can('ADMIN', 'bindings:manage')).toBe(true)
    expect(can('ADMIN', 'audit:read')).toBe(true)
  })

  it('validates role strings', () => {
    expect(isRole('ADMIN')).toBe(true)
    expect(isRole('SUPERUSER')).toBe(false)
    expect(roles).toHaveLength(5)
  })

  it('names a minimum role that is itself allowed for every action', () => {
    expect(minRoleFor('read')).toBe('VIEWER')
    expect(minRoleFor('review:decide')).toBe('REVIEWER')
    expect(minRoleFor('audit:read')).toBe('ADMIN')
    for (const action of actions) expect(can(minRoleFor(action), action)).toBe(true)
  })
})
