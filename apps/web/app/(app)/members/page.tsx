'use client'

import { useCallback, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { CrownIcon, Trash2Icon, UserPlusIcon, UsersIcon } from 'lucide-react'
import { roles, type Role } from '@studio/domain'
import type { Member } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { formatDateTime, initials } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TableSkeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ErrorState } from '@/components/error-state'
import { GuardedButton, usePermission } from '@/components/permission'

/** The API refuses OWNER as a target role — ownership is granted at registration. */
const assignableRoles = roles.filter(role => role !== 'OWNER')

export default function MembersPage() {
  const { t, locale } = useI18n()
  const { api, me, role, organizationId } = useSession()
  const { can, denyReason } = usePermission()

  const loadMembers = useCallback(() => api<Member[]>('/members'), [api, organizationId])
  const members = useAsync<Member[]>(loadMembers, [])

  const [addOpen, setAddOpen] = useState(false)
  const [addKey, setAddKey] = useState(0)
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null)
  const [removing, setRemoving] = useState(false)
  const [changingId, setChangingId] = useState<string | null>(null)

  async function changeRole(member: Member, next: Role) {
    setChangingId(member.userId)
    try {
      await api(`/members/${member.userId}`, { method: 'PATCH', body: JSON.stringify({ role: next }) })
      members.mutate(current => current.map(item => (item.userId === member.userId ? { ...item, role: next } : item)))
      toast.success(t('members.roleChanged', { email: member.email, role: t(`role.${next}`) }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      setChangingId(null)
    }
  }

  async function removeMember(member: Member) {
    setRemoving(true)
    try {
      await api(`/members/${member.userId}`, { method: 'DELETE' })
      toast.success(t('members.removed', { email: member.email }))
      setRemoveTarget(null)
      members.reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error.generic'))
    } finally {
      setRemoving(false)
    }
  }

  /** Mirrors the API rules: nobody edits their own role, and only an owner touches an owner. */
  function roleBlockReason(member: Member): string | null {
    if (!can('members:manage')) return denyReason('members:manage')
    if (member.userId === me?.user.id) return t('members.selfRoleHint')
    if (member.role === 'OWNER' && role !== 'OWNER') return t('members.ownerProtected')
    return null
  }

  function removeBlockReason(member: Member): string | null {
    if (!can('members:manage')) return denyReason('members:manage')
    if (member.userId === me?.user.id) return t('members.selfRoleHint')
    if (member.role === 'OWNER') return t('members.ownerProtected')
    return null
  }

  return (
    <>
      <PageHeader
        title={t('members.title')}
        description={t('members.subtitle')}
        actions={
          <GuardedButton
            action="members:manage"
            onClick={() => {
              setAddKey(key => key + 1)
              setAddOpen(true)
            }}
          >
            <UserPlusIcon />
            {t('members.add')}
          </GuardedButton>
        }
      />

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="text-sm">{t('members.title')}</CardTitle>
          <CardDescription>{t('members.count', { count: members.data.length })}</CardDescription>
        </CardHeader>

        {members.error ? (
          <div className="px-6">
            <ErrorState message={members.error} onRetry={members.reload} />
          </div>
        ) : members.loading && members.data.length === 0 ? (
          <TableSkeleton rows={4} columns={4} />
        ) : members.data.length === 0 ? (
          <div className="px-6">
            <EmptyState icon={<UsersIcon />} title={t('members.noMembers')} />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('members.name')}</TableHead>
                <TableHead>{t('members.role')}</TableHead>
                <TableHead>{t('members.joinedAt')}</TableHead>
                <TableHead className="text-right">{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.data.map(member => {
                const roleReason = roleBlockReason(member)
                const removeReason = removeBlockReason(member)
                return (
                  <TableRow key={member.userId}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <span className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
                          {initials(member.email, member.name)}
                        </span>
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-2 font-medium">
                            <span className="truncate">{member.name ?? member.email}</span>
                            {member.userId === me?.user.id && <Badge variant="muted">{t('members.you')}</Badge>}
                          </p>
                          {member.name && (
                            <p className="text-muted-foreground truncate text-xs">{member.email}</p>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {member.role === 'OWNER' ? (
                        <Badge variant="tinted" className="gap-1">
                          <CrownIcon />
                          {t('role.OWNER')}
                        </Badge>
                      ) : roleReason ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex" tabIndex={0}>
                              <RoleSelect value={member.role} disabled />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>{roleReason}</TooltipContent>
                        </Tooltip>
                      ) : (
                        <RoleSelect
                          value={member.role}
                          disabled={changingId === member.userId}
                          onValueChange={value => changeRole(member, value as Role)}
                        />
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {formatDateTime(member.joinedAt, locale)}
                    </TableCell>
                    <TableCell className="text-right">
                      {removeReason ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex" tabIndex={0}>
                              <Button variant="ghost" size="icon-sm" disabled aria-label={t('members.remove')}>
                                <Trash2Icon />
                              </Button>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>{removeReason}</TooltipContent>
                        </Tooltip>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-destructive hover:text-destructive"
                          aria-label={t('members.remove')}
                          onClick={() => setRemoveTarget(member)}
                        >
                          <Trash2Icon />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      <AddMemberDialog
        key={addKey}
        open={addOpen}
        onOpenChange={setAddOpen}
        onDone={() => {
          setAddOpen(false)
          members.reload()
        }}
      />

      <AlertDialog open={removeTarget !== null} onOpenChange={open => !removing && !open && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('members.removeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget && t('members.removeBody', { email: removeTarget.email })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={removing}
              onClick={event => {
                event.preventDefault()
                if (removeTarget) void removeMember(removeTarget)
              }}
            >
              {removing ? t('common.loading') : t('members.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

interface RoleSelectProps {
  value: Role
  disabled?: boolean
  onValueChange?(value: string): void
}

function RoleSelect({ value, disabled, onValueChange }: RoleSelectProps) {
  const { t } = useI18n()
  return (
    <Select value={value} disabled={disabled} onValueChange={onValueChange}>
      <SelectTrigger size="sm" className="w-36" aria-label={t('members.role')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {assignableRoles.map(item => (
          <SelectItem key={item} value={item}>
            {t(`role.${item}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

interface AddMemberDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  onDone(): void
}

function AddMemberDialog({ open, onOpenChange, onDone }: AddMemberDialogProps) {
  const { t } = useI18n()
  const { api } = useSession()
  const [email, setEmail] = useState('')
  const [memberRole, setMemberRole] = useState<Role>('EDITOR')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api('/members', { method: 'POST', body: JSON.stringify({ email, role: memberRole }) })
      toast.success(t('members.added', { email, role: t(`role.${memberRole}`) }))
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.generic'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={next => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('members.addTitle')}</DialogTitle>
          <DialogDescription>{t('members.addHint')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field label={t('members.email')} htmlFor="memberEmail" required error={error}>
            <Input
              id="memberEmail"
              type="email"
              value={email}
              onChange={event => setEmail(event.target.value)}
              placeholder={t('members.emailPlaceholder')}
              required
              autoFocus
              autoComplete="off"
            />
          </Field>

          <Field label={t('members.role')} htmlFor="memberRole" hint={t(`role.${memberRole}.hint`)}>
            <Select value={memberRole} onValueChange={value => setMemberRole(value as Role)}>
              <SelectTrigger id="memberRole" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {assignableRoles.map(item => (
                  <SelectItem key={item} value={item}>
                    {t(`role.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy || !email.trim()}>
              {busy ? t('common.saving') : t('members.add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
