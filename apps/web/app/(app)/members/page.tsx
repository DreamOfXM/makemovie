'use client'

import { useCallback, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { CheckIcon, CircleAlertIcon, CrownIcon, Trash2Icon, UserPlusIcon, UsersIcon } from 'lucide-react'
import { roles, type Role } from '@studio/domain'
import type { Member, MemberSearchHit } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { useAsync } from '@/lib/use-async'
import { formatDateTime, initials } from '@/lib/utils'
import { apiErrorMessage } from '@/lib/api-error'
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
import { Alert, AlertDescription } from '@/components/ui/alert'

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
      toast.error(apiErrorMessage(error, t))
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
      toast.error(apiErrorMessage(error, t))
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
          <CardTitle>{t('members.title')}</CardTitle>
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
                <TableHead pin="left">{t('members.name')}</TableHead>
                <TableHead>{t('members.role')}</TableHead>
                <TableHead>{t('members.joinedAt')}</TableHead>
                <TableHead className="text-right" pin="right">
                  {t('common.actions')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.data.map(member => {
                const roleReason = roleBlockReason(member)
                const removeReason = removeBlockReason(member)
                return (
                  <TableRow key={member.userId}>
                    <TableCell pin="left">
                      <div className="flex items-center gap-3">
                        <span className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
                          {initials(member.email, member.name)}
                        </span>
                        {/* The name cell is sticky-left, so its width is subtracted from
                            the 356px a phone shows before the role select even starts.
                            At 12rem the select was left a 16px sliver; 26vw caps the cell
                            at ~180px on a phone and is inert from 738px up, where 12rem wins. */}
                        <div className="min-w-0 max-w-[min(12rem,26vw)]">
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
                    <TableCell className="text-right" pin="right">
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

/** Candidates paginate inside the dialog so a broad query can never stretch it past the screen. */
const HITS_PER_PAGE = 6

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
  const [checking, setChecking] = useState(false)
  const [userExists, setUserExists] = useState<boolean | null>(null)
  const [existingMembership, setExistingMembership] = useState<{ role: string; joinedAt: string } | null>(null)
  const [hits, setHits] = useState<MemberSearchHit[]>([])
  const [pickedEmail, setPickedEmail] = useState<string | null>(null)
  const [page, setPage] = useState(0)

  /** A picked hit drives the confirm alerts and the eventual add. */
  function applyPick(hit: MemberSearchHit) {
    setPickedEmail(hit.email)
    setEmail(hit.email)
    if (hit.member) setExistingMembership({ role: hit.role ?? '', joinedAt: hit.joinedAt ?? '' })
    else setExistingMembership(null)
  }

  // Search for user by fuzzy email match before showing full dialog
  async function checkUserEmail(query: string = email) {
    if (!query || query.trim().length < 3) return

    setChecking(true)
    setError('')
    setUserExists(null)
    setExistingMembership(null)
    setHits([])
    setPickedEmail(null)
    setPage(0)
    
    try {
      
      // Call the backend fuzzy search endpoint: GET /members?email=xxx
      const searchResults = await api<MemberSearchHit[]>('/members?email=' + encodeURIComponent(query.trim().toLowerCase()))
      
      const fuzzyMatched = (searchResults ?? []).filter(m =>
        m.email.toLowerCase().includes(query.trim().toLowerCase()),
      )

      if (fuzzyMatched.length === 0) {
        setUserExists(false)
      } else {
        // No auto-pick: the user's own click is what fills the email —
        // silently rewriting the box mid-typing reads as hijacking.
        setHits(fuzzyMatched)
        setUserExists(true)
      }
    } catch (err) {
      setError(apiErrorMessage(err, t))
      setUserExists(false)
    } finally {
      setChecking(false)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api('/members', { method: 'POST', body: JSON.stringify({ email: pickedEmail ?? email, role: memberRole }) })
      toast.success(t('members.added', { email, role: t(`role.${memberRole}`) }))
      onDone()
    } catch (err) {
      // Handle common error messages
      const errorMsg = apiErrorMessage(err, t)
      setError(errorMsg)
      
      // If user exists but not in org, show better message
      if (errorMsg.includes('already a member')) {
        setExistingMembership({ role: '', joinedAt: '' })
      } else if (errorMsg.includes('No registered user')) {
        setUserExists(false)
        setExistingMembership(null)
      }
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
          <Field 
            label={t('members.email')} 
            htmlFor="memberEmail" 
            required 
            error={error && !existingMembership ? error : undefined}
            hint={checking ? t('members.searching') : t('members.searchHint')}
          >
            <div className="flex gap-2">
              <Input
                id="memberEmail"
                type="email"
                value={email}
                onChange={async (event) => {
                  setEmail(event.target.value)
                  // Fuzzy search from three characters — a prefix like "wang" is a
                  // legitimate query; picking a hit backfills the full email.
                  if (event.target.value.trim().length >= 3) {
                    await checkUserEmail(event.target.value)
                  } else {
                    setUserExists(null)
                    setExistingMembership(null)
                    setError('')
                  }
                }}
                placeholder={t('members.emailPlaceholder')}
                required
                autoFocus
                autoComplete="off"
                disabled={existingMembership !== null}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => checkUserEmail()}
                disabled={email.trim().length < 3 || checking}
              >
                {checking ? t('common.loading') : t('members.search')}
              </Button>
            </div>
            
            {/* Search Results */}
            {userExists === false && (
              <Alert variant="destructive">
                <CircleAlertIcon className="size-4" />
                <AlertDescription>{t('members.notRegistered')}</AlertDescription>
              </Alert>
            )}

            {existingMembership && (
              <Alert>
                <CheckIcon className="size-4 text-success" />
                <AlertDescription>
                  {t('members.alreadyMember', { role: t(`role.${existingMembership.role || 'VIEWER'}`) })}
                </AlertDescription>
              </Alert>
            )}

            {userExists && !existingMembership && pickedEmail && (
              <Alert>
                <CheckIcon className="size-4 text-success" />
                <AlertDescription>{t('members.found')}</AlertDescription>
              </Alert>
            )}

            {hits.length > 0 && (
              <div role="radiogroup" aria-label={t('members.resultsTitle', { count: hits.length })} className="space-y-1.5">
                <p className="text-xs text-muted-foreground">{t('members.resultsTitle', { count: hits.length })}</p>
                {hits.slice(page * HITS_PER_PAGE, page * HITS_PER_PAGE + HITS_PER_PAGE).map(hit => {
                  const picked = pickedEmail === hit.email
                  return (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={picked}
                      key={hit.userId}
                      disabled={hit.member}
                      onClick={() => applyPick(hit)}
                      className={
                        'flex w-full items-center gap-2.5 rounded-lg border p-2 text-left transition-colors ' +
                        (hit.member
                          ? 'cursor-not-allowed opacity-55'
                          : 'cursor-pointer hover:border-primary/40 ') +
                        (picked ? 'border-primary bg-primary/5 ring-1 ring-primary' : '')
                      }
                    >
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                        {(hit.name ?? hit.email).slice(0, 1).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{hit.email}</span>
                        {hit.name && hit.name !== hit.email && (
                          <span className="block truncate text-xs text-muted-foreground">{hit.name}</span>
                        )}
                      </span>
                      {hit.member ? (
                        <Badge variant="muted">{t('members.inOrg', { role: t(`role.${hit.role ?? 'VIEWER'}`) })}</Badge>
                      ) : picked ? (
                        <CheckIcon className="size-4 shrink-0 text-primary" />
                      ) : null}
                    </button>
                  )
                })}
                {hits.length > HITS_PER_PAGE && (
                  <div className="flex items-center justify-between pt-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={page === 0}
                      onClick={() => setPage(current => Math.max(0, current - 1))}
                    >
                      {t('members.prevPage')}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {t('members.pageInfo', { page: page + 1, pages: Math.ceil(hits.length / HITS_PER_PAGE) })}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={(page + 1) * HITS_PER_PAGE >= hits.length}
                      onClick={() => setPage(current => current + 1)}
                    >
                      {t('members.nextPage')}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </Field>

          {!existingMembership && (
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
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy || !pickedEmail || existingMembership !== null}>
              {busy ? t('common.saving') : t('members.add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
