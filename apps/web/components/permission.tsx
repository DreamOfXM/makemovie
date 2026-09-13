'use client'

import { useCallback, type ComponentProps } from 'react'
import { minRoleFor, type Action } from '@studio/domain'
import { useI18n } from '@/lib/i18n'
import { useSession } from '@/lib/session'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function usePermission() {
  const { t } = useI18n()
  const { can } = useSession()
  const denyReason = useCallback(
    (action: Action) => t('rbac.denied', { role: t(`role.${minRoleFor(action)}`) }),
    [t],
  )
  return { can, denyReason }
}

interface GuardedButtonProps extends ComponentProps<typeof Button> {
  action: Action
}

/**
 * Renders a normal button when the current role may perform `action`, otherwise a
 * disabled button wrapped in a tooltip that names the role which unlocks it. The
 * wrapper span is required because disabled buttons emit no pointer events.
 */
export function GuardedButton({ action, children, ...props }: GuardedButtonProps) {
  const { can, denyReason } = usePermission()

  if (can(action)) return <Button {...props}>{children}</Button>

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" tabIndex={0}>
          <Button {...props} disabled>
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{denyReason(action)}</TooltipContent>
    </Tooltip>
  )
}
